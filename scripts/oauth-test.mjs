/**
 * Walks through the OAuth flow a connector (e.g. claude.ai) uses: discovery from a
 * 401, dynamic registration, the approval page, PKCE code exchange, calling MCP
 * with the access token, refresh, and revocation.
 * Usage: start a server with LIVECUT_TOKEN and PUBLIC_URL, then
 *   LIVECUT_URL=http://localhost:4405 LIVECUT_TOKEN=... node scripts/oauth-test.mjs
 */
import { createHash, randomBytes } from 'node:crypto';

const BASE = process.env.LIVECUT_URL ?? 'http://localhost:4405';
const SECRET = process.env.LIVECUT_TOKEN;
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`); };
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'oauth-test', version: '0' } } };
const mcp = (token) => fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(init) });

try {
  /* discovery */
  const r401 = await mcp();
  const www = r401.headers.get('www-authenticate') ?? '';
  check('MCP without a token is refused and points to OAuth metadata', r401.status === 401 && /resource_metadata=/.test(www));
  const prm = await (await fetch(/resource_metadata="([^"]+)"/.exec(www)[1])).json();
  const asMeta = await (await fetch(`${prm.authorization_servers[0].replace(/\/$/, '')}/.well-known/oauth-authorization-server`)).json();
  check('protected resource + authorization server metadata', !!asMeta.authorization_endpoint && !!asMeta.registration_endpoint && asMeta.code_challenge_methods_supported?.includes('S256'));

  /* dynamic client registration */
  const redirect = 'https://example.com/callback';
  const reg = await (await fetch(asMeta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test Connector', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })).json();
  check('dynamic client registration', !!reg.client_id, reg.client_id);

  /* authorize: approval page */
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authUrl = new URL(asMeta.authorization_endpoint);
  Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: prm.resource }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
  const page = await fetch(authUrl, { redirect: 'manual' });
  const html = await page.text();
  check('approval page asks for the LiveCut token', page.status === 200 && /Connect Test Connector to LiveCut/.test(html) && /type="password"/.test(html));
  const request = /name="request" value="([^"]+)"/.exec(html)[1];
  const approve = (secret, decision = 'allow') => fetch(`${BASE}/oauth/approve`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ request, secret, decision }) });
  const wrong = await approve('nope');
  check('a wrong token is refused', wrong.status === 403);
  const ok = await approve(SECRET);
  const loc = new URL(ok.headers.get('location'));
  check('approval redirects back with a code and state', ok.status === 302 && loc.origin + loc.pathname === redirect && !!loc.searchParams.get('code') && loc.searchParams.get('state') === 'xyz');

  /* token exchange with PKCE */
  const tok = (body) => fetch(asMeta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const badPkce = await tok({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), client_id: reg.client_id, redirect_uri: redirect, code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier-123' });
  check('a wrong PKCE verifier is refused', badPkce.status === 400);
  // The bad attempt did not consume the code (PKCE is checked first), so the right verifier still works once.
  const t1 = await (await tok({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier, resource: prm.resource })).json();
  check('code exchange gives access + refresh tokens', !!t1.access_token && !!t1.refresh_token, `expires in ${t1.expires_in}s`);
  const reuse = await tok({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier });
  check('a code works only once', reuse.status === 400);

  /* use it */
  const m1 = await mcp(t1.access_token);
  check('MCP accepts the OAuth access token', m1.status === 200 && !!m1.headers.get('mcp-session-id'));
  const m2 = await mcp(SECRET);
  check('the static token still works for Claude Code', m2.status === 200);
  check('the editor still needs the static token', (await fetch(`${BASE}/api/state`, { headers: { authorization: `Bearer ${t1.access_token}` } })).status === 401);

  /* refresh and revoke */
  const t2 = await (await tok({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: reg.client_id })).json();
  check('refresh gives a new access token', !!t2.access_token && t2.access_token !== t1.access_token);
  const oldRefresh = await tok({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: reg.client_id });
  check('refresh tokens rotate (old one is refused)', oldRefresh.status === 400);
  await fetch(asMeta.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t2.access_token, client_id: reg.client_id }) });
  check('a revoked token is refused', (await mcp(t2.access_token)).status === 401);
} catch (e) {
  check('test run', false, e.stack);
}
const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

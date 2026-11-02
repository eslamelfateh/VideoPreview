import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { DATA_DIR } from './store.js';

/**
 * A small OAuth 2.1 server so apps like claude.ai can connect LiveCut as a custom
 * connector: dynamic client registration, PKCE, refresh tokens. Whoever approves
 * the connection must type the server's LIVECUT_TOKEN, so only the owner can.
 */
const FILE = path.join(DATA_DIR, 'oauth.json');
const ACCESS_TTL = 24 * 3600, REFRESH_TTL = 90 * 24 * 3600, CODE_TTL = 600;

interface Grant { clientId: string; scopes: string[]; resource?: string; expiresAt: number }
interface Code extends Grant { challenge: string; redirectUri: string }
interface Pending { client: OAuthClientInformationFull; params: AuthorizationParams; expiresAt: number }

const now = () => Math.floor(Date.now() / 1000);
const token = () => randomBytes(32).toString('base64url');
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export class LiveCutOAuth implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private codes = new Map<string, Code>();
  private access = new Map<string, Grant>();
  private refresh = new Map<string, Grant>();
  private pending = new Map<string, Pending>();

  constructor(private secret: string) {
    try {
      const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      this.clients = new Map(s.clients); this.access = new Map(s.access); this.refresh = new Map(s.refresh);
    } catch { /* first run */ }
  }
  private save() {
    const t = now();
    for (const m of [this.access, this.refresh]) for (const [k, g] of m) if (g.expiresAt < t) m.delete(k);
    fs.writeFileSync(FILE, JSON.stringify({ clients: [...this.clients], access: [...this.access], refresh: [...this.refresh] }), { mode: 0o600 });
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: id => this.clients.get(id),
      registerClient: c => {
        const full = { ...c, client_id: `lc_${token().slice(0, 16)}`, client_id_issued_at: now() } as OAuthClientInformationFull;
        this.clients.set(full.client_id, full);
        this.save();
        return full;
      },
    };
  }

  /** Shows the approval page. The form posts to /oauth/approve with a one-time request id. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const id = token();
    this.pending.set(id, { client, params, expiresAt: now() + CODE_TTL });
    const name = esc(client.client_name ?? client.client_id);
    const host = esc(new URL(params.redirectUri).host);
    res.status(200).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to LiveCut</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#121212;color:#ecebe7;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
form{max-width:380px;width:100%;background:#1b1b1b;border:1px solid #303030;border-radius:14px;padding:22px;display:grid;gap:12px}
h1{font-size:18px;margin:0}p{margin:0;color:#9a9893}input{font:inherit;padding:9px 11px;border-radius:8px;border:1px solid #303030;background:#161616;color:#ecebe7}
.row{display:flex;gap:8px}button{flex:1;font:inherit;padding:9px;border-radius:8px;border:1px solid #303030;background:#242424;color:#ecebe7;cursor:pointer}button.ok{background:#ecebe7;color:#121212;font-weight:600}</style>
<form method="post" action="/oauth/approve"><h1>Connect ${name} to LiveCut?</h1>
<p>It will be able to edit your videos and download exports. It returns to <b>${host}</b>.</p>
<label>LiveCut access token<br><input type="password" name="secret" autocomplete="current-password" required autofocus></label>
<input type="hidden" name="request" value="${id}">
<div class="row"><button name="decision" value="deny">Deny</button><button class="ok" name="decision" value="allow">Allow</button></div></form>`);
  }

  /** Handles the approval form. */
  approve(body: { request?: string; secret?: string; decision?: string }, res: Response) {
    const p = body.request ? this.pending.get(body.request) : undefined;
    if (!p || p.expiresAt < now()) { res.status(400).type('text').send('This request expired. Start connecting again from your app.'); return; }
    const back = new URL(p.params.redirectUri);
    if (p.params.state) back.searchParams.set('state', p.params.state);
    if (body.decision !== 'allow') {
      this.pending.delete(body.request!);
      back.searchParams.set('error', 'access_denied');
      res.redirect(back.href); return;
    }
    const s = String(body.secret ?? '');
    if (s.length !== this.secret.length || !timingSafeEqual(Buffer.from(s), Buffer.from(this.secret))) { res.status(403).type('text').send('Wrong token. Go back and try again.'); return; }
    this.pending.delete(body.request!);
    const code = token();
    this.codes.set(code, { clientId: p.client.client_id, scopes: p.params.scopes ?? [], resource: p.params.resource?.href, challenge: p.params.codeChallenge, redirectUri: p.params.redirectUri, expiresAt: now() + CODE_TTL });
    back.searchParams.set('code', code);
    res.redirect(back.href);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const c = this.codes.get(code);
    if (!c || c.clientId !== client.client_id) throw new InvalidGrantError('Unknown authorization code');
    return c.challenge;
  }

  private issue(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const a = token(), r = token();
    this.access.set(a, { clientId, scopes, resource, expiresAt: now() + ACCESS_TTL });
    this.refresh.set(r, { clientId, scopes, resource, expiresAt: now() + REFRESH_TTL });
    this.save();
    return { access_token: a, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: r, scope: scopes.join(' ') || undefined };
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const c = this.codes.get(code);
    this.codes.delete(code);
    if (!c || c.clientId !== client.client_id || c.expiresAt < now()) throw new InvalidGrantError('Invalid or expired authorization code');
    if (redirectUri && redirectUri !== c.redirectUri) throw new InvalidGrantError('redirect_uri does not match');
    return this.issue(c.clientId, c.scopes, c.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const g = this.refresh.get(refreshToken);
    if (!g || g.clientId !== client.client_id || g.expiresAt < now()) throw new InvalidGrantError('Invalid or expired refresh token');
    this.refresh.delete(refreshToken);
    return this.issue(g.clientId, scopes?.length ? scopes : g.scopes, g.resource);
  }

  async verifyAccessToken(t: string): Promise<AuthInfo> {
    const g = this.access.get(t);
    if (!g || g.expiresAt < now()) throw new InvalidTokenError('Invalid or expired token');
    return { token: t, clientId: g.clientId, scopes: g.scopes, expiresAt: g.expiresAt, resource: g.resource ? new URL(g.resource) : undefined };
  }

  async revokeToken(_client: OAuthClientInformationFull, req: { token: string }) {
    this.access.delete(req.token); this.refresh.delete(req.token); this.save();
  }
}

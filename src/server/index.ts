import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { WebSocketServer, type WebSocket } from 'ws';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { trackEnd } from '../shared/timeline.js';
import { analyze } from './assets.js';
import { createMcpServer, type McpSession } from './mcp.js';
import { LiveCutOAuth } from './oauth.js';
import { USER_OPS } from './ops.js';
import { importFile } from './media.js';
import { FONTS_DIR, measureLoudness, startRender } from './render.js';
import { setLoudness } from './ops.js';
import { EXPORT_DIR, MEDIA_DIR, newId, store } from './store.js';

const PORT = Number(process.env.PORT ?? 4317);
const HOST = process.env.HOST ?? '127.0.0.1';
const TOKEN = process.env.LIVECUT_TOKEN ?? '';
const WEB_DIR = path.resolve(fileURLToPath(import.meta.url), '../../../dist/web');

if (!TOKEN && HOST !== '127.0.0.1' && HOST !== 'localhost') {
  if (process.env.LIVECUT_ALLOW_OPEN !== '1') {
    console.error('\nRefusing to listen on the network without LIVECUT_TOKEN: anyone could edit and download your media.\nSet LIVECUT_TOKEN to a long random string (e.g. `openssl rand -hex 24`), or LIVECUT_ALLOW_OPEN=1 if you really want an open server.\n');
    process.exit(1);
  }
  console.warn('\n⚠  LIVECUT_TOKEN is not set and the server is reachable from the network.\n');
}

/* ---------- auth: bearer header (agents), cookie (browser), or ?token= once to set the cookie ---------- */

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function tokenOf(req: http.IncomingMessage): string {
  const h = req.headers.authorization ?? '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  const c = /(?:^|;\s*)livecut_token=([^;]+)/.exec(req.headers.cookie ?? '');
  if (c) return decodeURIComponent(c[1]);
  return new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? '';
}
const authorized = (req: http.IncomingMessage) => !TOKEN || same(tokenOf(req), TOKEN);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

/* ---------- OAuth (for apps like claude.ai custom connectors), when a token and public URL are set ---------- */

const PUBLIC = process.env.PUBLIC_URL?.replace(/\/$/, '');
const oauthOk = !!TOKEN && !!PUBLIC && (PUBLIC.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(PUBLIC));
const oauth = oauthOk ? new LiveCutOAuth(TOKEN) : null;
const mcpUrl = new URL('/mcp', PUBLIC ?? `http://localhost:${PORT}`);
if (oauth) {
  app.use(mcpAuthRouter({ provider: oauth, issuerUrl: new URL(PUBLIC!), resourceServerUrl: mcpUrl, resourceName: 'LiveCut' }));
  app.post('/oauth/approve', express.urlencoded({ extended: false }), (req, res) => oauth.approve(req.body ?? {}, res));
} else if (TOKEN && PUBLIC) console.warn('OAuth is off: PUBLIC_URL must be https:// (or localhost) for apps like claude.ai to connect.');
const OPEN_PATHS = /^\/(\.well-known\/|authorize$|token$|register$|revoke$|oauth\/)/;

/** MCP accepts the static token or an OAuth access token; a 401 points clients at the OAuth metadata. */
async function mcpAuth(req: Request, res: Response, next: NextFunction) {
  if (!TOKEN) return next();
  const t = (req.headers.authorization ?? '').startsWith('Bearer ') ? req.headers.authorization!.slice(7) : '';
  if (t && same(t, TOKEN)) return next();
  if (t && oauth) { try { await oauth.verifyAccessToken(t); return next(); } catch { /* fall through */ } }
  if (oauth) res.set('WWW-Authenticate', `Bearer error="invalid_token", resource_metadata="${getOAuthProtectedResourceMetadataUrl(mcpUrl)}"`);
  res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
}

app.use((req: Request, res: Response, next: NextFunction) => {
  if (OPEN_PATHS.test(req.path) || req.path === '/mcp') return next();
  const q = typeof req.query.token === 'string' ? req.query.token : '';
  if (TOKEN && q && same(q, TOKEN) && req.method === 'GET' && !req.path.startsWith('/api')) {
    res.cookie('livecut_token', q, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 24 * 3600_000 });
    return res.redirect(req.path);
  }
  if (!authorized(req)) {
    if (req.path === '/' || req.path.endsWith('.html')) return res.status(401).type('text').send('LiveCut: open this page with ?token=YOUR_TOKEN once.');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

/* ---------- MCP: streamable HTTP with sessions, so the server can notify subscribers ---------- */

interface Session { transport: StreamableHTTPServerTransport; server: McpServer; info: McpSession; last: number }
const sessions = new Map<string, Session>();
const sessionOf = (req: Request) => { const id = req.headers['mcp-session-id']; return typeof id === 'string' ? sessions.get(id) : undefined; };
const rpcError = (res: Response, status: number, message: string) => res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

app.post('/mcp', express.json({ limit: '20mb' }), mcpAuth, async (req, res) => {
  store.lastAgentSeen = Date.now();
  try {
    const existing = sessionOf(req);
    if (existing) { existing.last = Date.now(); await existing.transport.handleRequest(req, res, req.body); return; }
    if (req.headers['mcp-session-id']) return rpcError(res, 404, 'Session not found. Start a new session.');
    if (!isInitializeRequest(req.body)) return rpcError(res, 400, 'Send initialize first.');
    const info: McpSession = { subscriptions: new Set() };
    const server = createMcpServer(info);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: id => { sessions.set(id, { transport, server, info, last: Date.now() }); },
    });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) rpcError(res, 500, 'Internal error');
  }
});
const sessionRequest = async (req: Request, res: Response) => {
  const s = sessionOf(req);
  if (!s) return rpcError(res, 404, 'Session not found.');
  s.last = Date.now();
  await s.transport.handleRequest(req, res);
};
app.get('/mcp', mcpAuth, sessionRequest);
app.delete('/mcp', mcpAuth, sessionRequest);

// Close sessions idle for two hours.
setInterval(() => { for (const s of sessions.values()) if (Date.now() - s.last > 2 * 3600_000) s.transport.close(); }, 10 * 60_000).unref();

// Tell subscribed agents when the project, the user's notes, or the history change.
let seen = { project: store.project, notes: JSON.stringify(store.project.markers), steps: 0 };
let notifyTimer: NodeJS.Timeout | null = null;
store.subscribe(() => {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    const changed: string[] = [];
    if (store.project !== seen.project) changed.push('livecut://project');
    const notes = JSON.stringify(store.project.markers);
    if (notes !== seen.notes) changed.push('livecut://notes');
    const steps = store.steps.length * 1e6 + store.steps.filter(x => x.undone).length;
    if (steps !== seen.steps) changed.push('livecut://history');
    if (store.project.transcripts !== seen.project.transcripts) changed.push('livecut://transcript');
    seen = { project: store.project, notes, steps };
    for (const s of sessions.values()) for (const uri of changed) if (s.info.subscriptions.has(uri)) s.server.server.sendResourceUpdated({ uri }).catch(() => {});
  }, 250);
});

/* ---------- editor API ---------- */

const api = express.Router();
api.use(express.json());
const handle = (fn: (req: Request) => unknown) => async (req: Request, res: Response) => {
  try { const r = await fn(req); res.json(r ?? { ok: true }); }
  catch (e: any) { res.status(400).json({ error: e?.message ?? String(e) }); }
};

api.get('/state', handle(() => store.snapshot()));
api.post('/control', handle(req => {
  const { mode, paused } = req.body ?? {};
  store.setControl({ ...(mode === 'live' || mode === 'step' ? { mode } : {}), ...(typeof paused === 'boolean' ? { paused } : {}) });
}));
api.post('/undo-last', handle(() => {
  const last = [...store.steps].reverse().find(s => !s.undone && s.status === 'done' && s.changes.length);
  if (!last) throw new Error('Nothing to undo.');
  store.toggleUndo(last.id);
  return { undone: last.n };
}));
api.post('/steps/:id/undo', handle(req => store.toggleUndo(String(req.params.id))));
api.post('/steps/:id/decision', handle(req => store.decide(String(req.params.id), { approve: !!req.body?.approve, note: String(req.body?.note ?? '').trim() || undefined })));
api.post('/notes', handle(req => {
  const t = String(req.body?.text ?? '').trim().slice(0, 2000);
  if (!t) throw new Error('Write a message first.');
  store.addNote(t);
}));
api.post('/edit', handle(async req => {
  const { op, args } = req.body ?? {};
  const fn = USER_OPS[String(op)];
  if (!fn) throw new Error(`Unknown edit: ${op}`);
  return { summary: await store.edit(String(op), args ?? {}, d => fn(d, args ?? {}), 'user') };
}));
api.post('/export', handle(req => { startRender(req.body?.quality === 'draft' ? 'draft' : 'final').catch(() => { /* state carries the error */ }); return { started: true }; }));
api.post('/audio/normalize', handle(async req => {
  const measured = Math.round((await measureLoudness(store.project)) * 10) / 10;
  const target = Number(req.body?.target ?? -14);
  return { summary: await store.edit('normalize_loudness', { target }, d => setLoudness(d, { target, measured }), 'user') };
}));
api.post('/questions/:id/answer', handle(req => {
  const a = String(req.body?.answer ?? '').trim();
  if (!a) throw new Error('Write an answer first.');
  store.answer(String(req.params.id), a.slice(0, 2000));
}));
api.post('/reset', handle(() => store.reset()));

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 4 * 1024 ** 3 } });
api.post('/media', upload.array('files', 20), handle(async req => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) throw new Error('No files received.');
  for (const f of files) {
    const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
    const m = await importFile(f.path, name, true).catch(e => { fs.rmSync(f.path, { force: true }); throw new Error(`${name}: ${e.message}`); });
    await store.edit('upload', { name: m.name }, d => {
      const first = !d.media.some(x => x.kind === 'video');
      d.media.push(m);
      if (first && m.kind === 'video' && m.width && m.height) {
        // Match the canvas to the first video: vertical stays 1080x1920, landscape becomes 1920x1080.
        if (m.width > m.height) { d.width = 1920; d.height = 1080; } else if (m.width === m.height) { d.width = 1080; d.height = 1080; } else { d.width = 1080; d.height = 1920; }
      }
      const track = m.kind === 'audio' ? 'audio' : 'video';
      const start = trackEnd(d, track);
      d.clips.push({ id: newId('clip'), track, mediaId: m.id, start, in: 0, out: m.duration, volume: 1 });
      return { summary: `Uploaded ${m.name} and placed it on the ${track} track`, at: start };
    }, 'user');
    analyze(m);
  }
}));
app.use('/api', api);

/* ---------- files ---------- */

const files = { maxAge: '1h', fallthrough: false } as const;
app.use('/media', express.static(MEDIA_DIR, files));
app.use('/exports', express.static(EXPORT_DIR, { ...files, setHeaders: res => res.setHeader('Content-Disposition', 'attachment') }));
app.use('/fonts', express.static(FONTS_DIR, files));
if (fs.existsSync(WEB_DIR)) {
  app.use(express.static(WEB_DIR));
  app.get(/^\/(?!api|mcp|media|exports|fonts).*/, (_req, res) => res.sendFile(path.join(WEB_DIR, 'index.html')));
} else {
  app.get('/', (_req, res) => res.type('text').send('Editor not built. Run `npm run build`, or `npm run dev` and open http://localhost:5173'));
}

/* ---------- live updates ---------- */

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const sockets = new Set<WebSocket>();
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws' || !authorized(req)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    sockets.add(ws);
    ws.send(JSON.stringify(store.snapshot()));
    ws.on('close', () => sockets.delete(ws));
  });
});
// Coalesce bursts of changes (sliders, export progress) into at most ~25 messages a second.
let pending: NodeJS.Timeout | null = null;
const broadcast = () => {
  if (pending || !sockets.size) return;
  pending = setTimeout(() => {
    pending = null;
    const msg = JSON.stringify(store.snapshot());
    for (const ws of sockets) if (ws.readyState === ws.OPEN && ws.bufferedAmount < 8 * 1024 * 1024) ws.send(msg);
  }, 40);
};
store.subscribe(broadcast);
setInterval(broadcast, 15_000); // refreshes "agent connected"
for (const m of store.project.media) if (!store.assets[m.id]) analyze(m);

server.listen(PORT, HOST, () => {
  const base = process.env.PUBLIC_URL ?? `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log(`\nLiveCut is running\n  editor:  ${base}${TOKEN ? '/?token=…' : ''}\n  MCP:     ${base}/mcp${oauth ? ' (OAuth on: add it as a custom connector in claude.ai)' : ''}\n\nConnect Claude Code:\n  claude mcp add --transport http livecut ${base}/mcp${TOKEN ? ' --header "Authorization: Bearer $LIVECUT_TOKEN"' : ''}\n`);
});

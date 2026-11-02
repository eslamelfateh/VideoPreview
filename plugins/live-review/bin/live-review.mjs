#!/usr/bin/env node
/**
 * live-review: watch Claude edit a video, and stop it at any moment.
 *
 *   live-review start [--port 4320] [--remotion http://localhost:3000]   start the review page
 *   live-review step "label" --source in.mp4 --start 3 --end 8           quick preview of the part that changed
 *   live-review step "label" --file out.mp4|still.png [--at 3.2]         show a file you already made
 *   live-review step "label"                                             just log what you did (e.g. a Remotion edit)
 *   live-review notes [--all]                                            the user's notes
 *   live-review done <noteId> "what you changed"                         mark a note handled
 *   live-review remotion <studio-url>                                    show Remotion Studio in the page
 *   live-review hook <post-tool|prompt|stop|session>                     (used by the plugin's hooks)
 *
 * State lives in ./.live-review (or $LIVE_REVIEW_DIR). No dependencies besides Node and ffmpeg.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const [cmd, ...rest] = process.argv.slice(2);

/* ---------- state ---------- */

const dirFor = (cwd = process.cwd()) => process.env.LIVE_REVIEW_DIR || path.join(cwd, '.live-review');
let DIR = dirFor();
const P = () => ({ steps: path.join(DIR, 'steps.json'), notes: path.join(DIR, 'notes.json'), server: path.join(DIR, 'server.json'), shots: path.join(DIR, 'shots'), previews: path.join(DIR, 'previews'), config: path.join(DIR, 'config.json') });
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, f); };
const id = p => `${p}_${randomBytes(3).toString('hex')}`;
/** A number of seconds, or null for missing/empty (note: +null would be 0). */
const secs = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(+v) ? +v : null);
const fmt = t => { if (t == null || !Number.isFinite(+t)) return ''; const m = Math.floor(t / 60), s = t - m * 60; return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`; };
function args(list) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = list[i + 1] && !list[i + 1].startsWith('--') ? list[++i] : true; out[k] = v; }
    else out._.push(a);
  }
  return out;
}

/* ---------- server ---------- */

async function serve(port) {
  fs.mkdirSync(P().shots, { recursive: true });
  fs.mkdirSync(P().previews, { recursive: true });
  const clients = new Set();
  const state = () => ({ steps: readJson(P().steps, []), notes: readJson(P().notes, []), config: readJson(P().config, {}), project: path.basename(path.dirname(DIR)) });
  const push = () => { const s = `data: ${JSON.stringify(state())}\n\n`; for (const c of clients) c.write(s); };
  // Steps and notes can also change from the CLI or the hooks: watch the files.
  for (const f of [P().steps, P().notes, P().config]) fs.watchFile(f, { interval: 300 }, push);

  const body = req => new Promise((resolve, reject) => { let b = ''; req.on('data', d => { b += d; if (b.length > 20e6) req.destroy(); }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } }); });
  const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  const TYPES = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
      if (url.pathname === '/api/state') return json(res, 200, state());
      if (url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(state())}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => { clients.delete(res); clearInterval(ping); });
        return;
      }
      if (url.pathname === '/api/note' && req.method === 'POST') {
        const b = await body(req);
        const text = String(b.text ?? '').trim().slice(0, 2000);
        if (!text) return json(res, 400, { error: 'Write a note first.' });
        const note = { id: id('note'), text, at: secs(b.at), stepId: b.stepId ?? null, urgent: !!b.urgent, status: 'new', time: Date.now() };
        if (typeof b.image === 'string' && b.image.startsWith('data:image/png;base64,')) {
          const f = path.join(P().shots, `${note.id}.png`);
          fs.writeFileSync(f, Buffer.from(b.image.slice(22), 'base64'));
          note.screenshot = f;
        }
        writeJson(P().notes, [...readJson(P().notes, []), note]);
        push();
        return json(res, 200, note);
      }
      if (url.pathname === '/api/step' && req.method === 'POST') { const s = addStep(await body(req)); push(); return json(res, 200, s); }
      const f = /^\/files\/(step_[\w]+)$/.exec(url.pathname);
      if (f) {
        const step = readJson(P().steps, []).find(s => s.id === f[1]);
        if (!step?.file || !fs.existsSync(step.file)) { res.writeHead(404); return res.end(); }
        const size = fs.statSync(step.file).size, type = TYPES[path.extname(step.file).toLowerCase()] ?? 'application/octet-stream';
        const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
        if (range) {
          const a = range[1] ? +range[1] : 0, z = range[2] ? Math.min(+range[2], size - 1) : size - 1;
          res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${z}/${size}`, 'accept-ranges': 'bytes', 'content-length': z - a + 1 });
          return fs.createReadStream(step.file, { start: a, end: z }).pipe(res);
        }
        res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
        return fs.createReadStream(step.file).pipe(res);
      }
      res.writeHead(404); res.end();
    } catch (e) { json(res, 500, { error: String(e?.message ?? e) }); }
  });
  server.listen(port, '127.0.0.1', () => {
    writeJson(P().server, { port, pid: process.pid, url: `http://127.0.0.1:${port}/`, started: Date.now() });
    console.log(`live-review on http://127.0.0.1:${port}/`);
  });
}

function addStep(b) {
  const steps = readJson(P().steps, []);
  const step = { id: id('step'), n: steps.length + 1, label: String(b.label ?? 'Step').slice(0, 200), file: b.file ? path.resolve(b.file) : null, kind: b.kind ?? (b.file ? (/\.(png|jpe?g|gif)$/i.test(b.file) ? 'image' : 'video') : 'log'), at: secs(b.at), range: b.range ?? null, time: Date.now() };
  writeJson(P().steps, [...steps, step]);
  return step;
}

/* ---------- CLI ---------- */

const alive = async () => {
  const s = readJson(P().server, null);
  if (!s) return null;
  try { const r = await fetch(`${s.url}api/state`, { signal: AbortSignal.timeout(1500) }); return r.ok ? s : null; } catch { return null; }
};

async function start(a) {
  fs.mkdirSync(DIR, { recursive: true });
  if (a.remotion) writeJson(P().config, { ...readJson(P().config, {}), remotion: a.remotion });
  let s = await alive();
  if (!s) {
    const port = Number(a.port ?? process.env.LIVE_REVIEW_PORT ?? 4320);
    const log = fs.openSync(path.join(DIR, 'server.log'), 'a');
    spawn(process.execPath, [SELF, 'serve', String(port)], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, LIVE_REVIEW_DIR: DIR } }).unref();
    for (let i = 0; i < 40 && !(s = await alive()); i++) await new Promise(r => setTimeout(r, 150));
    if (!s) { console.error(`Could not start the review page (port ${port} busy?). See ${path.join(DIR, 'server.log')}`); process.exit(1); }
  }
  // Keep the review state out of git.
  const gi = path.join(DIR, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  console.log(`Live review: ${s.url}\nAsk the user to open it. Their notes reach you automatically after each tool call.\nCLI: node "${SELF}"`);
}

/** A small, fast preview of just the part of a video that changed. */
function preview(source, startT, endT, out) {
  const s = Math.max(0, Number(startT ?? 0) - 0.5), e = endT != null ? Number(endT) + 0.5 : null;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(s), ...(e != null ? ['-t', String(Math.max(0.2, e - s))] : []), '-i', source,
    '-vf', 'scale=-2:480', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg could not make the preview: ${(r.stderr || '').trim().split('\n').pop()}`);
  return { file: out, offset: s };
}

async function step(a) {
  fs.mkdirSync(P().previews, { recursive: true });
  const label = a._.join(' ') || a.label || 'Step';
  const b = { label, at: a.at != null ? +a.at : undefined };
  if (a.source) {
    const out = path.join(P().previews, `${Date.now()}.mp4`);
    const t0 = Date.now();
    const p = preview(a.source, a.start, a.end, out);
    Object.assign(b, { file: p.file, kind: 'video', range: a.start != null ? { start: +a.start, end: a.end != null ? +a.end : null, offset: p.offset } : null });
    process.stderr.write(`preview ready in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  } else if (a.file) { if (!fs.existsSync(a.file)) { console.error(`No such file: ${a.file}`); process.exit(1); } b.file = a.file; }
  const s = await alive();
  const st = s ? await (await fetch(`${s.url}api/step`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json() : addStep(b);
  console.log(`Step ${st.n} shown in the review: ${st.label}${s ? '' : ' (review page not running: live-review start)'}`);
  const pending = readJson(P().notes, []).filter(n => n.status !== 'done');
  if (pending.length) console.log(`\nThe user has ${pending.length} note(s) open:\n${notesText(pending)}`);
}

const notesText = ns => ns.map(n => `- [${n.id}]${n.urgent ? ' URGENT' : ''}${n.at != null ? ` at ${fmt(n.at)}` : ''}${n.stepId ? ` (on ${stepLabel(n.stepId)})` : ''}: "${n.text}"${n.screenshot ? `\n  screenshot of that frame: ${n.screenshot} (Read it to see what they mean)` : ''}${n.reply ? `\n  you replied: ${n.reply}` : ''}`).join('\n');
const stepLabel = sid => { const s = readJson(P().steps, []).find(x => x.id === sid); return s ? `step ${s.n} "${s.label}"` : sid; };

/* ---------- hooks: deliver the user's notes to Claude while it works ---------- */

async function hook(kind) {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* no input */ }
  // Claude Code passes an absolute cwd; resolve anyway so a relative one cannot point somewhere else.
  DIR = dirFor(input.cwd ? path.resolve(process.cwd(), input.cwd) : process.cwd());
  const emit = v => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
  if (kind === 'session') {
    if (!fs.existsSync(DIR)) process.exit(0);
    return emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `Live review is set up in this folder (.live-review). CLI: node "${SELF}". Start it with: node "${SELF}" start` } });
  }
  if (!fs.existsSync(P().notes)) process.exit(0);
  const notes = readJson(P().notes, []);
  const fresh = notes.filter(n => n.status === 'new');
  const open = notes.filter(n => n.status !== 'done');
  const how = `When one is handled: node "${SELF}" done <id> "what you changed". Show the result with: node "${SELF}" step "<label>" --source <video> --start <s> --end <e>`;
  if (kind === 'stop') {
    // Do not finish while the user is waiting on notes; stop_hook_active avoids looping on the same notes.
    if (!open.length || (input.stop_hook_active && !fresh.length)) process.exit(0);
    for (const n of fresh) n.status = 'delivered';
    writeJson(P().notes, notes);
    return emit({ decision: 'block', reason: `Before finishing: the user left notes in the live review that are not handled yet.\n${notesText(open)}\n${how}` });
  }
  if (!fresh.length) process.exit(0);
  for (const n of fresh) n.status = 'delivered';
  writeJson(P().notes, notes);
  const urgent = fresh.some(n => n.urgent);
  const text = `LIVE REVIEW: the user is watching your edit and just left ${fresh.length} note(s)${urgent ? '. One is marked STOP: pause what you were doing and handle it first' : ''}.\n${notesText(fresh)}\n${how}`;
  emit({ hookSpecificOutput: { hookEventName: kind === 'prompt' ? 'UserPromptSubmit' : 'PostToolUse', additionalContext: text } });
}

/* ---------- main ---------- */

const a = args(rest);
switch (cmd) {
  case 'serve': await serve(Number(a._[0] ?? 4320)); break;
  case 'start': await start(a); break;
  case 'step': case 'preview': await step(a); break;
  case 'notes': { const ns = readJson(P().notes, []).filter(n => a.all || n.status !== 'done'); console.log(ns.length ? notesText(ns) : 'No open notes.'); break; }
  case 'done': {
    const ns = readJson(P().notes, []); const n = ns.find(x => x.id === a._[0]);
    if (!n) { console.error(`No note ${a._[0]}`); process.exit(1); }
    n.status = 'done'; n.reply = a._.slice(1).join(' ') || n.reply; n.doneAt = Date.now();
    writeJson(P().notes, ns); console.log(`Marked ${n.id} done.`); break;
  }
  case 'remotion': writeJson(P().config, { ...readJson(P().config, {}), remotion: a._[0] }); console.log(`Showing Remotion Studio (${a._[0]}) in the review page.`); break;
  case 'hook': await hook(a._[0]); break;
  default: console.log(fs.readFileSync(SELF, 'utf8').split('\n').slice(2, 14).map(l => l.replace(/^ \* ?/, '')).join('\n'));
}

/* ---------- the review page ---------- */

const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live review</title>
<style>
:root{--bg:#121212;--panel:#1b1b1b;--line:#303030;--fg:#ecebe7;--muted:#9a9893;--faint:#5f5d59;--cap:#f0cf6a;--live:#3fa35a;--warn:#e0a54a;--bad:#e0706a;color-scheme:dark}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,'Segoe UI','Noto Sans Arabic',sans-serif;display:flex;flex-direction:column}
button{font:inherit;color:inherit;background:#242424;border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer}button:hover:not(:disabled){border-color:var(--muted)}button:disabled{opacity:.45}
textarea{font:inherit;color:var(--fg);background:#161616;border:1px solid var(--line);border-radius:8px;padding:8px 10px;width:100%;resize:vertical}
header{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--line)}header b{font-size:15px}.dot{width:9px;height:9px;border-radius:50%;background:var(--faint)}.dot.on{background:var(--live);box-shadow:0 0 0 0 #3fa35a99;animation:ping 1.4s infinite}
@keyframes ping{100%{box-shadow:0 0 0 8px #3fa35a00}}.muted{color:var(--muted);font-size:12.5px}.sp{flex:1}
main{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 360px}
.stage{display:flex;flex-direction:column;gap:10px;padding:14px;min-width:0}
.view{flex:1;min-height:260px;background:#0b0b0b;border-radius:12px;display:grid;place-items:center;overflow:hidden;position:relative}
.view video,.view img{max-width:100%;max-height:100%}.view iframe{width:100%;height:100%;border:0;background:#fff}
.empty{color:var(--faint);text-align:center;padding:20px}
.bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.tc{font:500 14px ui-monospace,monospace}
.note{display:grid;gap:8px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px}
.note .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.primary{background:var(--fg);color:var(--bg);border-color:var(--fg);font-weight:600}.stop{border-color:var(--bad);color:var(--bad)}
aside{border-left:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column;min-height:0}
aside h3{margin:0;padding:12px 14px 6px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.list{list-style:none;margin:0;padding:0 10px 10px;display:flex;flex-direction:column;gap:6px;overflow-y:auto}
.steps{flex:1}.list li{border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:#171717;cursor:pointer;font-size:13px}
.list li.sel{border-color:var(--cap)}.list li.new{animation:fresh 1.5s ease-out}@keyframes fresh{0%{background:#3a3424}}
.n{font:11px ui-monospace,monospace;color:var(--faint);margin-right:6px}.k{font-size:11px;color:var(--muted);float:right}
.st{font-size:11px;border-radius:5px;padding:0 6px}.st.new{background:#3a3424;color:var(--cap)}.st.delivered{background:#22303a;color:#9fc4e0}.st.done{background:#22301f;color:#9fd3b0}
.reply{color:#9fd3b0;font-size:12.5px}.notes{max-height:40%}
@media(max-width:860px){main{grid-template-columns:1fr}aside{border-left:0;border-top:1px solid var(--line)}}
</style></head><body>
<header><span class="dot" id="dot"></span><b>Live review</b><span class="muted" id="proj"></span><span class="sp"></span><span class="muted" id="last"></span></header>
<main>
 <section class="stage">
  <div class="view" id="view"><div class="empty">Waiting for Claude's first step…<br><span class="muted">Each change shows up here as a quick preview, while Claude keeps working.</span></div></div>
  <div class="bar"><span class="tc" id="tc"></span><label class="muted"><input type="checkbox" id="follow" checked> follow the latest step</label></div>
  <div class="note">
   <div class="muted" id="where">Pause on the moment you mean, then tell Claude what to change.</div>
   <textarea id="text" rows="2" dir="auto" placeholder="e.g. لأ، الحتة دي خليها أسرع · make this title yellow"></textarea>
   <div class="row" id="atrow" hidden><label class="muted" for="attime">At (from the Studio timeline)</label><input id="attime" placeholder="0:02" style="width:90px;font:inherit;color:var(--fg);background:#161616;border:1px solid var(--line);border-radius:8px;padding:5px 8px"></div>
   <div class="row"><button class="primary" id="send">Send note</button><button class="stop" id="urgent" title="Claude stops what it is doing and handles this first">Stop &amp; change this</button><span class="muted" id="sent"></span></div>
  </div>
 </section>
 <aside>
  <h3>Claude's steps</h3><ul class="list steps" id="steps"></ul>
  <h3>Your notes</h3><ul class="list notes" id="notes"></ul>
 </aside>
</main>
<script>
const $ = id => document.getElementById(id);
let S = { steps: [], notes: [], config: {} }, sel = null, seen = new Set();
const fmt = t => { if (t == null) return ''; const m = Math.floor(t / 60), s = t - m * 60; return String(m).padStart(2, '0') + ':' + s.toFixed(1).padStart(4, '0'); };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function media() { return $('view').querySelector('video'); }
function typedTime() {
  // "0:02", "1:05.5" or "2.5" (seconds); empty means no time.
  const v = $('attime').value.trim(); if (!v) return null;
  const parts = v.split(':').map(Number); if (parts.some(x => !Number.isFinite(x))) return null;
  return parts.reduce((a, x) => a * 60 + x, 0);
}
function current() {
  // Time in the edited video: the preview starts at range.offset (or 0).
  const step = S.steps.find(s => s.id === sel), v = media();
  if (v && step) return (step.range?.offset ?? 0) + v.currentTime;
  // Remotion Studio runs in a frame the page cannot read, so the user types the time.
  if (S.config.remotion) return typedTime();
  return step?.at ?? null;
}
function show(step) {
  sel = step?.id ?? null;
  const view = $('view');
  if (S.config.remotion && (!step || !step.file)) {
    if (!view.querySelector('iframe')) view.innerHTML = '<iframe src="' + esc(S.config.remotion) + '" title="Remotion Studio"></iframe>';
  } else if (step?.file) {
    const src = '/files/' + step.id;
    if (!view.dataset.src || view.dataset.src !== src) {
      view.dataset.src = src;
      view.innerHTML = step.kind === 'image' ? '<img alt="" src="' + src + '">' : '<video controls autoplay muted playsinline src="' + src + '"></video>';
    }
  } else if (step) view.innerHTML = '<div class="empty">' + esc(step.label) + '<br><span class="muted">No preview for this step.</span></div>';
  render();
}
function render() {
  $('proj').textContent = S.project ? '· ' + S.project : '';
  const last = S.steps[S.steps.length - 1];
  $('dot').classList.toggle('on', !!last && Date.now() - last.time < 120000);
  $('last').textContent = last ? 'last step ' + Math.round((Date.now() - last.time) / 1000) + 's ago' : '';
  $('steps').innerHTML = S.steps.slice().reverse().map(s => '<li data-id="' + s.id + '" class="' + (s.id === sel ? 'sel ' : '') + (seen.has(s.id) ? '' : 'new') + '"><span class="n">' + String(s.n).padStart(2, '0') + '</span>' + esc(s.label) + '<span class="k">' + (s.file ? (s.kind === 'image' ? 'still' : 'preview') : 'log') + (s.range ? ' · ' + fmt(s.range.start) : s.at != null ? ' · ' + fmt(s.at) : '') + '</span></li>').join('') || '<li class="muted">No steps yet.</li>';
  S.steps.forEach(s => seen.add(s.id));
  $('notes').innerHTML = S.notes.slice().reverse().map(n => '<li><span class="st ' + n.status + '">' + ({ new: 'sent', delivered: 'Claude has it', done: 'done' })[n.status] + '</span> ' + (n.urgent ? '<b>STOP</b> ' : '') + (n.at != null ? '<span class="n">' + fmt(n.at) + '</span>' : '') + '<span dir="auto">' + esc(n.text) + '</span>' + (n.reply ? '<div class="reply" dir="auto">↳ ' + esc(n.reply) + '</div>' : '') + '</li>').join('') || '<li class="muted">Pause the preview and leave a note: Claude gets it after its current command.</li>';
  $('atrow').hidden = !(S.config.remotion && !media());
  const t = current(), step = S.steps.find(s => s.id === sel);
  $('where').textContent = S.config.remotion && !media() ? 'Watching Remotion Studio, which updates as Claude edits. Type the time from the Studio timeline if your note is about a moment.' : step ? 'At ' + (t != null ? fmt(t) : '—') + ' in step ' + step.n + ' "' + step.label + '": what should change?' : 'Pause on the moment you mean, then tell Claude what to change.';
}
$('steps').onclick = e => { const li = e.target.closest('li[data-id]'); if (!li) return; $('follow').checked = false; show(S.steps.find(s => s.id === li.dataset.id)); };
function frame() {
  const v = media(); if (!v || !v.videoWidth) return null;
  const c = document.createElement('canvas'), w = Math.min(640, v.videoWidth);
  c.width = w; c.height = Math.round(v.videoHeight * w / v.videoWidth);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  try { return c.toDataURL('image/png'); } catch { return null; }
}
async function send(urgent) {
  const text = $('text').value.trim(); if (!text) return;
  const v = media(); if (v && !v.paused) v.pause();
  const r = await fetch('/api/note', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, urgent, at: current(), stepId: sel, image: frame() }) });
  if (r.ok) { $('text').value = ''; $('attime').value = ''; $('sent').textContent = urgent ? 'Sent. Claude will stop and handle it after its current command.' : 'Sent. Claude gets it after its current command.'; setTimeout(() => $('sent').textContent = '', 5000); }
}
$('send').onclick = () => send(false); $('urgent').onclick = () => send(true);
$('text').onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(false); };
setInterval(() => { const v = media(); $('tc').textContent = v ? fmt(current()) + (v.duration ? ' / preview ' + v.duration.toFixed(1) + 's' : '') : ''; render(); }, 500);
const es = new EventSource('/events');
es.onmessage = e => {
  const prev = S.steps.length; S = JSON.parse(e.data);
  if ($('follow').checked && (S.steps.length !== prev || !sel)) show(S.steps[S.steps.length - 1] ?? null); else render();
};
</script></body></html>`;

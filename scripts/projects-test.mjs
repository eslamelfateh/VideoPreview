/**
 * Projects and review links: create/switch/delete projects (API and MCP), shared media
 * is kept, review links show only their project and accept notes only, and the
 * reviewer page works in a browser.
 * Usage: node scripts/projects-test.mjs <video> <other-video> [out-dir]
 * LIVECUT_URL (default http://127.0.0.1:4317); LIVECUT_TOKEN if the server has one.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright')); }

const BASE = process.env.LIVECUT_URL ?? 'http://127.0.0.1:4317';
const TOKEN = process.env.LIVECUT_TOKEN;
const auth = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};
const [videoA, videoB, outDir = '.'] = process.argv.slice(2);
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`); };
const api = (p, body) => fetch(`${BASE}/api${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...auth }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
const upload = async f => { const fd = new FormData(); fd.append('files', new Blob([fs.readFileSync(f)]), path.basename(f)); const r = await fetch(`${BASE}/api/media`, { method: 'POST', body: fd, headers: auth }); if (!r.ok) throw new Error(await r.text()); };
const client = new Client({ name: 'projects-test', version: '0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: auth } }));
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { ...r, text: r.content?.map(c => c.text).join('\n') ?? '' }; };

try {
  /* projects */
  await api('/reset', {});
  await api('/projects/rename', { name: 'Project A' });
  await upload(videoA);
  const a = await api('/state');
  const aId = a.projectId, aMedia = a.project.media[0];
  await api('/projects', { name: 'Project B' });
  const b = await api('/state');
  check('create a project and switch to it', b.projectId !== aId && b.project.name === 'Project B' && b.project.clips.length === 0 && b.projects.length >= 2);
  await upload(videoB);
  await api(`/projects/${aId}/open`, {});
  const a2 = await api('/state');
  check('switching back keeps the first project intact', a2.projectId === aId && a2.project.clips.length === 1 && a2.project.media[0].id === aMedia.id);
  const lp = await call('list_projects');
  check('agent lists projects', lp.structuredContent.projects.some(p => p.name === 'Project B') && lp.structuredContent.projects.find(p => p.current).id === aId);
  const cp = await call('create_project', { name: 'Project C' });
  await call('open_project', { projectId: aId });
  check('agent creates and opens projects', !!cp.structuredContent.id && (await api('/state')).projectId === aId);

  /* review link */
  const { token } = await api('/review-link', {});
  check('review link created', !!token && (await api('/state')).reviewToken === token);
  const page = await fetch(`${BASE}/review/${token}`);
  check('review page loads without the owner token', page.ok && /<div id="root">/.test(await page.text()));
  const rs = await (await fetch(`${BASE}/rapi/${token}/state`)).json();
  check('review state shows the project, without history', rs.review === true && rs.project.name === 'Project A' && rs.steps.length === 0);
  const own = await fetch(`${BASE}/rmedia/${token}/${aMedia.file}`, { method: 'HEAD' });
  const bMedia = (await (async () => { await api(`/projects/${b.projectId}/open`, {}); const s = await api('/state'); await api(`/projects/${aId}/open`, {}); return s.project.media[0]; })());
  const other = await fetch(`${BASE}/rmedia/${token}/${bMedia.file}`, { method: 'HEAD' });
  const traversal = await fetch(`${BASE}/rmedia/${token}/..%2Fstate.json`, { method: 'HEAD' });
  check('reviewers get only this project\'s media', own.ok && other.status === 404 && traversal.status === 404, `own ${own.status}, other project ${other.status}, ../ ${traversal.status}`);
  const note = await (await fetch(`${BASE}/rapi/${token}/note`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start: 1, end: 2, text: 'make the captions bigger', kind: 'do' }) })).json();
  const a3 = await api('/state');
  check('a reviewer note lands on the open project', /Reviewer/.test(note.summary ?? '') && a3.project.markers.some(m => m.text === '[Reviewer] make the captions bigger'));
  const gp = await call('get_project');
  check('the agent is told a reviewer left a note', /reviewer left a note/i.test(gp.text));
  if (TOKEN) {
    const denied = await fetch(`${BASE}/api/state`);
    const deniedEdit = await fetch(`${BASE}/rapi/${token}/edit`, { method: 'POST' });
    check('review access does not open the editor API', denied.status === 401 && deniedEdit.status === 404);
  }

  /* a note on a project that is not open is kept for later */
  await api(`/projects/${b.projectId}/open`, {});
  const { token: tokB } = await api('/review-link', {});
  await api(`/projects/${aId}/open`, {});
  const off = await (await fetch(`${BASE}/rapi/${tokB}/note`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start: 0, end: 1, text: 'intro too long', kind: 'do' }) })).json();
  await api(`/projects/${b.projectId}/open`, {});
  const b2 = await api('/state');
  check('notes on a closed project are saved and shown when it opens', !!off.summary && b2.project.markers.some(m => /intro too long/.test(m.text)) && b2.notes.some(n => /reviewer/i.test(n)));
  await api(`/projects/${aId}/open`, {});

  /* revoke */
  await api(`/projects/${b.projectId}/open`, {});
  await api('/review-link/revoke', {});
  await api(`/projects/${aId}/open`, {});
  check('a turned-off review link stops working', (await fetch(`${BASE}/rapi/${tokB}/state`)).status === 404);

  /* delete keeps shared media */
  await api(`/projects/${cp.structuredContent.id}/delete`, {});
  await api(`/projects/${b.projectId}/delete`, {});
  const mediaDir = process.env.LIVECUT_DATA ? path.join(process.env.LIVECUT_DATA, 'media') : null;
  const st = await api('/state');
  check('deleting projects', st.projects.length === 1 && st.projects[0].id === aId);
  if (mediaDir) check('media only the deleted project used is removed, the rest stays', !fs.existsSync(path.join(mediaDir, bMedia.file)) && fs.existsSync(path.join(mediaDir, aMedia.file)));

  /* reviewer page in a browser */
  const browser = await playwright.chromium.launch();
  const pg = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors = [];
  pg.on('pageerror', e => errors.push(String(e)));
  await pg.goto(`${BASE}/review/${token}`);
  await pg.waitForSelector('.preview');
  await pg.waitForTimeout(800);
  const ui = await pg.evaluate(() => ({ exportBtn: [...document.querySelectorAll('button')].some(b => /Export MP4/.test(b.textContent)), steps: !!document.querySelector('.agent'), badge: document.querySelector('.review-badge')?.textContent, video: !!document.querySelector('video.media.on') }));
  check('reviewer page: video, no editing controls', ui.video && !ui.exportBtn && !ui.steps && /Project A/.test(ui.badge ?? ''), JSON.stringify(ui));
  const clipsBefore = (await api('/state')).project.clips.map(c => c.start).join();
  const item = await pg.locator('.lane .item.v').first().boundingBox();
  await pg.mouse.move(item.x + item.width / 2, item.y + 10); await pg.mouse.down(); await pg.mouse.move(item.x + item.width / 2 + 80, item.y + 10, { steps: 5 }); await pg.mouse.up();
  await pg.waitForTimeout(500);
  check('reviewers cannot drag clips', (await api('/state')).project.clips.map(c => c.start).join() === clipsBefore);
  await pg.fill('#review-text', 'الكابشن هنا صغير');
  await pg.click('button:text-is("Send note")');
  await pg.waitForSelector('.reply');
  const got = (await api('/state')).project.markers.some(m => m.text === '[Reviewer] الكابشن هنا صغير');
  await pg.waitForTimeout(1800);
  await pg.screenshot({ path: path.join(outDir, 'review-page.png') });
  check('reviewer leaves a note from the page', got);
  check('no errors on the reviewer page', errors.length === 0, errors.join(' | '));
  await browser.close();
} catch (e) {
  check('test run', false, e.stack);
} finally {
  await client.close();
}
const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

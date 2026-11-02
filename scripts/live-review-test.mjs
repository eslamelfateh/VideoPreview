/**
 * Tests the live-review plugin without a model: review page, previews, notes with
 * screenshots, hook delivery (once), the Stop hook, and the page in a browser.
 * Usage: node scripts/live-review-test.mjs <video> [work-dir]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright')); }

const LR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../plugins/live-review/bin/live-review.mjs');
const [video, workArg = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-'))] = process.argv.slice(2);
const work = path.resolve(workArg); // hooks always get an absolute cwd from Claude Code
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`); };
const port = String(4400 + Math.floor(Math.random() * 400));
const env = { ...process.env, LIVE_REVIEW_PORT: port };
const lr = (...a) => spawnSync(process.execPath, [LR, ...a], { cwd: work, env, encoding: 'utf8' });
const hook = (kind, input) => spawnSync(process.execPath, [LR, 'hook', kind], { cwd: work, env, input: JSON.stringify({ cwd: work, ...input }), encoding: 'utf8' });
const base = `http://127.0.0.1:${port}`;
let browser;

try {
  fs.mkdirSync(work, { recursive: true });
  fs.copyFileSync(video, path.join(work, 'in.mp4'));
  check('hooks do nothing in folders without live review', hook('post-tool', {}).stdout === '' && hook('stop', {}).stdout === '');
  const st = lr('start');
  check('start prints the review address', st.status === 0 && st.stdout.includes(base));
  check('review state stays out of git', fs.readFileSync(path.join(work, '.live-review/.gitignore'), 'utf8').trim() === '*');
  const t0 = Date.now();
  const s1 = lr('step', 'Cut the first second', '--source', 'in.mp4', '--start', '1', '--end', '4');
  check('a step makes a short preview in seconds', s1.status === 0 && Date.now() - t0 < 15000, `${Date.now() - t0} ms`);
  const steps = (await (await fetch(`${base}/api/state`)).json()).steps;
  const f = await fetch(`${base}/files/${steps[0].id}`, { headers: { range: 'bytes=0-99' } });
  check('the preview is served with range requests', f.status === 206 && f.headers.get('content-type') === 'video/mp4');
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', steps[0].file]).toString());
  check('the preview covers only the changed part (+context)', dur > 3 && dur < 5, `${dur.toFixed(2)} s`);
  check('unknown files are not served', (await fetch(`${base}/files/step_nothere`)).status === 404 && (await fetch(`${base}/files/..%2F..%2Fetc%2Fpasswd`)).status === 404);
  lr('step', 'Log only', '--at', '2');

  /* the page, like a user */
  browser = await playwright.chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base);
  await page.waitForSelector('#steps li[data-id]');
  await page.locator('#steps li[data-id]', { hasText: 'Cut the first second' }).click();
  await page.waitForSelector('.view video');
  await page.waitForFunction(() => document.querySelector('.view video').readyState >= 2);
  await page.evaluate(() => { const v = document.querySelector('.view video'); v.pause(); v.currentTime = 1; });
  await page.waitForTimeout(500);
  await page.fill('#text', 'خلي العنوان أصفر');
  await page.click('#urgent');
  await page.waitForFunction(() => document.querySelector('#notes .st')?.textContent === 'sent');
  const note = (await (await fetch(`${base}/api/state`)).json()).notes[0];
  check('a note from the page has the time and a frame screenshot', note && Math.abs(note.at - (0.5 + 1)) < 0.2 && note.urgent && fs.existsSync(note.screenshot), note ? `at ${note.at}` : '');

  /* hooks */
  const h1 = hook('post-tool', {});
  const ctx = h1.stdout ? JSON.parse(h1.stdout).hookSpecificOutput?.additionalContext ?? '' : '';
  check('the next tool call delivers the note to Claude', ctx.includes('خلي العنوان أصفر') && ctx.includes('STOP') && ctx.includes(note.screenshot));
  check('it is delivered only once', hook('post-tool', {}).stdout === '');
  const stop1 = hook('stop', { stop_hook_active: false });
  check('Claude cannot finish while the note is open', stop1.stdout && JSON.parse(stop1.stdout).decision === 'block');
  check('no loop: a second stop with nothing new is allowed', hook('stop', { stop_hook_active: true }).stdout === '');
  lr('done', note.id, 'خليت العنوان أصفر');
  check('after done, Claude can finish', hook('stop', {}).stdout === '');
  await page.waitForFunction(() => document.querySelector('#notes .st')?.textContent === 'done');
  check('the page shows the note done with the reply', (await page.locator('#notes li').first().textContent()).includes('خليت العنوان أصفر'));
  const msg = hook('prompt', {});
  check('a new chat message with nothing new adds nothing', msg.stdout === '');
  await page.screenshot({ path: path.join(work, 'live-review-page.png') });
  check('no errors on the page', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('test run', false, e.stack);
} finally {
  await browser?.close();
  try { process.kill(JSON.parse(fs.readFileSync(path.join(work, '.live-review/server.json'), 'utf8')).pid); } catch { /* not running */ }
}
const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

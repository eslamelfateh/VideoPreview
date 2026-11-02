/**
 * Browser + agent end-to-end test. Drives the editor like a person (upload, sliders,
 * dragging, notes, locks, keyboard) while an MCP client acts as the agent.
 *
 * Needs: a running server (npm start), Playwright with Chromium, ffmpeg.
 * Usage: node scripts/e2e.mjs <video-with-speech> [music-file] [out-dir]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright')); }

const BASE = process.env.LIVECUT_URL ?? 'http://127.0.0.1:4317';
const [video, music, outDir = '.'] = process.argv.slice(2);
if (!video) { console.error('usage: node scripts/e2e.mjs <video> [music] [outDir]'); process.exit(2); }

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`); };
const api = (p, body) => fetch(`${BASE}/api${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
const state = () => api('/state');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(150); } return null; }

/** Rough word timings from speech regions (silencedetect), enough to drive captions in a test. */
function fakeTranscript(file, text) {
  const out = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'silencedetect=n=-35dB:d=0.25', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const starts = [...out.matchAll(/silence_end: ([\d.]+)/g)].map(m => +m[1]);
  const ends = [...out.matchAll(/silence_start: ([\d.]+)/g)].map(m => +m[1]);
  const regions = [];
  let s = 0;
  for (const e of ends) { if (e - s > 0.2) regions.push([s, e]); s = starts.shift() ?? e; }
  const words = text.split(/\s+/);
  const total = regions.reduce((a, [x, y]) => a + y - x, 0);
  const per = total / words.length;
  const res = []; let ri = 0, t = regions[0]?.[0] ?? 0;
  for (const w of words) {
    if (ri < regions.length && t + per > regions[ri][1] + 0.01) { ri = Math.min(regions.length - 1, ri + 1); t = Math.max(t, regions[ri][0]); }
    res.push({ text: w, start: +t.toFixed(3), end: +(t + per * 0.9).toFixed(3) }); t += per;
  }
  return res;
}

const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

const agent = new Client({ name: 'e2e-agent', version: '0' });
await agent.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
const call = async (name, args = {}) => {
  const r = await agent.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), error: !!r.isError };
};

try {
  await api('/reset', {});
  await page.goto(BASE);
  await page.waitForSelector('.onboard');

  /* 1. upload through the file input */
  await page.setInputFiles('#file-input', [video, ...(music ? [music] : [])]);
  const s1 = await until(async () => { const s = await state(); return s.project.clips.length >= (music ? 2 : 1) && s; }, 30000);
  check('upload places clips on the timeline', !!s1);
  const vClip = s1.project.clips.find(c => c.track === 'video');
  const aClip = s1.project.clips.find(c => c.track === 'audio');
  const thumbs = await until(async () => { const s = await state(); return s.assets[vClip.mediaId]?.thumbs && s.assets[vClip.mediaId]?.peaks && s; }, 30000);
  check('thumbnails and waveform are generated', !!thumbs);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, 'e2e-1-upload.png') });

  /* 2. agent: transcript, captions, zoom */
  const words = fakeTranscript(video, 'Hello everyone. Today I will show you how to edit a video with one sentence. You do not need to open any program. The agent cuts and writes the captions while you watch everything live. That is it. Thanks for watching.');
  await call('set_transcript', { mediaId: vClip.mediaId, language: 'en', words });
  const cap = await call('add_captions', { wordsPerCaption: 3 });
  check('agent adds captions', /Added \d+ captions/.test(cap.text), cap.text.split('\n')[0]);
  const hit = await call('find_words', { query: 'today' });
  const [hs, he] = hit.text.split(' ')[0].split('-').map(Number);
  const z = await call('add_zoom', { start: hs - 0.2, end: he + 0.8, scale: 1.4 });
  check('agent adds a zoom', !z.error, z.text.split('\n')[0]);

  /* 3. user: volume of the music with the slider (live, merged into one step) */
  if (aClip) {
    const box = await page.locator('.lane .item.a').first().boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('#clip-vol');
    const before = (await state()).steps.length;
    const slider = await page.locator('#clip-vol').boundingBox();
    await page.mouse.move(slider.x + slider.width * 0.5, slider.y + slider.height / 2);
    await page.mouse.down();
    for (let i = 0; i <= 10; i++) { await page.mouse.move(slider.x + slider.width * (0.5 - i * 0.035), slider.y + slider.height / 2); await page.waitForTimeout(40); }
    await page.mouse.up();
    await page.waitForTimeout(700);
    const s = await state();
    const music2 = s.project.clips.find(c => c.id === aClip.id);
    check('volume slider lowers the music', music2.volume < 0.6, `volume ${music2.volume}`);
    check('slider drag is one step, not dozens', s.steps.length - before === 1, `${s.steps.length - before} step(s)`);
    await page.click('button:text-is("Mute")');
    await until(async () => (await state()).project.clips.find(c => c.id === aClip.id).volume === 0);
    await page.locator('#clip-fin').fill('1');
    await page.locator('#clip-vol').fill('0.3');
    await page.waitForTimeout(500);
    const s3 = await state();
    check('mute, then fade in and volume set from the inspector', s3.project.clips.find(c => c.id === aClip.id).volume === 0.3 && s3.project.clips.find(c => c.id === aClip.id).fadeIn === 1);
  }

  /* 4. user: drag a caption to the right; its word timings move with it */
  const capBefore = (await state()).project.texts.find(t => t.style === 'caption');
  const capEl = page.locator('.lane .item.t').first();
  const cb = await capEl.boundingBox();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width / 2 + 40, cb.y + cb.height / 2, { steps: 6 });
  await page.mouse.up();
  const capAfter = await until(async () => { const t = (await state()).project.texts.find(x => x.id === capBefore.id); return t.start !== capBefore.start && t; });
  const shift = capAfter ? capAfter.start - capBefore.start : 0;
  check('drag moves a caption', !!capAfter && shift > 0, `+${shift.toFixed(2)}s`);
  check('caption words move with it', !!capAfter && Math.abs((capAfter.words[0].start - capBefore.words[0].start) - shift) < 0.01);

  /* 5. user: trim the end of the video clip by dragging its right edge */
  const vb = await page.locator('.lane .item.v').first().boundingBox();
  await page.mouse.move(vb.x + vb.width - 2, vb.y + vb.height / 2);
  await page.mouse.down();
  await page.mouse.move(vb.x + vb.width - 60, vb.y + vb.height / 2, { steps: 6 });
  await page.mouse.up();
  const trimmed = await until(async () => { const c = (await state()).project.clips.find(x => x.id === vClip.id); return c.out < vClip.out - 0.2 && c; });
  check('dragging an edge trims the clip', !!trimmed, trimmed ? `out ${vClip.out} → ${trimmed.out}` : '');

  /* 6. user: select a range on the ruler, leave a note, and lock another range */
  const ruler = await page.locator('.ruler').boundingBox();
  const lanesW = (await page.locator('.tl-lanes').boundingBox()).width;
  const total = (await state()).project.clips.reduce((m, c) => Math.max(m, c.start + c.out - c.in), 0);
  const pxPerSec = lanesW / Math.max(10, total * 1.1);
  const xAt = t => ruler.x + t * pxPerSec;
  await page.mouse.move(xAt(1), ruler.y + 10); await page.mouse.down(); await page.mouse.move(xAt(3), ruler.y + 10, { steps: 5 }); await page.mouse.up();
  await page.waitForSelector('#range-note');
  await page.fill('#range-note', 'add a title here that says Welcome');
  await page.click('button:text-is("Add note")');
  const note = await until(async () => (await state()).project.markers.find(m => m.kind === 'do'));
  check('range + note for the agent', !!note, note ? `${note.start}–${note.end}` : '');
  await page.mouse.move(xAt(6), ruler.y + 10); await page.mouse.down(); await page.mouse.move(xAt(8), ruler.y + 10, { steps: 5 }); await page.mouse.up();
  await page.fill('#range-note', 'keep this part exactly as it is');
  await page.click("button:has-text(\"Lock: don't touch\")");
  const lock = await until(async () => (await state()).project.markers.find(m => m.kind === 'dont'));
  check('lock a range', !!lock);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, 'e2e-2-edits.png') });

  /* 7. agent: sees the notes, is refused inside the lock, resolves the note */
  const proj = await call('get_project');
  check('agent is told about the user\'s edits and notes', /edited the video by hand/.test(proj.text) && /userNotes/.test(proj.text) && /DO NOT TOUCH/.test(proj.text));
  const bad = await call('add_zoom', { start: lock.start + 0.2, end: lock.end - 0.2 });
  check('agent edit inside a locked range is refused', bad.error && /locked/.test(bad.text));
  const cutBad = await call('cut_range', { start: lock.start - 0.5, end: lock.start + 0.5 });
  check('agent cut overlapping a lock is refused', cutBad.error);
  const title = await call('add_text', { text: 'Welcome', start: note.start, end: note.end, style: 'title' });
  const res = await call('resolve_note', { noteId: note.id, reply: 'Added the title "Welcome".' });
  const done = (await state()).project.markers.find(m => m.id === note.id);
  check('agent handles the note and resolves it', !title.error && !res.error && done.status === 'done');

  /* 8. keyboard: split at playhead, undo with Ctrl+Z */
  await page.click('.stage', { position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Escape');
  await api('/control', {});
  const nClips = (await state()).project.clips.length;
  await page.evaluate(() => document.activeElement?.blur());
  const lanes = await page.locator('.tl-lanes').boundingBox();
  await page.mouse.click(lanes.x + 2.2 * pxPerSec, lanes.y + 60 + 44 * 3 + 20); // empty fx-lane area → seek
  await page.keyboard.press('s');
  const split = await until(async () => (await state()).project.clips.length === nClips + 1);
  check('S splits at the playhead', !!split);
  await page.keyboard.press('Control+z');
  const undone = await until(async () => (await state()).project.clips.length === nClips);
  check('Ctrl+Z undoes it', !!undone);

  /* 9. step mode: accept from the UI with a note */
  await page.click('.seg button:text-is("Step")');
  await until(async () => (await state()).control.mode === 'step');
  const pending = call('add_zoom', { start: 0.5, end: 1.2, scale: 1.2 });
  await page.waitForSelector('.step.review', { timeout: 10000 });
  await page.fill('.review input', 'nice, continue');
  await page.click('.review .accept');
  const acc = await pending;
  check('step mode: agent waits, gets accepted with the note', /accepted this step and said: nice, continue/.test(acc.text));
  await page.click('.seg button:text-is("Live")');

  /* 10. hold before on the zoom step */
  await page.waitForTimeout(300);
  const hold = page.locator('.step', { hasText: 'add_zoom' }).first().locator('button.hold');
  await hold.dispatchEvent('pointerdown');
  await page.waitForSelector('.badge.before');
  await hold.dispatchEvent('pointerup');
  check('Hold: before shows the earlier version', true);

  /* 11. playback runs and the preview keeps up */
  await page.evaluate(() => document.activeElement?.blur());
  await page.click('button.play');
  const fps = await page.evaluate(() => new Promise(res => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else res(n / 2); }; requestAnimationFrame(f); }));
  await page.click('button.play');
  check('playback stays smooth', fps > 40, `${fps.toFixed(0)} fps`);

  /* 12. export with everything */
  const ex = await call('export_video');
  check('export finishes', /Exported/.test(ex.text), ex.text.split('\n')[0]);
  await page.screenshot({ path: path.join(outDir, 'e2e-3-final.png') });
  check('no errors in the browser console', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('test run', false, e.stack);
} finally {
  await agent.close().catch(() => {});
  await browser.close();
}
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

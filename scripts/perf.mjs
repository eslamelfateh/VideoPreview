/**
 * Load test: a long video cut into hundreds of pieces with hundreds of captions.
 * Measures upload, analysis, agent edits, state size, browser frame rate, edit
 * latency, and export time. Needs a running server, Playwright, ffmpeg.
 * Usage: node scripts/perf.mjs <long-video> [out-dir]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright')); }

const BASE = process.env.LIVECUT_URL ?? 'http://127.0.0.1:4317';
const [video, outDir = '.'] = process.argv.slice(2);
const api = (p, body) => fetch(`${BASE}/api${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 600000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(250); } return null; }
const timed = async (label, fn) => { const t = performance.now(); const r = await fn(); console.log(`${label}: ${((performance.now() - t) / 1000).toFixed(2)}s`); return r; };

await api('/reset', {});
await timed('upload', async () => {
  const form = new FormData();
  form.append('files', new Blob([fs.readFileSync(video)]), path.basename(video));
  const r = await fetch(`${BASE}/api/media`, { method: 'POST', body: form });
  if (!r.ok) throw new Error(await r.text());
});
let s = await api('/state');
const media = s.project.media[0];
console.log(`media: ${media.duration}s ${media.width}x${media.height}`);
await timed('thumbnails + waveform', () => until(async () => { const a = (await api('/state')).assets[media.id]; return a?.thumbs && a?.peaks; }));

// Word timings from the speech regions.
const err = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', video, '-af', 'silencedetect=n=-30dB:d=0.2', '-vn', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
const sEnds = [...err.matchAll(/silence_end: ([\d.]+)/g)].map(m => +m[1]);
const sStarts = [...err.matchAll(/silence_start: ([\d.]+)/g)].map(m => +m[1]);
const words = [];
let from = 0;
const vocab = 'النهارده هوريكم إزاي تعدّلوا الفيديو بجملة واحدة من غير ما تفتحوا أي برنامج'.split(' ');
for (let i = 0; i < sStarts.length; i++) {
  const a = from, b = sStarts[i];
  for (let k = 0, n = Math.max(1, Math.round((b - a) / 0.32)); k < n; k++) words.push({ text: vocab[words.length % vocab.length], start: +(a + (k * (b - a)) / n).toFixed(3), end: +(a + ((k + 0.85) * (b - a)) / n).toFixed(3) });
  from = sEnds[i] ?? b;
}
console.log(`transcript: ${words.length} words`);

const agent = new Client({ name: 'perf', version: '0' });
await agent.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
const call = async (name, args = {}) => { const r = await agent.callTool({ name, arguments: args }, undefined, { timeout: 3_600_000 }); const t = r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'); if (r.isError) throw new Error(t); return t; };

await timed('set_transcript', () => call('set_transcript', { mediaId: media.id, words }));
console.log(await timed('remove_silences', () => call('remove_silences', { minPause: 0.3 })));
console.log(await timed('add_captions', () => call('add_captions', { wordsPerCaption: 3 })));
s = await api('/state');
const D = s.project.clips.reduce((m, c) => Math.max(m, c.start + c.out - c.in), 0);
await timed('20 zooms', async () => { for (let k = 0; k < 20; k++) { const t = (D * (k + 0.5)) / 20; await call('add_zoom', { start: t, end: t + 1.5, scale: 1.3 }); } });
s = await api('/state');
const size = JSON.stringify(s).length;
console.log(`timeline: ${D.toFixed(1)}s, ${s.project.clips.length} clips, ${s.project.texts.length} captions, ${s.project.effects.length} zooms, ${s.steps.length} steps; state message ${(size / 1024).toFixed(0)} KB`);

/* browser */
const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
const loadT = performance.now();
await page.goto(BASE);
await page.waitForSelector('.lane .item.t');
console.log(`editor ready: ${((performance.now() - loadT) / 1000).toFixed(2)}s`);
await page.waitForTimeout(1500);

const measure = () => page.evaluate(() => new Promise(res => {
  const frames = []; let last = performance.now(); const t0 = last;
  const f = now => { frames.push(now - last); last = now; if (now - t0 < 3000) requestAnimationFrame(f); else { frames.sort((a, b) => a - b); res({ fps: frames.length / 3, p95: frames[Math.floor(frames.length * 0.95)], worst: frames[frames.length - 1] }); } };
  requestAnimationFrame(f);
}));
await page.evaluate(() => { window.__stalls = 0; window.__cuts = 0; let last = ''; document.querySelectorAll('video').forEach(v => v.addEventListener('waiting', () => window.__stalls++)); setInterval(() => { const on = document.querySelector('video.on'); const k = on ? on.src + [...document.querySelectorAll('video')].indexOf(on) : ''; if (k !== last) { window.__cuts++; last = k; } }, 16); });
await page.click('button.play');
const play = await measure();
await page.click('button.play');
const st = await page.evaluate(() => ({ stalls: window.__stalls, cuts: window.__cuts }));
console.log(`playback: ${play.fps.toFixed(0)} fps, p95 frame ${play.p95.toFixed(1)}ms, worst ${play.worst.toFixed(0)}ms; ${st.cuts} cuts played, ${st.stalls} video stalls`);

// Zoom the timeline in and scrub.
for (let k = 0; k < 4; k++) await page.click('button[aria-label="Zoom in timeline"]');
const lanes = await page.locator('.tl-lanes').boundingBox();
const scrubT = performance.now();
await page.mouse.move(lanes.x + 20, lanes.y + 250); await page.mouse.down();
for (let k = 0; k < 30; k++) await page.mouse.move(lanes.x + 20 + k * 25, lanes.y + 250);
await page.mouse.up();
console.log(`scrub 30 moves: ${((performance.now() - scrubT)).toFixed(0)}ms`);

// Edit latency: change a caption's color and wait for it to come back from the server.
await page.locator('.lane .item.t').first().click();
const latT = performance.now();
await page.locator('#text-color').evaluate(el => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '#ff0000'); el.dispatchEvent(new Event('input', { bubbles: true })); });
await page.waitForFunction(() => document.querySelector('#text-color')?.value === '#ff0000');
const ok = await until(async () => (await api('/state')).project.texts.some(t => t.color === '#ff0000'), 10000);
console.log(`edit round trip: ${(performance.now() - latT).toFixed(0)}ms ${ok ? '' : '(not applied!)'}`);
await page.screenshot({ path: path.join(outDir, 'perf-editor.png') });
await browser.close();

const dr = await timed('export (draft)', () => call('export_video', { quality: 'draft' }));
console.log(dr.split('\n')[0]);
const ex = await timed('export (final)', () => call('export_video'));
console.log(ex.split('\n')[0]);
console.log(errors.length ? `browser errors: ${errors.join(' | ')}` : 'no browser errors');
await agent.close();

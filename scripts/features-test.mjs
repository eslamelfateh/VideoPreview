/**
 * Checks the editing features end to end through MCP and the editor API:
 * proxies, local transcription (with scripts/fake_whisper.py), ducking, loudness,
 * noise reduction, undo of project settings, and the features added after them.
 * Usage: node scripts/features-test.mjs <video-with-speech> <music> [out-dir]
 * Server: WHISPER_SCRIPT=scripts/fake_whisper.py LIVECUT_WAIT_MS=5000 npm start
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.LIVECUT_URL ?? 'http://127.0.0.1:4317';
const [video, music, outDir = '.'] = process.argv.slice(2);
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`); };
const api = (p, body) => fetch(`${BASE}/api${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 60000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(200); } return null; }
const client = new Client({ name: 'features-test', version: '0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000, resetTimeoutOnProgress: true, onprogress: () => {} });
  return { ...r, text: r.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '' };
};
const upload = async (...files) => {
  const form = new FormData();
  for (const f of files) form.append('files', new Blob([fs.readFileSync(f)]), path.basename(f));
  const r = await fetch(`${BASE}/api/media`, { method: 'POST', body: form });
  if (!r.ok) throw new Error(await r.text());
};
const exportDraft = async () => {
  let r = await call('export_video', { quality: 'draft' });
  while (r.structuredContent?.status === 'rendering') r = await call('get_export_status', { wait_seconds: 100 });
  return r.structuredContent;
};
const lufs = file => Number(/I:\s+(-?[\d.]+) LUFS/.exec(spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.split('Summary').pop())?.[1]);
const exportFile = url => path.join(process.env.LIVECUT_DATA ?? path.join(outDir, 'data'), 'exports', url.split('/').pop());

try {
  await api('/reset', {});
  await upload(video, music);
  let s = await api('/state');
  const v = s.project.media.find(m => m.kind === 'video');
  const vClip = s.project.clips.find(c => c.track === 'video');

  /* proxies */
  const proxy = await until(async () => (await api('/state')).assets[v.id]?.proxy, 90000);
  check('a preview proxy is generated', !!proxy, proxy ? `${proxy.height}p` : 'timeout');
  if (proxy) {
    const info = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=height', '-of', 'csv=p=0', path.join(process.env.LIVECUT_DATA ?? path.join(outDir, 'data'), 'media', proxy.file)], { encoding: 'utf8' }).stdout.trim();
    check('proxy is small', Number(info) <= 540, `${info}p`);
  }

  /* local transcription (fake model) with progress */
  const gp = await call('get_project');
  check('agent sees which transcription engine runs', /local Whisper/.test(gp.structuredContent.transcription), gp.structuredContent.transcription);
  const tr = await call('transcribe', { mediaId: v.id, language: 'ar' });
  check('local transcription returns words', tr.structuredContent?.status === 'applied' && /Transcribed .*: \d+ words/.test(tr.text), tr.text.split('\n')[0]);
  const words = (await call('get_transcript', { limit: 5 })).text;
  check('transcript has timed words', /^\d+\.\d\d-\d+\.\d\d /.test(words));

  /* ducking: mute the voice, measure the music in speech vs. pauses */
  await call('update_clip', { clipId: vClip.id, volume: 0 });
  const base = (await call('get_audio_levels', { step: 0.5 })).structuredContent.levels;
  const duck = await call('set_ducking', { amount: -12 });
  check('set_ducking', duck.structuredContent.status === 'applied', duck.text.split('\n')[0]);
  s = await api('/state');
  check('the editor gets speech regions for the preview', s.speech.length > 0, `${s.speech.length} regions`);
  const ducked = (await call('get_audio_levels', { step: 0.5 })).structuredContent.levels;
  const inSpeech = (t) => s.speech.some(([a, b]) => t >= a + 0.4 && t + 0.5 <= b - 0.1);
  const outSpeech = (t) => s.speech.every(([a, b]) => t + 0.5 < a - 0.4 || t > b + 0.7);
  const diff = (pred) => { const xs = base.map((l, i) => [l, ducked[i]]).filter(([l]) => pred(l.t)).map(([l, d]) => l.rms - d.rms); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; };
  const dSpeech = diff(inSpeech), dPause = diff(outSpeech);
  check('music drops ~12 dB while people talk', dSpeech > 10 && dSpeech < 14, `${dSpeech.toFixed(1)} dB`);
  check('music stays up in pauses', Number.isNaN(dPause) || dPause < 2, Number.isNaN(dPause) ? 'no long pause' : `${dPause.toFixed(1)} dB`);
  await call('update_clip', { clipId: vClip.id, volume: 1 });

  /* loudness */
  const ln = await call('normalize_loudness', { target: -14 });
  check('normalize_loudness measures and sets a gain', ln.structuredContent.status === 'applied', ln.text.split('\n')[0]);
  const ex = await exportDraft();
  const measured = lufs(exportFile(ex.url));
  check('the export hits -14 LUFS', Math.abs(measured + 14) <= 1.2, `${measured} LUFS`);

  /* noise reduction */
  const dn = await call('set_denoise', { enabled: true, track: 'video' });
  check('set_denoise', dn.structuredContent.status === 'applied' && (await api('/state')).project.clips.find(c => c.track === 'video').denoise === true);
  const ex2 = await exportDraft();
  check('export with noise reduction works', ex2.status === 'done');

  /* caption styles: every preset and position renders, preview and export side by side */
  await call('add_captions', { wordsPerCaption: 3 });
  const capT = (await api('/state')).project.texts.find(t => t.style === 'caption' && t.words?.length >= 2);
  const at = (capT.words[1].start + capT.words[1].end) / 2;
  const shots = [];
  for (const [preset, position] of [['karaoke', 'bottom'], ['box', 'bottom'], ['pop', 'middle'], ['minimal', 'bottom'], ['bold', 'top']]) {
    const r = await call('set_caption_style', { preset, position });
    const f = await call('get_frame', { time: at, width: 360 });
    const img = f.content.find(c => c.type === 'image');
    const file = path.join(outDir, `style-${preset}.png`);
    if (img) fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
    shots.push(file);
    check(`caption style ${preset} at the ${position}`, r.structuredContent.status === 'applied' && !!img);
  }
  spawnSync('ffmpeg', ['-v', 'error', '-y', ...shots.flatMap(f => ['-i', f]), '-filter_complex', `hstack=inputs=${shots.length}`, path.join(outDir, 'styles.png')]);
  const pop = (await api('/state')).project.texts.find(t => t.style === 'caption');
  check('styles are stored on captions', pop.preset === 'bold' && pop.position === 'top');
  await call('set_caption_style', { preset: 'karaoke', position: 'bottom' });

  /* project settings are undoable */
  await call('set_canvas', { width: 1920, height: 1080 });
  const before = (await api('/state')).project.width;
  await api('/undo-last', {});
  const after = (await api('/state')).project.width;
  check('undo reverts a canvas change', before === 1920 && after === 1080);
} catch (e) {
  check('test run', false, e.stack);
} finally {
  await client.close();
}
const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

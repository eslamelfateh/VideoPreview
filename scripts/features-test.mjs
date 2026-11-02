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

  /* speed and transitions */
  {
    await api('/reset', {});
    await upload(video);
    const sv = (await api('/state')).project;
    const mid = sv.media[0].id;
    await call('transcribe', { mediaId: mid, language: 'ar' });
    await call('add_captions', { wordsPerCaption: 2 });
    const before = await api('/state');
    const D0 = before.project.clips[0].out - before.project.clips[0].in;
    const capAfter = before.project.texts.find(t => t.start >= 7);
    const capInside = before.project.texts.find(t => t.start >= 2.5 && t.end <= 5.5);
    const sp = await call('set_speed', { start: 2, end: 6, speed: 2 });
    const after = await api('/state');
    const D1 = after.project.clips.reduce((m, c) => Math.max(m, c.start + (c.out - c.in) / (c.speed ?? 1)), 0);
    check('set_speed 2× over 4 s makes the video 2 s shorter', Math.abs((D0 - D1) - 2) < 0.02, `${D0.toFixed(2)} → ${D1.toFixed(2)} s (${sp.text.split('\n')[0]})`);
    const ca = after.project.texts.find(t => t.id === capAfter.id), ci = after.project.texts.find(t => t.id === capInside.id);
    check('captions after the change move 2 s earlier', Math.abs((capAfter.start - ca.start) - 2) < 0.02);
    check('captions inside the change are compressed 2×', Math.abs((ci.start - 2) - (capInside.start - 2) / 2) < 0.02 && Math.abs((ci.end - ci.start) - (capInside.end - capInside.start) / 2) < 0.02);
    const ex4 = await exportDraft();
    const dur = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', exportFile(ex4.url)], { encoding: 'utf8' }).stdout);
    const adur = Number(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=duration', '-of', 'csv=p=0', exportFile(ex4.url)], { encoding: 'utf8' }).stdout);
    check('export length matches the faster timeline (video and audio)', Math.abs(dur - D1) < 0.1 && Math.abs(adur - D1) < 0.1, `video ${dur.toFixed(2)} s, audio ${adur.toFixed(2)} s, timeline ${D1.toFixed(2)} s`);
    // A sine tone at 300 Hz would shift to 600 Hz without pitch correction; speech energy should stay where it was.
    const vclip = after.project.clips.find(c => c.track === 'video' && c.start <= 8 && c.start + (c.out - c.in) / (c.speed ?? 1) > 9);
    const cutAt = 8;
    await call('split_clip', { clipId: vclip.id, at: cutAt });
    const tr2 = await call('add_transition', { at: cutAt, duration: 1 });
    check('add_transition at a cut', tr2.structuredContent.status === 'applied', tr2.text.split('\n')[0]);
    const luma = (t) => { const f = path.join(outDir, `dip-${t}.png`); const r = call('get_frame', { time: t, width: 270 }); return r; };
    const atCut = await luma(cutAt), before1 = await luma(cutAt - 0.9);
    const yavg = (r) => { const img = r.content.find(c => c.type === 'image'); const f = path.join(outDir, 'y.png'); fs.writeFileSync(f, Buffer.from(img.data, 'base64')); return Number(/YAVG=([\d.]+)/.exec(spawnSync('ffmpeg', ['-hide_banner', '-i', f, '-vf', 'signalstats,metadata=print', '-f', 'null', '-'], { encoding: 'utf8' }).stderr)?.[1]); };
    const yCut = yavg(atCut), yBefore = yavg(before1);
    check('the frame at the cut is dark, the frame before is not', yCut < 25 && yBefore > 60, `brightness ${yCut} at the cut, ${yBefore} before`);
    const ex5 = await exportDraft();
    const yExp = Number(/YAVG=([\d.]+)/.exec(spawnSync('ffmpeg', ['-hide_banner', '-ss', String(cutAt), '-i', exportFile(ex5.url), '-frames:v', '1', '-vf', 'signalstats,metadata=print', '-f', 'null', '-'], { encoding: 'utf8' }).stderr)?.[1]);
    check('the export dips to black at the cut', yExp < 25, `brightness ${yExp}`);
  }

  /* B-roll: full frame and picture-in-picture, checked against the source pixels */
  if (process.env.LANDSCAPE) {
    await api('/reset', {});
    await upload(video);
    const imp = await call('import_media', { path: process.env.LANDSCAPE });
    const brollId = imp.structuredContent.created.find(c => c.kind === 'media').id;
    const b1 = await call('add_broll', { mediaId: brollId, start: 2, end: 4 });
    const b2 = await call('add_broll', { mediaId: brollId, start: 6, end: 8, in: 3, layout: 'pip-top-right' });
    const st = await api('/state');
    check('add_broll full frame and picture-in-picture', b1.structuredContent.status === 'applied' && b2.structuredContent.status === 'applied' && st.project.clips.filter(c => c.track === 'overlay').length === 2 && st.project.clips.find(c => c.track === 'overlay').volume === 0);
    const ex6 = await exportDraft();
    const out = exportFile(ex6.url);
    const cmp = (t, srcT, region, expect) => {
      const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(t), '-i', out, '-ss', String(srcT), '-i', expect === 'broll' ? process.env.LANDSCAPE : video, '-frames:v', '1', '-filter_complex',
        `[0:v]crop=${region}[o];[1:v]${expect === 'broll' ? (region.startsWith('1080') ? 'scale=-2:1920,crop=1080:1920' : 'scale=-2:480,crop=378:480') : 'scale=1080:-2,crop=1080:1920'}${expect === 'main' && !region.startsWith('1080') ? ',crop=' + region : ''},format=yuv420p[r];[o]format=yuv420p[o2];[o2][r]psnr`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
      return Number(/average:([\d.]+|inf)/.exec(r)?.[1].replace('inf', '99'));
    };
    const full = cmp(3, 1, '1080:1920:0:0', 'broll'), fullWrong = cmp(3, 3, '1080:1920:0:0', 'main');
    check('full-frame B-roll covers the picture', full > 25 && full > fullWrong + 8, `PSNR ${full.toFixed(1)} vs ${fullWrong.toFixed(1)} for the main video`);
    const pip = cmp(7, 4, '378:480:648:115', 'broll');
    check('picture-in-picture sits in the top-right box', pip > 22, `PSNR ${pip.toFixed(1)} dB in the box`);
    const outside = cmp(7, 7, '540:960:0:960', 'main');
    check('the main video shows outside the box', outside > 22, `PSNR ${outside.toFixed(1)} dB`);
    const fr = await call('get_frame', { time: 7, width: 360 });
    const img = fr.content.find(c => c.type === 'image');
    if (img) fs.writeFileSync(path.join(outDir, 'broll-frame.png'), Buffer.from(img.data, 'base64'));
    check('get_frame shows B-roll', !!img);
    const rs = await call('cut_range', { start: 0.5, end: 1.5 });
    const ov = (await api('/state')).project.clips.filter(c => c.track === 'overlay').sort((a, b) => a.start - b.start);
    check('B-roll moves with cuts', rs.structuredContent.status === 'applied' && Math.abs(ov[0].start - 1) < 0.01 && Math.abs(ov[1].start - 5) < 0.01, ov.map(c => c.start).join(', '));
  }

  /* reframing landscape footage onto the vertical canvas */
  const landscape = process.env.LANDSCAPE;
  if (landscape) {
    await api('/reset', {});
    await call('set_canvas', { width: 1080, height: 1920 });
    const r1 = await fetch(`${BASE}/api/media`, { method: 'POST', body: (() => { const f = new FormData(); f.append('files', new Blob([fs.readFileSync(landscape)]), 'landscape.mp4'); return f; })() });
    if (!r1.ok) throw new Error(await r1.text());
    await call('set_canvas', { width: 1080, height: 1920 });
    const src = await call('get_source_frame', { time: 2 });
    const simg = src.content.find(c => c.type === 'image');
    if (simg) fs.writeFileSync(path.join(outDir, 'source-frame.png'), Buffer.from(simg.data, 'base64'));
    check('get_source_frame shows the whole frame with the crop window', !!simg && /crop window at x 0.50/.test(src.text), src.text.split(';')[0]);
    const rk = await call('set_reframe', { keys: [{ time: 0, x: 0 }, { time: 4, x: 1 }] });
    check('set_reframe', rk.structuredContent.status === 'applied');
    // The export must show exactly the left edge at 0 s and the right edge at 4 s+ of the source.
    const ex3 = await exportDraft();
    const out = exportFile(ex3.url);
    const psnr = (t, x) => {
      const cropX = x === 0 ? '0' : 'iw-ow';
      const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(t), '-i', out, '-ss', String(t), '-i', landscape, '-frames:v', '1', '-filter_complex',
        `[1:v]scale=-2:1920,crop=1080:1920:${cropX}:0,format=yuv420p[ref];[0:v]format=yuv420p[o];[o][ref]psnr`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
      return Number(/average:([\d.]+|inf)/.exec(r)?.[1].replace('inf', '99'));
    };
    // Draft exports are lossy, so compare against the wrong side rather than an absolute score.
    const pLeft = psnr(0, 0), pLeftWrong = psnr(0, 1), pRight = psnr(5, 1), pWrong = psnr(5, 0);
    check('export crops the left edge at the start', pLeft > 25 && pLeft > pLeftWrong + 8, `PSNR ${pLeft.toFixed(1)} dB vs ${pLeftWrong.toFixed(1)} for the right edge`);
    check('export pans to the right edge by 4 s', pRight > 25 && pRight > pWrong + 8, `PSNR ${pRight.toFixed(1)} dB vs ${pWrong.toFixed(1)} for the left edge`);
    const mid = await call('get_frame', { time: 2 });
    check('frames mid-pan render', mid.content.some(c => c.type === 'image'));
    const undoKey = await call('set_reframe_key', { time: 4, remove: true });
    check('remove one reframe key', undoKey.structuredContent.status === 'applied' && (await api('/state')).project.reframe.length === 1);
  }

  /* versions: make two, switch, undo the switch */
  {
    await api('/reset', {});
    await upload(video);
    const mid = (await api('/state')).project.media[0].id;
    await call('transcribe', { mediaId: mid, language: 'ar' });
    await call('add_captions', {});
    const a = await call('save_version', { name: 'A - karaoke' });
    await call('set_caption_style', { preset: 'bold', position: 'top' });
    await call('add_zoom', { start: 1, end: 2 });
    await call('save_version', { name: 'B - bold + zoom' });
    const list = await call('list_versions');
    check('two versions saved', list.structuredContent.versions.length === 2, list.text.split('\n').map(l => l.split('"')[1]).join(' / '));
    const ld = await call('load_version', { version: 'A - karaoke' });
    const sA = (await api('/state')).project;
    check('load_version switches the timeline', ld.structuredContent.status === 'applied' && sA.effects.length === 0 && !sA.texts.some(t => t.preset === 'bold'));
    await api('/undo-last', {});
    const sB = (await api('/state')).project;
    check('undo goes back to the other version', sB.effects.length === 1 && sB.texts.every(t => t.preset === 'bold'));
    const ui = await api(`/versions/${a.structuredContent.id}/load`, {});
    check('the editor can open a version too', /Switched to version "A - karaoke"/.test(ui.summary ?? ''));
    check('the editor sees the version list', (await api('/state')).versions.length === 2);
  }

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

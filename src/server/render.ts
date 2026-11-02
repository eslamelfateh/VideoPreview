import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTION_PRESETS, clipEnd, clipLen, DUCK_GAP, duration, POSITION_MARGIN, positionOf, presetOf, speechRegions, TEXT_LAYOUT as L } from '../shared/timeline.js';
import type { Clip, Media, Project, TextItem, ZoomEffect } from '../shared/types.js';
import { FFMPEG, mediaPath } from './media.js';
import { EXPORT_DIR, store } from './store.js';

export const FONTS_DIR = path.resolve(fileURLToPath(import.meta.url), '../../../assets/fonts');
const n = (x: number) => (Math.round(x * 1000) / 1000).toString();

/* ---------- captions and titles as ASS subtitles (libass handles Arabic shaping and RTL) ---------- */

const assTime = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60, c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
};
const assColor = (hex = '#ffffff') => {
  const h = hex.replace('#', '').padEnd(6, 'f');
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
};
const assText = (s: string) => s.replace(/[{}\\]/g, '').replace(/\n/g, '\\N');

/** Splits a caption into one event per spoken word, with that word highlighted (same rule as the live preview). */
export function captionFrames(t: TextItem): { start: number; end: number; active: number }[] {
  const ws = t.words ?? [];
  if (!ws.length) return [{ start: t.start, end: t.end, active: -1 }];
  return ws.map((w, i) => ({ start: i === 0 ? t.start : w.start, end: i === ws.length - 1 ? t.end : ws[i + 1].start, active: i }));
}

export function buildAss(p: Project): string {
  const W = p.width, H = p.height, base = Math.min(W, H), side = Math.round(W * L.side);
  const ALIGN = { bottom: 2, middle: 5, top: 8 } as const;
  const styles = new Map<string, string>();
  const style = (name: string, size: number, outline: number, box: boolean, primary: string, pos: keyof typeof ALIGN) => {
    if (!styles.has(name)) styles.set(name, `Style: ${name},${L.font},${size},${assColor(primary)},&H00FFFFFF,${box ? '&H60000000' : '&H00000000'},&H64000000,1,0,0,0,100,100,0,0,${box ? 3 : 1},${outline},${box ? 0 : Math.round(size * 0.05)},${ALIGN[pos]},${side},${side},${Math.round(H * POSITION_MARGIN[pos])},1`);
    return name;
  };
  const events: string[] = [];
  for (const t of p.texts) {
    const pos = positionOf(t);
    if (t.style === 'title') {
      const size = Math.round(base * L.titleSize);
      const st = style(`Title_${pos}`, size, Math.round(size * L.outline), false, '#ffffff', pos);
      events.push(`Dialogue: 1,${assTime(t.start)},${assTime(t.end)},${st},,0,0,0,,{\\c${assColor(t.color)}&}${assText(t.text)}`);
      continue;
    }
    const P = presetOf(t), preset = t.preset ?? 'karaoke';
    const size = Math.round(base * P.size);
    const st = style(`Cap_${preset}_${pos}`, size, Math.round(size * P.outline), P.box, P.base, pos);
    const active = t.color ?? P.active ?? L.highlight;
    const dim = P.dim < 1 ? `{\\alpha&H${Math.round((1 - P.dim) * 255).toString(16).padStart(2, '0').toUpperCase()}&}` : '';
    const words = t.words?.length ? t.words.map(w => w.text) : [t.text];
    for (const f of captionFrames(t)) {
      if (f.end <= f.start) continue;
      const on = (w: string) => `{\\c${assColor(active)}&\\alpha&H00&${P.activeScale !== 1 ? `\\fscx${Math.round(P.activeScale * 100)}\\fscy${Math.round(P.activeScale * 100)}` : ''}}${assText(w)}{\\r}`;
      const text = P.oneWord && f.active >= 0
        ? on(words[f.active])
        : words.map((w, i) => (i === f.active ? on(w) : dim + assText(w) + (dim ? '{\\alpha&H00&}' : ''))).join(' ');
      events.push(`Dialogue: 0,${assTime(f.start)},${assTime(f.end)},${st},,0,0,0,,${text}`);
    }
  }
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles.values(), '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
  ].join('\n') + '\n';
}

/* ---------- zoom: zoompan only over the zoomed parts, the rest passes through untouched ---------- */

function zoomFilter(effects: ZoomEffect[], W: number, H: number, fps: number, offset: number): string {
  // Smoothstep ramp, identical to the preview. `it` is time inside the segment; offset makes it timeline time.
  const T = `(it+${n(offset)})`;
  const z = effects.map(e => {
    const r = Math.max(0.001, e.ease);
    const x = `clip(min((${T}-${n(e.start)})/${n(r)},(${n(e.end)}-${T})/${n(r)}),0,1)`;
    return `if(between(${T},${n(e.start)},${n(e.end)}),1+(${n(e.scale)}-1)*${x}*${x}*(3-2*${x}),1)`;
  });
  const zexpr = z.reduce((acc, e) => `max(${acc},${e})`, '1');
  const anchor = (k: 'anchorX' | 'anchorY', dflt: number) =>
    effects.reduceRight((acc, e) => `if(between(${T},${n(e.start)},${n(e.end)}),${n(e[k])},${acc})`, String(dflt));
  // Upscale first so slow zooms do not jitter on whole-pixel crop positions.
  return `scale=${W * 2}:${H * 2}:flags=bicubic,zoompan=z='${zexpr}':x='(iw-iw/zoom)*${anchor('anchorX', 0.5)}':y='(ih-ih/zoom)*${anchor('anchorY', 0.4)}':d=1:s=${W}x${H}:fps=${fps}`;
}

/** Merged, frame-aligned time ranges that contain at least one zoom. */
function zoomGroups(effects: ZoomEffect[], fps: number, D: number) {
  const g: { s: number; e: number; fx: ZoomEffect[] }[] = [];
  for (const e of [...effects].sort((a, b) => a.start - b.start)) {
    const s = Math.max(0, Math.floor(e.start * fps) / fps), en = Math.min(D, Math.ceil(e.end * fps) / fps);
    if (en <= s) continue;
    const last = g[g.length - 1];
    if (last && s <= last.e) { last.e = Math.max(last.e, en); last.fx.push(e); } else g.push({ s, e: en, fx: [e] });
  }
  return g;
}

/* ---------- clips, grouped into runs that read one file once ---------- */

interface Seg { clip: Clip; sF: number; lF: number; iF: number }
interface Run { mediaId: string; segs: Seg[] }

/**
 * Clips are snapped to the frame grid and grouped into runs: back-to-back clips of
 * the same file going forward in time (what silence removal produces). Each run is
 * decoded once and frames/audio blocks are picked by frame number, so a 10-minute
 * video cut into hundreds of pieces is still a single input with exact A/V sync.
 */
function runsFor(clips: Clip[], fps: number, media: Map<string, Media>): Run[] {
  const runs: Run[] = [];
  // Start and end are rounded separately, so clips that touch in seconds also touch in frames.
  const segs = clips.map(c => { const sF = Math.round(c.start * fps); return { clip: c, sF, lF: Math.max(1, Math.round(clipEnd(c) * fps) - sF), iF: Math.round(c.in * fps) }; })
    .sort((a, b) => a.sF - b.sF);
  for (const s of segs) {
    const last = runs[runs.length - 1], prev = last?.segs[last.segs.length - 1];
    const srcEnd = prev ? prev.iF + prev.lF : 0;
    const joinable = prev && last.mediaId === s.clip.mediaId && media.get(s.clip.mediaId)?.kind !== 'image'
      && s.sF === prev.sF + prev.lF && s.iF >= srcEnd - 1;
    if (joinable) {
      if (s.iF < srcEnd) s.iF = srcEnd; // a one-frame rounding overlap: take the next source frame instead
      last.segs.push(s);
    } else runs.push({ mediaId: s.clip.mediaId, segs: [s] });
  }
  return runs;
}

/** Volume over a run's output time: 1 everywhere except clips with another level or fades. */
function gainExpr(run: Run, fps: number): string | null {
  const t0 = run.segs[0].sF;
  const terms: string[] = [];
  let pos = 0;
  for (const s of run.segs) {
    const c = s.clip, a = pos / fps, b = (pos + s.lF) / fps;
    pos += s.lF;
    if (c.volume === 1 && !c.fadeIn && !c.fadeOut) continue;
    let g = n(c.volume);
    if (c.fadeIn) g += `*min(1,(t-${n(a)})/${n(c.fadeIn)})`;
    if (c.fadeOut) g += `*min(1,(${n(b)}-t)/${n(c.fadeOut)})`;
    terms.push(`between(t,${n(a)},${n(b)})*(${g}-1)`);
  }
  void t0;
  return terms.length ? `max(0,1+${terms.join('+')})` : null;
}

/** The ducking curve (same as duckFactor in the preview) over a run, in the run's own time. */
function duckExpr(p: Project, from: number, to: number): string | null {
  const d = p.audio?.duck;
  if (!d) return null;
  const regions = speechRegions(p, DUCK_GAP).filter(([s, e]) => e + d.release > from && s - d.attack < to);
  if (!regions.length) return null;
  const T = `(t+${n(from)})`, f = Math.pow(10, d.amount / 20);
  const a = Math.max(0.001, d.attack), r = Math.max(0.001, d.release);
  const terms = regions.map(([s, e]) => `clip(min((${T}-${n(s - d.attack)})/${n(a)},(${n(e + d.release)}-${T})/${n(r)}),0,1)`);
  return `(1-${n(1 - f)}*min(1,${terms.join('+')}))`;
}

/* ---------- full ffmpeg command ---------- */

export type Quality = 'final' | 'draft';

export type Output = { kind: 'mp4'; quality: Quality } | { kind: 'png'; width: number } | { kind: 'wav'; rate?: number; channels?: number };

export function buildCommand(p: Project, out: string, assFile: string, quality: Quality | Output = 'final'): string[] {
  const o: Output = typeof quality === 'string' ? { kind: 'mp4', quality } : quality;
  const W = p.width, H = p.height, fps = p.fps, D = Math.max(0.1, duration(p));
  const SR = 48000, spf = Math.round(SR / fps); // audio samples per video frame
  const media = new Map(p.media.map(m => [m.id, m]));
  const args = ['-y', '-v', 'error', '-progress', 'pipe:1', '-nostats'];
  const f: string[] = [];
  const audio: string[] = [];
  let idx = 0, base = 'base0', ov = 0;

  const vRuns = runsFor(p.clips.filter(c => c.track === 'video' && media.has(c.mediaId) && clipLen(c) > 0), fps, media);
  // One run from the very start: use it directly (padded with black to the end) instead of compositing onto black.
  const fullCover = vRuns.length === 1 && vRuns[0].segs[0].sF === 0 && media.get(vRuns[0].mediaId)?.kind === 'video';
  const padTo = fullCover ? Math.round(D * fps) - vRuns[0].segs.reduce((a, s) => a + s.lF, 0) : 0;
  const wantV = o.kind !== 'wav', wantA = o.kind !== 'png';
  const pick = (segs: Seg[], first: number) => segs.map(s => `between(n,${s.iF - first},${s.iF - first + s.lF - 1})`).join('+');

  for (const track of ['video', 'audio'] as const) {
    const clips = p.clips.filter(c => c.track === track && media.has(c.mediaId) && clipLen(c) > 0);
    for (const run of runsFor(clips, fps, media)) {
      const m = media.get(run.mediaId)!;
      const first = run.segs[0], lastSeg = run.segs[run.segs.length - 1];
      const startT = first.sF / fps, frames = run.segs.reduce((a, s) => a + s.lF, 0);
      const srcFrom = first.iF / fps, srcTo = (lastSeg.iF + lastSeg.lF) / fps;
      if (m.kind === 'image') args.push('-loop', '1', '-framerate', String(fps), '-t', n(frames / fps), '-i', mediaPath(m));
      else args.push('-ss', n(srcFrom), '-t', n(srcTo - srcFrom + 1 / fps), '-i', mediaPath(m));
      const i = idx++;
      const single = run.segs.length === 1;
      if (wantV && track === 'video' && m.kind !== 'audio') {
        const sel = single ? `trim=end_frame=${frames},` : `select='${pick(run.segs, first.iF)}',`;
        f.push(`[${i}:v]fps=${fps},${sel}setpts=N/${fps}/TB+${n(startT)}/TB,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p[v${i}]`);
        if (fullCover) {
          if (padTo > 0) { f.push(`[v${i}]tpad=stop=${padTo}:stop_mode=add:color=black[vp${i}]`); base = `vp${i}`; } else base = `v${i}`;
        }
        else {
          f.push(`[${base}][v${i}]overlay=eof_action=pass:enable='between(t,${n(startT)},${n(startT + frames / fps)})'[ov${++ov}]`);
          base = `ov${ov}`;
        }
      }
      if (wantA && m.hasAudio && run.segs.some(s => s.clip.volume > 0)) {
        const sel = single ? `atrim=end_sample=${frames * spf},` : `asetnsamples=n=${spf}:p=1,aselect='${pick(run.segs, first.iF)}',`;
        const gain = gainExpr(run, fps);
        const duck = track === 'audio' ? duckExpr(p, startT, startT + frames / fps) : null;
        const vol = [gain, duck].filter(Boolean).join('*');
        const clean = run.segs.some(s => s.clip.denoise) ? 'afftdn=nf=-25,' : '';
        f.push(`[${i}:a]aresample=${SR},${clean}asetpts=N/SR/TB,${sel}asetpts=N/SR/TB${vol ? `,volume='${vol}':eval=frame` : ''},adelay=${Math.round(startT * 1000)}:all=1[a${i}]`);
        audio.push(`[a${i}]`);
      }
    }
  }

  if (wantV && !fullCover) f.unshift(`color=c=black:s=${W}x${H}:r=${fps}:d=${n(D)}[base0]`);
  let v = base;
  if (wantV) {
    const groups = zoomGroups(p.effects.filter((e): e is ZoomEffect => e.kind === 'zoom'), fps, D);
    if (groups.length) {
      // Split the timeline into plain and zoomed parts; only zoomed parts pay for zoompan.
      const parts: { s: number; e: number; fx?: ZoomEffect[] }[] = [];
      let t = 0;
      for (const g of groups) { if (g.s > t) parts.push({ s: t, e: g.s }); parts.push(g); t = g.e; }
      if (t < D) parts.push({ s: t, e: D });
      f.push(`[${v}]split=${parts.length}${parts.map((_, k) => `[zs${k}]`).join('')}`);
      parts.forEach((pt, k) => {
        const trim = `trim=start=${n(pt.s)}:end=${n(pt.e)},setpts=PTS-STARTPTS`;
        f.push(`[zs${k}]${trim}${pt.fx ? ',' + zoomFilter(pt.fx, W, H, fps, pt.s) : ''},setsar=1,format=yuv420p[zp${k}]`);
      });
      f.push(`${parts.map((_, k) => `[zp${k}]`).join('')}concat=n=${parts.length}:v=1:a=0[vz]`);
      v = 'vz';
    }
    if (p.texts.length) {
      const esc = (s: string) => s.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
      f.push(`[${v}]ass='${esc(assFile)}':fontsdir='${esc(FONTS_DIR)}':shaping=complex[vt]`);
      v = 'vt';
    }
    f.push(`[${v}]${o.kind === 'png' ? `scale=${o.width}:-2,format=rgb24` : 'format=yuv420p'}[vout]`);
  }

  if (!wantA) { /* image only */ }
  else if (audio.length) {
    const master = p.audio?.loudness ? `,volume=${n(p.audio.loudness.gainDb)}dB,alimiter=limit=0.891:level=false` : '';
    f.push(`${audio.join('')}amix=inputs=${audio.length}:normalize=0:dropout_transition=0${master},apad=whole_dur=${n(D)},atrim=end=${n(D)}[aout]`);
  }
  else f.push(`anullsrc=r=${SR}:cl=stereo,atrim=end=${n(D)}[aout]`);

  const script = out + '.filter';
  fs.writeFileSync(script, f.join(';\n'));
  args.push('-filter_complex_script', script);
  if (o.kind === 'png') args.push('-map', '[vout]', '-frames:v', '1', '-update', '1', out);
  else if (o.kind === 'wav') args.push('-map', '[aout]', '-ac', String(o.channels ?? 1), '-ar', String(o.rate ?? 16000), '-c:a', 'pcm_s16le', '-t', n(D), out);
  else args.push('-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', o.quality === 'draft' ? 'ultrafast' : 'veryfast', '-crf', o.quality === 'draft' ? '25' : '20', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '160k', '-t', n(D), '-movflags', '+faststart', out);
  return args;
}

let current: ReturnType<typeof spawn> | null = null;
let job: Promise<string> | null = null;

/** Starts an export, or returns the one already running. */
export function startRender(quality: Quality = 'final'): Promise<string> {
  if (job) return job;
  job = renderProject(quality).finally(() => { job = null; });
  return job;
}
export const renderJob = () => job;

export async function renderProject(quality: Quality = 'final'): Promise<string> {
  if (current) throw new Error('An export is already running.');
  const p = structuredClone(store.project);
  if (!p.clips.length) throw new Error('The timeline is empty. Add a clip first.');
  const D = duration(p);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = `livecut-${stamp}${quality === 'draft' ? '-draft' : ''}.mp4`;
  const out = path.join(EXPORT_DIR, file);
  const assFile = path.join(EXPORT_DIR, `.${stamp}.ass`);
  fs.writeFileSync(assFile, buildAss(p));
  store.setRender({ status: 'rendering', progress: 0, file: undefined, error: undefined });

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, buildCommand(p, out, assFile, quality));
    current = proc;
    let err = '';
    let lastP = 0;
    proc.stdout!.on('data', (b: Buffer) => {
      const m = /out_time_us=(\d+)/.exec(b.toString());
      if (!m) return;
      const prog = Math.min(0.99, Number(m[1]) / 1e6 / D);
      if (prog - lastP >= 0.005) { lastP = prog; store.setRender({ progress: prog }); }
    });
    proc.stderr!.on('data', (b: Buffer) => { err += b.toString(); if (err.length > 20000) err = err.slice(-10000); });
    proc.on('close', code => {
      current = null;
      fs.rmSync(assFile, { force: true });
      fs.rmSync(out + '.filter', { force: true });
      if (code === 0) { store.setRender({ status: 'done', progress: 1, file }); resolve(file); }
      else { const e = err.trim().split('\n').slice(-6).join('\n') || `ffmpeg exited with ${code}`; store.setRender({ status: 'error', error: e }); reject(new Error(e)); }
    });
  });
}

/* ---------- small renders for the agent to look at and listen to ---------- */

/** The part of the project between s and e, shifted to start at 0. */
export function sliceProject(p: Project, s: number, e: number): Project {
  const clips: Clip[] = [];
  for (const c of p.clips) {
    const ce = clipEnd(c);
    if (ce <= s || c.start >= e) continue;
    const cut = Math.max(0, s - c.start);
    clips.push({ ...c, start: Math.max(0, c.start - s), in: c.in + cut, out: Math.min(c.out, c.in + (e - c.start)), fadeIn: undefined, fadeOut: undefined, volume: c.volume });
  }
  const shift = <T extends { start: number; end: number }>(xs: T[]) => xs.filter(x => x.end > s && x.start < e).map(x => ({ ...x, start: x.start - s, end: x.end - s }));
  const texts = shift(p.texts).map(t => t.words ? { ...t, words: t.words.map(w => ({ ...w, start: w.start - s, end: w.end - s })) } : t);
  return { ...p, clips, texts, effects: shift(p.effects), markers: [] };
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args);
    let err = '';
    proc.stderr.on('data', (b: Buffer) => { err += b.toString(); });
    proc.on('close', code => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').slice(-4).join('\n') || `ffmpeg exited with ${code}`))));
  });
}

const tmpBase = () => path.join(EXPORT_DIR, `.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);

/** One frame exactly as the export would draw it: video, zoom, captions and titles. */
export async function renderStill(p: Project, t: number, width = 540): Promise<Buffer> {
  const slice = sliceProject(p, t, t + 1 / p.fps);
  if (!slice.clips.some(c => c.track === 'video')) throw new Error(`No video at ${t}s.`);
  const base = tmpBase(), ass = base + '.ass', png = base + '.png';
  fs.writeFileSync(ass, buildAss(slice));
  try {
    await runFfmpeg(buildCommand(slice, png, ass, { kind: 'png', width }));
    return fs.readFileSync(png);
  } finally { for (const f of [ass, png, png + '.filter']) fs.rmSync(f, { force: true }); }
}

/** A grid of rendered frames across a range, each labelled with its time. */
export async function renderContactSheet(p: Project, start: number, end: number, count: number): Promise<{ png: Buffer; times: number[] }> {
  const cols = count <= 4 ? count : count <= 9 ? 3 : 4;
  const rows = Math.ceil(count / cols);
  const tileW = Math.round(Math.min(360, 1440 / cols) / 2) * 2;
  const times = Array.from({ length: count }, (_, k) => Math.round((start + ((end - start) * (k + 0.5)) / count) * 100) / 100);
  const base = tmpBase();
  const files: string[] = [];
  try {
    for (let k = 0; k < times.length; k += 2) {
      await Promise.all(times.slice(k, k + 2).map(async (t, j) => {
        const f = `${base}-${k + j}.png`;
        try { fs.writeFileSync(f, await renderStill(p, t, tileW)); }
        catch { await runFfmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${tileW}x${Math.round((tileW * p.height) / p.width / 2) * 2}`, '-frames:v', '1', f]); }
        files[k + j] = f;
      }));
    }
    const font = path.join(FONTS_DIR, 'Cairo.ttf').replace(/:/g, '\\:');
    const label = (k: number) => `[${k}:v]drawtext=fontfile='${font}':text='${fmtLabel(times[k])}':x=8:y=8:fontsize=${Math.round(tileW / 12)}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6[l${k}]`;
    const layout = times.map((_, k) => `${(k % cols) ? Array.from({ length: k % cols }, () => 'w0').join('+') : '0'}_${Math.floor(k / cols) ? Array.from({ length: Math.floor(k / cols) }, () => 'h0').join('+') : '0'}`).join('|');
    const graph = times.map((_, k) => label(k)).join(';') + ';' + times.map((_, k) => `[l${k}]`).join('') + (count > 1 ? `xstack=inputs=${count}:layout=${layout}:fill=black` : 'null');
    const out = base + '-sheet.png';
    await runFfmpeg(['-v', 'error', '-y', ...files.flatMap(f => ['-i', f]), '-filter_complex', graph, '-frames:v', '1', out]);
    const png = fs.readFileSync(out);
    fs.rmSync(out, { force: true });
    void rows; void CAPTION_PRESETS;
    return { png, times };
  } finally { for (const f of files) if (f) fs.rmSync(f, { force: true }); }
}
const fmtLabel = (t: number) => { const m = Math.floor(t / 60), s = t - m * 60; return `${String(m).padStart(2, '0')}\\:${s.toFixed(1).padStart(4, '0')}`; };

/** Loudness of the mixed output per window, in dBFS (0 is the loudest possible). */
export async function audioLevels(p: Project, start: number, end: number, step: number): Promise<{ t: number; rms: number; peak: number }[]> {
  const slice = sliceProject(p, start, end);
  const base = tmpBase(), ass = base + '.ass', wav = base + '.wav';
  fs.writeFileSync(ass, buildAss({ ...slice, texts: [] }));
  try {
    await runFfmpeg(buildCommand({ ...slice, texts: [], effects: [] }, wav, ass, { kind: 'wav' }));
    const buf = fs.readFileSync(wav);
    const data = buf.subarray(44);
    const per = Math.max(1, Math.round(16000 * step));
    const out: { t: number; rms: number; peak: number }[] = [];
    const db = (x: number) => (x <= 0 ? -99 : Math.max(-99, Math.round(20 * Math.log10(x) * 10) / 10));
    for (let i = 0; i < data.length / 2; i += per) {
      let sum = 0, pk = 0, k = 0;
      for (let j = i; j < Math.min(i + per, data.length / 2); j++, k++) { const v = data.readInt16LE(j * 2) / 32768; sum += v * v; if (Math.abs(v) > pk) pk = Math.abs(v); }
      out.push({ t: Math.round((start + i / 16000) * 100) / 100, rms: db(Math.sqrt(sum / Math.max(1, k))), peak: db(pk) });
    }
    return out;
  } finally { for (const f of [ass, wav, wav + '.filter']) fs.rmSync(f, { force: true }); }
}

/** Integrated loudness of the mix in LUFS, without any loudness correction applied. */
export async function measureLoudness(p: Project): Promise<number> {
  const plain: Project = { ...p, texts: [], effects: [], audio: { ...p.audio, loudness: undefined } };
  const base = tmpBase(), ass = base + '.ass', wav = base + '.wav';
  fs.writeFileSync(ass, buildAss(plain));
  try {
    await runFfmpeg(buildCommand(plain, wav, ass, { kind: 'wav', rate: 48000, channels: 2 }));
    const out = await new Promise<string>((resolve, reject) => {
      const proc = spawn(FFMPEG, ['-hide_banner', '-nostats', '-i', wav, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-']);
      let err = '';
      proc.stderr.on('data', (b: Buffer) => { err += b.toString(); });
      proc.on('close', code => (code === 0 ? resolve(err) : reject(new Error('Loudness measurement failed.'))));
    });
    const m = /I:\s+(-?[\d.]+) LUFS/.exec(out.slice(out.lastIndexOf('Summary')));
    if (!m) throw new Error('Could not measure loudness.');
    const v = Number(m[1]);
    if (!Number.isFinite(v) || v < -70) throw new Error('The mix is silent.');
    return v;
  } finally { for (const f of [ass, wav, wav + '.filter']) fs.rmSync(f, { force: true }); }
}

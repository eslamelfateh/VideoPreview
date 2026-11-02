import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipLen, duration, TEXT_LAYOUT as L } from '../shared/timeline.js';
import type { Project, TextItem, ZoomEffect } from '../shared/types.js';
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
  const W = p.width, H = p.height, base = Math.min(W, H);
  const cap = Math.round(base * L.captionSize), title = Math.round(base * L.titleSize), side = Math.round(W * L.side);
  const style = (name: string, size: number, align: number, marginV: number, shadow: number) =>
    `Style: ${name},${L.font},${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,${Math.round(size * L.outline)},${shadow},${align},${side},${side},${marginV},1`;
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    style('Caption', cap, 2, Math.round(H * L.captionBottom), Math.round(cap * 0.05)),
    style('Title', title, 8, Math.round(H * L.titleTop), 0),
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const t of p.texts) {
    if (t.style === 'title') {
      lines.push(`Dialogue: 1,${assTime(t.start)},${assTime(t.end)},Title,,0,0,0,,{\\c${assColor(t.color)}&}${assText(t.text)}`);
      continue;
    }
    const words = t.words?.length ? t.words.map(w => w.text) : [t.text];
    for (const f of captionFrames(t)) {
      if (f.end <= f.start) continue;
      const text = words.map((w, i) => i === f.active ? `{\\c${assColor(t.color ?? L.highlight)}&\\fscx${L.activeScale * 100}\\fscy${L.activeScale * 100}}${assText(w)}{\\r}` : assText(w)).join(' ');
      lines.push(`Dialogue: 0,${assTime(f.start)},${assTime(f.end)},Caption,,0,0,0,,${text}`);
    }
  }
  return lines.join('\n') + '\n';
}

/* ---------- zoom as one zoompan expression over the whole timeline ---------- */

function zoomFilter(effects: ZoomEffect[], W: number, H: number, fps: number): string {
  // Smoothstep ramp, identical to the preview.
  const z = effects.map(e => {
    const r = Math.max(0.001, e.ease);
    const x = `clip(min((it-${n(e.start)})/${n(r)},(${n(e.end)}-it)/${n(r)}),0,1)`;
    return `if(between(it,${n(e.start)},${n(e.end)}),1+(${n(e.scale)}-1)*${x}*${x}*(3-2*${x}),1)`;
  });
  const zexpr = z.reduce((acc, e) => `max(${acc},${e})`, '1');
  const anchor = (k: 'anchorX' | 'anchorY', dflt: number) =>
    effects.reduceRight((acc, e) => `if(between(it,${n(e.start)},${n(e.end)}),${n(e[k])},${acc})`, String(dflt));
  // Upscale first so slow zooms do not jitter on whole-pixel crop positions.
  const S = 2;
  return `scale=${W * S}:${H * S}:flags=bicubic,zoompan=z='${zexpr}':x='(iw-iw/zoom)*${anchor('anchorX', 0.5)}':y='(ih-ih/zoom)*${anchor('anchorY', 0.4)}':d=1:s=${W}x${H}:fps=${fps}`;
}

/* ---------- full ffmpeg command ---------- */

export function buildCommand(p: Project, out: string, assFile: string): string[] {
  const W = p.width, H = p.height, fps = p.fps, D = Math.max(0.1, duration(p));
  const media = new Map(p.media.map(m => [m.id, m]));
  const args = ['-y', '-v', 'error', '-progress', 'pipe:1', '-nostats'];
  const f: string[] = [`color=c=black:s=${W}x${H}:r=${fps}:d=${n(D)}[base0]`];
  const audio: string[] = [];
  let idx = 0, base = 'base0';

  const clips = [...p.clips].sort((a, b) => a.start - b.start);
  for (const c of clips) {
    const m = media.get(c.mediaId);
    if (!m) continue;
    const len = clipLen(c);
    if (len <= 0) continue;
    if (m.kind === 'image') args.push('-loop', '1', '-t', n(len), '-i', mediaPath(m));
    else args.push('-ss', n(c.in), '-t', n(len), '-i', mediaPath(m));
    const i = idx++;
    if (c.track === 'video' && m.kind !== 'audio') {
      f.push(`[${i}:v]fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p,setpts=PTS-STARTPTS+${n(c.start)}/TB[v${i}]`);
      f.push(`[${base}][v${i}]overlay=eof_action=pass:enable='between(t,${n(c.start)},${n(c.start + len)})'[base${i + 1}]`);
      base = `base${i + 1}`;
    }
    if (m.hasAudio && c.volume > 0) {
      const ms = Math.round(c.start * 1000);
      f.push(`[${i}:a]asetpts=PTS-STARTPTS,aresample=48000,volume=${n(c.volume)},adelay=${ms}:all=1[a${i}]`);
      audio.push(`[a${i}]`);
    }
  }

  let v = base;
  const zooms = p.effects.filter((e): e is ZoomEffect => e.kind === 'zoom');
  if (zooms.length) { f.push(`[${v}]${zoomFilter(zooms, W, H, fps)}[vz]`); v = 'vz'; }
  if (p.texts.length) {
    const esc = (s: string) => s.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    f.push(`[${v}]ass='${esc(assFile)}':fontsdir='${esc(FONTS_DIR)}':shaping=complex[vt]`);
    v = 'vt';
  }
  f.push(`[${v}]format=yuv420p[vout]`);

  if (audio.length) f.push(`${audio.join('')}amix=inputs=${audio.length}:normalize=0:dropout_transition=0,apad=whole_dur=${n(D)},atrim=end=${n(D)}[aout]`);
  else f.push(`anullsrc=r=48000:cl=stereo,atrim=end=${n(D)}[aout]`);

  args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '160k', '-t', n(D), '-movflags', '+faststart', out);
  return args;
}

let current: ReturnType<typeof spawn> | null = null;

export async function renderProject(): Promise<string> {
  if (current) throw new Error('An export is already running.');
  const p = structuredClone(store.project);
  if (!p.clips.length) throw new Error('The timeline is empty. Add a clip first.');
  const D = duration(p);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = `livecut-${stamp}.mp4`;
  const out = path.join(EXPORT_DIR, file);
  const assFile = path.join(EXPORT_DIR, `.${stamp}.ass`);
  fs.writeFileSync(assFile, buildAss(p));
  store.setRender({ status: 'rendering', progress: 0, file: undefined, error: undefined });

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, buildCommand(p, out, assFile));
    current = proc;
    let err = '';
    proc.stdout!.on('data', (b: Buffer) => {
      const m = /out_time_us=(\d+)/.exec(b.toString());
      if (m) store.setRender({ progress: Math.min(0.99, Number(m[1]) / 1e6 / D) });
    });
    proc.stderr!.on('data', (b: Buffer) => { err += b.toString(); });
    proc.on('close', code => {
      current = null;
      fs.rmSync(assFile, { force: true });
      if (code === 0) { store.setRender({ status: 'done', progress: 1, file }); resolve(file); }
      else { const e = err.trim().split('\n').slice(-6).join('\n') || `ffmpeg exited with ${code}`; store.setRender({ status: 'error', error: e }); reject(new Error(e)); }
    });
  });
}

import type { CaptionPreset, Clip, Effect, Project, ProjectAudio, TextItem, TextPosition, Word } from './types.js';

export const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
export const clipLen = (c: Clip) => c.out - c.in;
export const clipEnd = (c: Clip) => c.start + clipLen(c);

export function duration(p: Project): number {
  let d = 0;
  for (const c of p.clips) d = Math.max(d, clipEnd(c));
  for (const t of p.texts) d = Math.max(d, t.end);
  return round(d);
}

export function trackEnd(p: Project, track: Clip['track']): number {
  return p.clips.filter(c => c.track === track).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

/** The clip on a track that plays at timeline time t. */
export function clipAt(p: Project, track: Clip['track'], t: number): Clip | undefined {
  return p.clips.find(c => c.track === track && t >= c.start && t < clipEnd(c));
}

/**
 * Transcript words mapped onto the timeline. A word appears once per clip that
 * contains it, so cuts, reorders and silence removal keep captions in sync.
 */
export function timelineWords(p: Project): Word[] {
  const out: Word[] = [];
  for (const c of p.clips) {
    const tr = p.transcripts.find(t => t.mediaId === c.mediaId);
    if (!tr) continue;
    for (const w of tr.words) {
      const mid = (w.start + w.end) / 2;
      if (mid < c.in || mid >= c.out) continue;
      const s = Math.max(w.start, c.in), e = Math.min(w.end, c.out);
      out.push({ text: w.text, start: round(c.start + s - c.in), end: round(c.start + e - c.in) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[ً-ْٰـ]/g, '') // Arabic diacritics and tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
}

export function zoomAt(effects: Effect[], t: number): { scale: number; x: number; y: number } {
  let best = { scale: 1, x: 0.5, y: 0.4 };
  for (const z of effects) {
    if (z.kind !== 'zoom' || t < z.start || t > z.end) continue;
    const r = Math.max(0.001, z.ease);
    const x = Math.min(1, (t - z.start) / r, (z.end - t) / r);
    const a = x * x * (3 - 2 * x);
    const s = 1 + (z.scale - 1) * a;
    if (s > best.scale) best = { scale: s, x: z.anchorX, y: z.anchorY };
  }
  return best;
}

export function textsAt(texts: TextItem[], t: number): TextItem[] {
  return texts.filter(x => t >= x.start && t < x.end);
}

export function fmtTime(t: number): string {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Text layout as fractions of the canvas, shared by the live preview and the ffmpeg export. */
export const TEXT_LAYOUT = {
  font: 'Cairo',
  captionSize: 0.1, // of min(width, height)
  titleSize: 0.12,
  captionBottom: 0.2, // of height
  titleTop: 0.12,
  side: 0.07, // of width
  outline: 0.09, // of font size
  activeScale: 1.12,
  highlight: '#f0cf6a',
  /** libass sizes text by the font's full height (OS/2 win ascent + descent); for Cairo that is 1.883 em. */
  lineEm: 1.883,
};

/** Index of the highlighted word in a caption at time t (same rule as the export). */
export function activeWord(t: TextItem, time: number): number {
  const ws = t.words ?? [];
  for (let i = ws.length - 1; i >= 0; i--) if (time >= (i === 0 ? t.start : ws[i].start)) return i;
  return -1;
}

/** Where people talk on the timeline: transcript words merged across short gaps. */
export function speechRegions(p: Project, gap: number): [number, number][] {
  const out: [number, number][] = [];
  for (const w of timelineWords(p)) {
    const last = out[out.length - 1];
    if (last && w.start - last[1] < gap) last[1] = Math.max(last[1], w.end);
    else out.push([w.start, w.end]);
  }
  return out.map(([a, b]) => [round(a), round(b)]);
}

/**
 * How much the music is turned down at t (1 = untouched). The music ramps down over
 * `attack` before speech, stays down, and comes back over `release` after it.
 * The export builds the same curve as an ffmpeg expression.
 */
export const DUCK_GAP = 0.8;

export function duckFactor(audio: ProjectAudio | undefined, regions: [number, number][], t: number): number {
  const d = audio?.duck;
  if (!d || !regions.length) return 1;
  const f = Math.pow(10, d.amount / 20);
  let w = 0;
  for (const [s, e] of regions) {
    if (t < s - d.attack || t > e + d.release) continue;
    const up = d.attack > 0 ? Math.min(1, (t - (s - d.attack)) / d.attack) : 1;
    const down = d.release > 0 ? Math.min(1, ((e + d.release) - t) / d.release) : 1;
    w = Math.max(w, Math.max(0, Math.min(up, down)));
  }
  return 1 - (1 - f) * w;
}

export const masterGain = (audio: ProjectAudio | undefined) => (audio?.loudness ? Math.pow(10, audio.loudness.gainDb / 20) : 1);

/**
 * Caption looks, used by both the preview (CSS) and the export (ASS).
 * size: fraction of min(width, height); outline: fraction of the font size.
 */
export const CAPTION_PRESETS: Record<CaptionPreset, { label: string; size: number; outline: number; box: boolean; oneWord: boolean; dim: number; activeScale: number; base: string; active?: string }> = {
  karaoke: { label: 'Karaoke', size: 0.1, outline: 0.09, box: false, oneWord: false, dim: 1, activeScale: 1.12, base: '#ffffff' },
  box: { label: 'Box', size: 0.085, outline: 0.22, box: true, oneWord: false, dim: 1, activeScale: 1, base: '#ffffff' },
  pop: { label: 'One word', size: 0.14, outline: 0.1, box: false, oneWord: true, dim: 1, activeScale: 1, base: '#ffffff' },
  minimal: { label: 'Minimal', size: 0.07, outline: 0, box: false, oneWord: false, dim: 0.6, activeScale: 1, base: '#ffffff', active: '#ffffff' },
  bold: { label: 'Bold', size: 0.115, outline: 0.12, box: false, oneWord: false, dim: 1, activeScale: 1.15, base: '#f0cf6a', active: '#ffffff' },
};
export const presetOf = (t: TextItem) => CAPTION_PRESETS[t.preset ?? 'karaoke'] ?? CAPTION_PRESETS.karaoke;
export const positionOf = (t: TextItem): TextPosition => t.position ?? (t.style === 'title' ? 'top' : 'bottom');
/** Distance from the top (for top) or bottom (for bottom), as a fraction of the height. */
export const POSITION_MARGIN = { bottom: 0.2, top: 0.14, middle: 0 } as const;

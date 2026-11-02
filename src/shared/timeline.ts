import type { Clip, Effect, Project, TextItem, Word } from './types.js';

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
};

/** Index of the highlighted word in a caption at time t (same rule as the export). */
export function activeWord(t: TextItem, time: number): number {
  const ws = t.words ?? [];
  for (let i = ws.length - 1; i >= 0; i--) if (time >= (i === 0 ? t.start : ws[i].start)) return i;
  return -1;
}

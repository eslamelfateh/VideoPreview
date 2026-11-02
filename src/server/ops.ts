import { clipEnd, clipLen, duration, fmtTime, round, timelineWords, trackEnd } from '../shared/timeline.js';
import type { Clip, Marker, Media, Project, TextItem, Track, Word, ZoomEffect } from '../shared/types.js';
import { newId, type StepResult } from './store.js';

/**
 * Every edit, whether the agent or the user makes it, is one of these pure
 * functions on a draft project. The store records the diff as a step.
 */

const t3 = (x: number) => round(x, 3);
function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`${what} not found. Call get_project to see current ids.`);
  return v;
}
export const getClip = (p: Project, id: string) => need(p.clips.find(c => c.id === id), `Clip ${id}`);
export const getMedia = (p: Project, id: string) => need(p.media.find(m => m.id === id), `Media ${id}`);
const getText = (p: Project, id: string) => need(p.texts.find(t => t.id === id), `Text ${id}`);
const getEffect = (p: Project, id: string) => need(p.effects.find(e => e.id === id), `Effect ${id}`);
const getMarker = (p: Project, id: string) => need(p.markers.find(m => m.id === id), `Note ${id}`);
const num = (v: unknown, what: string) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${what} must be a number.`); return n; };
const opt = (v: unknown, what: string) => (v === undefined || v === null || v === '' ? undefined : num(v, what));

function checkClip(c: Clip, m: Media) {
  if (c.in < 0) c.in = 0;
  if (m.kind !== 'image' && c.out > m.duration) c.out = t3(m.duration);
  if (c.out - c.in < 0.05) throw new Error('A clip must be at least 0.05s long.');
  if (c.start < 0) c.start = 0;
  const len = c.out - c.in;
  c.fadeIn = Math.min(c.fadeIn ?? 0, len / 2) || undefined;
  c.fadeOut = Math.min(c.fadeOut ?? 0, len / 2) || undefined;
}

/** Splits whichever clip on a track spans t, returning true if one did. */
function splitTrackAt(d: Project, track: Track, t: number): boolean {
  const c = d.clips.find(x => x.track === track && t > x.start + 0.01 && t < clipEnd(x) - 0.01);
  if (!c) return false;
  const cut = t3(c.in + (t - c.start));
  d.clips.push({ ...c, id: newId('clip'), start: t3(t), in: cut, fadeIn: undefined });
  c.out = cut;
  c.fadeOut = undefined;
  return true;
}

/* ---------- clips ---------- */

export function addClip(d: Project, a: { mediaId: string; track?: Track; start?: number; in?: number; out?: number; volume?: number }): StepResult {
  const m = getMedia(d, a.mediaId);
  const track = a.track ?? (m.kind === 'audio' ? 'audio' : 'video');
  if (track === 'video' && m.kind === 'audio') throw new Error('Audio files go on the audio track.');
  const c: Clip = {
    id: newId('clip'), track, mediaId: m.id, start: t3(opt(a.start, 'start') ?? trackEnd(d, track)),
    in: t3(opt(a.in, 'in') ?? 0), out: t3(opt(a.out, 'out') ?? (m.kind === 'image' ? 5 : m.duration)), volume: opt(a.volume, 'volume') ?? 1,
  };
  checkClip(c, m);
  d.clips.push(c);
  return { summary: `Added ${m.name} to ${track} at ${fmtTime(c.start)} (${t3(clipLen(c))}s)`, at: c.start, detail: `clipId: ${c.id}` };
}

export function updateClip(d: Project, a: { clipId: string; start?: number; in?: number; out?: number; volume?: number; fadeIn?: number; fadeOut?: number }): StepResult {
  const c = getClip(d, a.clipId);
  const m = getMedia(d, c.mediaId);
  const parts: string[] = [];
  for (const k of ['start', 'in', 'out', 'volume', 'fadeIn', 'fadeOut'] as const) {
    const v = opt(a[k], k);
    if (v === undefined) continue;
    (c as any)[k] = k === 'volume' ? Math.max(0, Math.min(2, v)) : t3(v);
    parts.push(k === 'volume' ? `volume ${Math.round(c.volume * 100)}%` : `${k} ${t3(v)}s`);
  }
  checkClip(c, m);
  return { summary: `${m.name}: ${parts.join(', ') || 'no change'}`, at: c.start };
}

export function splitClip(d: Project, a: { clipId: string; at: number }): StepResult {
  const c = getClip(d, a.clipId);
  const at = num(a.at, 'at');
  if (at <= c.start + 0.01 || at >= clipEnd(c) - 0.01) throw new Error(`Split point must be inside the clip (${c.start}–${t3(clipEnd(c))}).`);
  const before = new Set(d.clips.map(x => x.id));
  const cut = t3(c.in + (at - c.start));
  d.clips.push({ ...c, id: newId('clip'), start: t3(at), in: cut, fadeIn: undefined });
  c.out = cut; c.fadeOut = undefined;
  const right = d.clips.find(x => !before.has(x.id))!;
  return { summary: `Split clip at ${fmtTime(at)}`, at, detail: `left: ${c.id}, right: ${right.id}` };
}

export function removeClip(d: Project, a: { clipId: string; ripple?: boolean }): StepResult {
  const c = getClip(d, a.clipId);
  d.clips = d.clips.filter(x => x.id !== c.id);
  const ripple = a.ripple !== false;
  if (ripple) for (const x of d.clips) if (x.track === c.track && x.start >= clipEnd(c) - 1e-6) x.start = t3(x.start - clipLen(c));
  return { summary: `Removed a ${c.track} clip at ${fmtTime(c.start)}${ripple ? ' and closed the gap' : ''}`, at: c.start };
}

/** Removes a time range from every track and closes the gap, like a ripple delete. */
export function cutRange(d: Project, a: { start: number; end: number }): StepResult {
  const s = t3(num(a.start, 'start')), e = t3(num(a.end, 'end'));
  if (e - s < 0.05) throw new Error('end must be after start.');
  const len = e - s;
  for (const tr of ['video', 'audio'] as const) { splitTrackAt(d, tr, s); splitTrackAt(d, tr, e); }
  d.clips = d.clips.filter(c => !(c.start >= s - 1e-6 && clipEnd(c) <= e + 1e-6));
  for (const c of d.clips) if (c.start >= e - 1e-6) c.start = t3(c.start - len);
  const shift = <T extends { start: number; end: number }>(items: T[]) => items
    .filter(x => !(x.start >= s && x.end <= e))
    .map(x => {
      const st = x.start >= e ? x.start - len : x.start > s ? s : x.start;
      const en = x.end >= e ? x.end - len : x.end > s ? s : x.end;
      return { ...x, start: t3(st), end: t3(en) };
    })
    .filter(x => x.end - x.start > 0.05);
  d.texts = shift(d.texts).map(t => t.words ? { ...t, words: t.words.filter(w => w.start < s || w.start >= e).map(w => w.start >= e ? { ...w, start: t3(w.start - len), end: t3(w.end - len) } : w) } : t);
  d.effects = shift(d.effects);
  d.markers = shift(d.markers);
  return { summary: `Cut ${fmtTime(s)} → ${fmtTime(e)} (${t3(len)}s) and closed the gap`, at: s };
}

/** Sets the volume over a time range (splitting clips at the edges) or for one clip. */
export function setVolume(d: Project, a: { volume: number; clipId?: string; start?: number; end?: number; track?: Track }): StepResult {
  const v = Math.max(0, Math.min(2, num(a.volume, 'volume')));
  const pct = `${Math.round(v * 100)}%`;
  if (a.clipId) { const c = getClip(d, a.clipId); c.volume = v; return { summary: `Volume ${pct} on one clip`, at: c.start }; }
  const s = opt(a.start, 'start') ?? 0, e = opt(a.end, 'end') ?? duration(d);
  const tracks: Track[] = a.track ? [a.track] : ['video', 'audio'];
  for (const tr of tracks) { splitTrackAt(d, tr, s); splitTrackAt(d, tr, e); }
  const hit = d.clips.filter(c => tracks.includes(c.track) && c.start >= s - 1e-6 && clipEnd(c) <= e + 1e-6);
  if (!hit.length) throw new Error('No clips in that range.');
  for (const c of hit) c.volume = v;
  return { summary: `Volume ${pct} from ${fmtTime(s)} to ${fmtTime(e)}`, at: s };
}

/* ---------- transcript-based ---------- */

export function removeSilences(d: Project, a: { minPause?: number; padding?: number }): StepResult {
  const minPause = opt(a.minPause, 'minPause') ?? 0.6, padding = opt(a.padding, 'padding') ?? 0.12;
  const video = d.clips.filter(c => c.track === 'video').sort((x, y) => x.start - y.start);
  if (!video.some(c => d.transcripts.some(t => t.mediaId === c.mediaId))) throw new Error('No video clip has a transcript yet.');
  const before = duration(d);
  const next: Clip[] = [];
  let cursor = video[0]?.start ?? 0;
  for (const c of video) {
    const tr = d.transcripts.find(t => t.mediaId === c.mediaId);
    const regions: [number, number][] = [];
    if (!tr) regions.push([c.in, c.out]);
    for (const w of tr?.words.filter(w => w.end > c.in && w.start < c.out) ?? []) {
      const s = Math.max(c.in, w.start - padding), e = Math.min(c.out, w.end + padding);
      const last = regions[regions.length - 1];
      if (last && s - last[1] < minPause) last[1] = Math.max(last[1], e); else regions.push([s, e]);
    }
    regions.forEach(([s, e], i) => {
      next.push({ ...c, id: i === 0 ? c.id : newId('clip'), start: t3(cursor), in: t3(s), out: t3(e), fadeIn: undefined, fadeOut: undefined });
      cursor += e - s;
    });
  }
  d.clips = d.clips.filter(c => c.track !== 'video').concat(next);
  const stale = d.texts.length || d.effects.length ? 'Existing captions/zooms were not moved; re-create them for the new timing.' : undefined;
  return { summary: `Removed pauses: ${video.length} clip(s) → ${next.length}, ${t3(before - duration(d))}s shorter`, at: 0, detail: stale };
}

function buildCaptions(words: Word[], perCaption: number, color?: string): TextItem[] {
  const out: TextItem[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ id: newId('text'), style: 'caption', start: cur[0].start, end: t3(cur[cur.length - 1].end + 0.15), text: cur.map(w => w.text).join(' '), words: cur, color });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > 0.6 || cur.length >= perCaption)) flush();
    cur.push(w);
    if (/[.!?؟،,]$/.test(w.text)) flush();
  }
  flush();
  for (let i = 0; i < out.length - 1; i++) out[i].end = Math.min(out[i].end, out[i + 1].start);
  return out;
}

export function addCaptions(d: Project, a: { start?: number; end?: number; wordsPerCaption?: number; color?: string }): StepResult {
  const start = opt(a.start, 'start') ?? 0, end = opt(a.end, 'end') ?? Infinity;
  const per = Math.max(1, Math.min(8, Math.round(opt(a.wordsPerCaption, 'wordsPerCaption') ?? 3)));
  const ws = timelineWords(d).filter(w => w.start >= start && w.start < end);
  if (!ws.length) throw new Error('No transcript words in that range. Call transcribe first.');
  d.texts = d.texts.filter(t => !(t.style === 'caption' && t.start >= start && t.start < end));
  const caps = buildCaptions(ws, per, a.color);
  d.texts.push(...caps);
  return { summary: `Added ${caps.length} captions (${ws.length} words)`, at: caps[0].start };
}

/* ---------- text ---------- */

export function addText(d: Project, a: { text: string; start: number; end: number; style?: 'title' | 'caption'; color?: string }): StepResult {
  const start = num(a.start, 'start'), end = num(a.end, 'end');
  if (end <= start) throw new Error('end must be after start.');
  if (!String(a.text ?? '').trim()) throw new Error('Text is empty.');
  const t: TextItem = { id: newId('text'), start: t3(start), end: t3(end), text: String(a.text), style: a.style ?? 'title', color: a.color || undefined };
  d.texts.push(t);
  return { summary: `Added ${t.style} "${t.text}" at ${fmtTime(t.start)}`, at: t.start, detail: `textId: ${t.id}` };
}

export function updateText(d: Project, a: { textId: string; text?: string; start?: number; end?: number; color?: string; style?: 'title' | 'caption' }): StepResult {
  const t = getText(d, a.textId);
  if (a.text !== undefined && a.text !== t.text) {
    if (!String(a.text).trim()) throw new Error('Text is empty.');
    // Keep word timing when only the spelling of the same words changed.
    const parts = String(a.text).trim().split(/\s+/);
    if (t.words && parts.length === t.words.length) t.words = t.words.map((w, i) => ({ ...w, text: parts[i] }));
    else delete t.words;
    t.text = String(a.text);
  }
  const s = opt(a.start, 'start'), e = opt(a.end, 'end');
  // Moving a caption (same length, new place) moves its word timings with it.
  const delta = s !== undefined ? s - t.start : 0;
  const moved = delta !== 0 && (e === undefined || Math.abs((e - s!) - (t.end - t.start)) < 0.002);
  if (moved && t.words) t.words = t.words.map(w => ({ ...w, start: t3(w.start + delta), end: t3(w.end + delta) }));
  if (s !== undefined) t.start = t3(s);
  if (e !== undefined) t.end = t3(e);
  else if (moved) t.end = t3(t.end + delta);
  if (t.end - t.start < 0.05) throw new Error('end must be after start.');
  if (a.color !== undefined) t.color = a.color || undefined;
  if (a.style) t.style = a.style;
  return { summary: `Edited text "${t.text}"`, at: t.start };
}

export function removeText(d: Project, a: { textId: string }): StepResult {
  if (a.textId === 'all-captions') {
    const k = d.texts.filter(t => t.style === 'caption').length;
    d.texts = d.texts.filter(t => t.style !== 'caption');
    return { summary: `Removed ${k} captions` };
  }
  const t = getText(d, a.textId);
  d.texts = d.texts.filter(x => x.id !== a.textId);
  return { summary: `Removed text "${t.text}"`, at: t.start };
}

/* ---------- zoom ---------- */

export function addZoom(d: Project, a: Partial<ZoomEffect> & { start: number; end: number }): StepResult {
  const start = num(a.start, 'start'), end = num(a.end, 'end');
  if (end <= start) throw new Error('end must be after start.');
  const e: ZoomEffect = {
    id: newId('fx'), kind: 'zoom', start: t3(start), end: t3(end),
    scale: Math.max(1.01, Math.min(3, opt(a.scale, 'scale') ?? 1.3)), ease: Math.max(0, Math.min(2, opt(a.ease, 'ease') ?? 0.3)),
    anchorX: Math.max(0, Math.min(1, opt(a.anchorX, 'anchorX') ?? 0.5)), anchorY: Math.max(0, Math.min(1, opt(a.anchorY, 'anchorY') ?? 0.4)),
  };
  d.effects.push(e);
  return { summary: `Zoom ${e.scale}× ${fmtTime(e.start)} → ${fmtTime(e.end)}`, at: t3(Math.min(e.end, e.start + e.ease)), detail: `effectId: ${e.id}` };
}

export function updateEffect(d: Project, a: { effectId: string } & Partial<ZoomEffect>): StepResult {
  const e = getEffect(d, a.effectId);
  const lim: Record<string, [number, number]> = { start: [0, 1e6], end: [0, 1e6], scale: [1.01, 3], ease: [0, 2], anchorX: [0, 1], anchorY: [0, 1] };
  for (const k of Object.keys(lim)) {
    const v = opt((a as any)[k], k);
    if (v !== undefined) (e as any)[k] = t3(Math.max(lim[k][0], Math.min(lim[k][1], v)));
  }
  if (e.end - e.start < 0.05) throw new Error('end must be after start.');
  return { summary: `Zoom ${e.scale}× ${fmtTime(e.start)} → ${fmtTime(e.end)}, ease ${e.ease}s`, at: t3(Math.min(e.end, e.start + e.ease)) };
}

export function removeEffect(d: Project, a: { effectId: string }): StepResult {
  const e = getEffect(d, a.effectId);
  d.effects = d.effects.filter(x => x.id !== a.effectId);
  return { summary: `Removed zoom at ${fmtTime(e.start)}`, at: e.start };
}

/* ---------- notes for the agent ---------- */

export function addMarker(d: Project, a: { start: number; end?: number; text: string; kind?: 'do' | 'dont' }): StepResult {
  const start = num(a.start, 'start');
  const end = opt(a.end, 'end') ?? start + 1;
  if (!String(a.text ?? '').trim()) throw new Error('Write what the agent should do here.');
  const m: Marker = { id: newId('note'), start: t3(start), end: t3(Math.max(end, start + 0.1)), text: String(a.text).trim(), kind: a.kind === 'dont' ? 'dont' : 'do', status: 'open' };
  d.markers.push(m);
  return { summary: `${m.kind === 'dont' ? 'Locked' : 'Note'} ${fmtTime(m.start)} → ${fmtTime(m.end)}: ${m.text}`, at: m.start, detail: `markerId: ${m.id}` };
}

export function updateMarker(d: Project, a: { markerId: string; start?: number; end?: number; text?: string; kind?: 'do' | 'dont'; status?: 'open' | 'done'; reply?: string }): StepResult {
  const m = getMarker(d, a.markerId);
  const s = opt(a.start, 'start'), e = opt(a.end, 'end');
  if (s !== undefined) m.start = t3(s);
  if (e !== undefined) m.end = t3(e);
  if (m.end - m.start < 0.1) m.end = t3(m.start + 0.1);
  if (a.text !== undefined) m.text = String(a.text).trim() || m.text;
  if (a.kind) m.kind = a.kind;
  if (a.status) m.status = a.status;
  if (a.reply !== undefined) m.reply = a.reply;
  return { summary: `${m.status === 'done' ? 'Done' : 'Note'} ${fmtTime(m.start)}: ${m.text}${m.reply ? ` → ${m.reply}` : ''}`, at: m.start };
}

export function removeMarker(d: Project, a: { markerId: string }): StepResult {
  const m = getMarker(d, a.markerId);
  d.markers = d.markers.filter(x => x.id !== a.markerId);
  return { summary: `Removed note "${m.text}"`, at: m.start };
}

export function setCanvas(d: Project, a: { width: number; height: number; fps?: number }): StepResult {
  const w = Math.round(num(a.width, 'width')), h = Math.round(num(a.height, 'height'));
  if (w < 16 || h < 16 || w > 4096 || h > 4096) throw new Error('Size must be between 16 and 4096.');
  d.width = w - (w % 2); d.height = h - (h % 2);
  const fps = opt(a.fps, 'fps');
  if (fps) d.fps = Math.max(1, Math.min(60, Math.round(fps)));
  return { summary: `Canvas ${d.width}×${d.height} @ ${d.fps}fps` };
}

/** Operations the editor UI may call directly (each becomes a user step). */
export const USER_OPS: Record<string, (d: Project, a: any) => StepResult> = {
  update_clip: updateClip, split_clip: splitClip, remove_clip: removeClip, cut_range: cutRange, set_volume: setVolume,
  add_text: addText, update_text: updateText, remove_text: removeText,
  add_zoom: addZoom, update_effect: updateEffect, remove_effect: removeEffect,
  add_note: addMarker, update_note: updateMarker, remove_note: removeMarker,
  set_canvas: setCanvas, add_clip: addClip,
};

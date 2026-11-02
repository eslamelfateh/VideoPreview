import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { clipAt, clipEnd, clipLen, duration, fmtTime, normalize, round, timelineWords, trackEnd } from '../shared/timeline.js';
import type { Clip, Project, TextItem, Word } from '../shared/types.js';
import { frameAt, importFile } from './media.js';
import { renderProject } from './render.js';
import { Hold, newId, store } from './store.js';
import { transcribe } from './transcribe.js';

const PUBLIC_URL = () => (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4317}`).replace(/\/$/, '');
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`${what} not found. Call get_project to see current ids.`);
  return v;
}
const getClip = (p: Project, id: string) => need(p.clips.find(c => c.id === id), `Clip ${id}`);
const getMedia = (p: Project, id: string) => need(p.media.find(m => m.id === id), `Media ${id}`);
const getText = (p: Project, id: string) => need(p.texts.find(t => t.id === id), `Text ${id}`);
const getEffect = (p: Project, id: string) => need(p.effects.find(e => e.id === id), `Effect ${id}`);
const t3 = (x: number) => round(x, 3);

function describe(p: Project): string {
  const out = {
    canvas: `${p.width}x${p.height} @ ${p.fps}fps`,
    duration: duration(p),
    mode: store.control.mode,
    media: p.media.map(m => ({ id: m.id, name: m.name, kind: m.kind, duration: m.duration, size: m.width ? `${m.width}x${m.height}` : undefined, hasAudio: m.hasAudio, transcript: p.transcripts.some(t => t.mediaId === m.id) })),
    clips: [...p.clips].sort((a, b) => a.start - b.start).map(c => ({ id: c.id, track: c.track, mediaId: c.mediaId, start: c.start, end: t3(clipEnd(c)), in: c.in, out: c.out, volume: c.volume })),
    texts: p.texts.map(t => ({ id: t.id, style: t.style, start: t.start, end: t.end, text: t.text })),
    effects: p.effects,
  };
  return JSON.stringify(out, null, 1);
}

/** Groups timeline words into short caption lines, breaking on pauses and punctuation. */
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
  // Never let a caption hang over the next one.
  for (let i = 0; i < out.length - 1; i++) out[i].end = Math.min(out[i].end, out[i + 1].start);
  return out;
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'livecut', version: '0.1.0' },
    {
      instructions: [
        'LiveCut is a video editor the user watches while you edit. Every edit tool call shows up live on their timeline as a step they can undo, compare before/after, or reject.',
        'Work in small, meaningful steps (one idea per call) so the user can follow and review. Tool results may include messages from the user: read and follow them.',
        'If a result says the user paused or is reviewing, call wait_for_user before editing again.',
        'Typical order: get_project → add_clip → transcribe → remove_silences → add_captions → add_zoom / add_text → get_frame to check → export_video.',
        'All times are in seconds on the timeline unless a parameter says "source".',
      ].join('\n'),
    },
  );

  const tool = (name: string, description: string, shape: Record<string, z.ZodType>, run: (a: any) => Promise<any> | any) => {
    server.registerTool(name, { description, inputSchema: shape as any }, (async (args: any) => {
      store.lastAgentSeen = Date.now();
      try {
        const r = await run(args ?? {});
        return typeof r === 'string' ? text(r) : r;
      } catch (e: any) {
        if (e instanceof Hold) return text(e.message);
        return { ...text(`Error: ${e?.message ?? e}`), isError: true };
      }
    }) as any);
  };

  /* ---------- read ---------- */

  tool('get_project', 'Current project: canvas, media library, clips, texts, effects and ids. Call this first and whenever you are unsure of ids.', {},
    () => describe(store.project) + store.drainNotes());

  tool('wait_for_user', 'Waits until the user resumes or finishes reviewing, then returns any messages they left. Call it when a result says the user paused or is reviewing.', {},
    async () => {
      await store.waitForTurn(10 * 60_000).catch(() => { throw new Hold('Still waiting for the user. Call wait_for_user again.'); });
      return 'You can continue.' + (store.drainNotes() || ' No new messages from the user.');
    });

  tool('get_transcript', 'Word-level transcript with timeline times (after cuts). Use it to choose where to cut, caption, or zoom.', {
    start: z.number().optional().describe('Only words from this timeline time'),
    end: z.number().optional(),
  }, ({ start = 0, end = Infinity }) => {
    const ws = timelineWords(store.project).filter(w => w.start >= start && w.start < end);
    if (!ws.length) return store.project.transcripts.length ? 'No words in that range.' : 'No transcript yet. Call transcribe or set_transcript first.';
    return ws.map(w => `${w.start.toFixed(2)}-${w.end.toFixed(2)} ${w.text}`).join('\n');
  });

  tool('find_words', 'Finds a word or phrase in the transcript (Arabic spelling variants and diacritics are ignored). Returns timeline times.', {
    query: z.string(),
  }, ({ query }) => {
    const q = String(query).split(/\s+/).map(normalize).filter(Boolean);
    const ws = timelineWords(store.project);
    const hits: string[] = [];
    for (let i = 0; i + q.length <= ws.length; i++) {
      if (q.every((x, j) => normalize(ws[i + j].text).includes(x))) {
        const s = ws[i].start, e = ws[i + q.length - 1].end;
        hits.push(`${s.toFixed(2)}-${e.toFixed(2)} "${ws.slice(i, i + q.length).map(w => w.text).join(' ')}"`);
      }
    }
    return hits.length ? hits.join('\n') : `"${query}" was not found in the transcript.`;
  });

  tool('get_frame', 'Returns a still image of the video track at a timeline time, so you can see the footage (framing, faces, where to anchor a zoom). Overlays are not drawn.', {
    time: z.number(),
  }, async ({ time }) => {
    const p = store.project;
    const c = clipAt(p, 'video', time);
    if (!c) return `No video clip at ${time}s.`;
    const m = getMedia(p, c.mediaId);
    const png = await frameAt(m, m.kind === 'image' ? 0 : c.in + (time - c.start));
    return { content: [{ type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text' as const, text: `Frame at ${fmtTime(time)} from ${m.name} (${m.width}x${m.height}).` }] };
  });

  /* ---------- media ---------- */

  tool('import_media', 'Imports a media file from a path on the server or an http(s) URL into the library. Users can also drag files into the editor.', {
    path: z.string().optional(), url: z.string().optional(),
  }, async ({ path: p, url }) => {
    let src = p, name = p ? path.basename(p) : '', tmp = '';
    if (url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download');
      tmp = path.join(os.tmpdir(), `livecut-${Date.now()}-${name.replace(/[^\w.-]/g, '_')}`);
      fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      src = tmp;
    }
    if (!src) throw new Error('Pass path or url.');
    const m = await importFile(src, name, !!tmp);
    return store.edit('import_media', { name }, d => {
      d.media.push(m);
      return { summary: `Imported ${m.name} (${m.kind}, ${m.duration}s)`, detail: `mediaId: ${m.id}` };
    });
  });

  tool('set_canvas', 'Sets the output size and frame rate, e.g. 1080x1920 for Reels/TikTok/Shorts, 1920x1080 for YouTube, 1080x1080 square.', {
    width: z.number().int().min(16).max(4096), height: z.number().int().min(16).max(4096), fps: z.number().int().min(1).max(60).optional(),
  }, ({ width, height, fps }) => store.edit('set_canvas', { width, height, fps }, d => {
    d.width = width - (width % 2); d.height = height - (height % 2); if (fps) d.fps = fps;
    return { summary: `Canvas ${d.width}x${d.height} @ ${d.fps}fps` };
  }));

  /* ---------- clips ---------- */

  tool('add_clip', 'Places a media item on the timeline. By default it is appended at the end of its track and uses the whole file.', {
    mediaId: z.string(), track: z.enum(['video', 'audio']).optional(),
    start: z.number().min(0).optional().describe('Timeline position; default: end of track'),
    in: z.number().min(0).optional().describe('Source in-point'), out: z.number().optional().describe('Source out-point'),
    volume: z.number().min(0).max(2).optional(),
  }, a => store.edit('add_clip', a, d => {
    const m = getMedia(d, a.mediaId);
    const track = a.track ?? (m.kind === 'audio' ? 'audio' : 'video');
    if (track === 'video' && m.kind === 'audio') throw new Error('Audio files go on the audio track.');
    const c: Clip = {
      id: newId('clip'), track, mediaId: m.id, start: t3(a.start ?? trackEnd(d, track)),
      in: t3(a.in ?? 0), out: t3(Math.min(a.out ?? m.duration, m.kind === 'image' ? 3600 : m.duration)), volume: a.volume ?? 1,
    };
    if (c.out <= c.in) throw new Error('out must be greater than in.');
    d.clips.push(c);
    return { summary: `Added ${m.name} to ${track} at ${fmtTime(c.start)} (${t3(clipLen(c))}s)`, at: c.start, detail: `clipId: ${c.id}` };
  }));

  tool('update_clip', 'Moves or trims a clip: change its timeline start, source in/out points, or volume.', {
    clipId: z.string(), start: z.number().min(0).optional(), in: z.number().min(0).optional(), out: z.number().optional(), volume: z.number().min(0).max(2).optional(),
  }, a => store.edit('update_clip', a, d => {
    const c = getClip(d, a.clipId);
    if (a.start !== undefined) c.start = t3(a.start);
    if (a.in !== undefined) c.in = t3(a.in);
    if (a.out !== undefined) c.out = t3(a.out);
    if (a.volume !== undefined) c.volume = a.volume;
    if (c.out <= c.in) throw new Error('out must be greater than in.');
    return { summary: `Updated clip ${c.id}: ${fmtTime(c.start)} → ${fmtTime(clipEnd(c))}`, at: c.start };
  }));

  tool('split_clip', 'Splits a clip in two at a timeline time.', {
    clipId: z.string(), at: z.number(),
  }, a => store.edit('split_clip', a, d => {
    const c = getClip(d, a.clipId);
    if (a.at <= c.start || a.at >= clipEnd(c)) throw new Error(`Split point must be inside the clip (${c.start}–${t3(clipEnd(c))}).`);
    const cut = t3(c.in + (a.at - c.start));
    const right: Clip = { ...c, id: newId('clip'), start: t3(a.at), in: cut };
    c.out = cut;
    d.clips.push(right);
    return { summary: `Split ${c.id} at ${fmtTime(a.at)}`, at: a.at, detail: `left: ${c.id}, right: ${right.id}` };
  }));

  tool('remove_clip', 'Removes a clip. With ripple (default) later clips on the same track move left to close the gap.', {
    clipId: z.string(), ripple: z.boolean().optional(),
  }, a => store.edit('remove_clip', a, d => {
    const c = getClip(d, a.clipId);
    d.clips = d.clips.filter(x => x.id !== c.id);
    if (a.ripple !== false) for (const x of d.clips) if (x.track === c.track && x.start >= clipEnd(c) - 1e-6) x.start = t3(x.start - clipLen(c));
    return { summary: `Removed clip ${c.id}${a.ripple !== false ? ' and closed the gap' : ''}`, at: c.start };
  }));

  /* ---------- transcript ---------- */

  tool('transcribe', 'Transcribes speech in a media item with word timings (needs a speech-to-text key on the server). Required before captions, find_words and remove_silences.', {
    mediaId: z.string(), language: z.string().optional().describe('e.g. "ar" for Arabic, "en"'),
  }, async ({ mediaId, language }) => {
    await store.waitForTurn();
    const m = getMedia(store.project, mediaId);
    const tr = await transcribe(m, language);
    return store.edit('transcribe', { mediaId, language }, d => {
      d.transcripts = d.transcripts.filter(t => t.mediaId !== mediaId).concat(tr);
      return { summary: `Transcribed ${m.name}: ${tr.words.length} words`, detail: tr.words.slice(0, 40).map(w => w.text).join(' ') + (tr.words.length > 40 ? ' …' : '') };
    });
  });

  tool('set_transcript', 'Stores a word-level transcript you already have for a media item. Times are in SOURCE seconds of that file.', {
    mediaId: z.string(), language: z.string().optional(),
    words: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })),
  }, ({ mediaId, language, words }) => store.edit('set_transcript', { mediaId, words: words.length }, d => {
    const m = getMedia(d, mediaId);
    d.transcripts = d.transcripts.filter(t => t.mediaId !== mediaId).concat({ mediaId, language, words });
    return { summary: `Transcript set for ${m.name}: ${words.length} words` };
  }));

  tool('remove_silences', 'Cuts pauses out of video-track clips that have a transcript and closes the gaps. Do this BEFORE adding captions and zooms, because times shift.', {
    minPause: z.number().min(0.1).optional().describe('Pauses longer than this are removed (default 0.6s)'),
    padding: z.number().min(0).optional().describe('Kept around speech (default 0.12s)'),
  }, ({ minPause = 0.6, padding = 0.12 }) => store.edit('remove_silences', { minPause, padding }, d => {
    const video = d.clips.filter(c => c.track === 'video').sort((a, b) => a.start - b.start);
    if (!video.some(c => d.transcripts.some(t => t.mediaId === c.mediaId))) throw new Error('No video clip has a transcript yet.');
    const before = duration(d);
    const next: Clip[] = [];
    let cursor = video[0]?.start ?? 0;
    for (const c of video) {
      const tr = d.transcripts.find(t => t.mediaId === c.mediaId);
      const ws = tr?.words.filter(w => w.end > c.in && w.start < c.out) ?? [];
      const regions: [number, number][] = [];
      if (!tr) regions.push([c.in, c.out]);
      for (const w of ws) {
        const s = Math.max(c.in, w.start - padding), e = Math.min(c.out, w.end + padding);
        const last = regions[regions.length - 1];
        if (last && s - last[1] < minPause) last[1] = Math.max(last[1], e); else regions.push([s, e]);
      }
      regions.forEach(([s, e], i) => {
        next.push({ ...c, id: i === 0 ? c.id : newId('clip'), start: t3(cursor), in: t3(s), out: t3(e) });
        cursor += e - s;
      });
    }
    d.clips = d.clips.filter(c => c.track !== 'video').concat(next);
    const saved = t3(before - duration(d));
    const stale = d.texts.length || d.effects.length ? ' Existing captions/zooms were not moved; re-create them for the new timing.' : '';
    return { summary: `Removed pauses: ${video.length} clip(s) → ${next.length}, ${saved}s shorter`, at: 0, detail: stale.trim() || undefined };
  }));

  /* ---------- text ---------- */

  tool('add_captions', 'Creates word-by-word captions from the transcript (the spoken word is highlighted, karaoke style). Replaces existing captions in the range.', {
    start: z.number().optional(), end: z.number().optional(),
    wordsPerCaption: z.number().int().min(1).max(8).optional().describe('Default 3'),
    color: z.string().optional().describe('Highlight color, e.g. #f0cf6a'),
  }, ({ start = 0, end = Infinity, wordsPerCaption = 3, color }) => store.edit('add_captions', { start, end: end === Infinity ? undefined : end, wordsPerCaption, color }, d => {
    const ws = timelineWords(d).filter(w => w.start >= start && w.start < end);
    if (!ws.length) throw new Error('No transcript words in that range. Call transcribe first.');
    d.texts = d.texts.filter(t => !(t.style === 'caption' && t.start >= start && t.start < end));
    const caps = buildCaptions(ws, wordsPerCaption, color);
    d.texts.push(...caps);
    return { summary: `Added ${caps.length} captions (${ws.length} words)`, at: caps[0].start };
  }));

  tool('add_text', 'Adds a text overlay. style "title" sits near the top in large type; "caption" sits near the bottom.', {
    text: z.string(), start: z.number().min(0), end: z.number(), style: z.enum(['title', 'caption']).optional(), color: z.string().optional(),
  }, a => store.edit('add_text', a, d => {
    if (a.end <= a.start) throw new Error('end must be after start.');
    const t: TextItem = { id: newId('text'), start: t3(a.start), end: t3(a.end), text: a.text, style: a.style ?? 'title', color: a.color };
    d.texts.push(t);
    return { summary: `Added ${t.style} "${t.text}" at ${fmtTime(t.start)}`, at: t.start, detail: `textId: ${t.id}` };
  }));

  tool('update_text', 'Edits a text overlay or caption (wording, timing, color).', {
    textId: z.string(), text: z.string().optional(), start: z.number().optional(), end: z.number().optional(), color: z.string().optional(),
  }, a => store.edit('update_text', a, d => {
    const t = getText(d, a.textId);
    if (a.text !== undefined && a.text !== t.text) { t.text = a.text; delete t.words; }
    if (a.start !== undefined) t.start = t3(a.start);
    if (a.end !== undefined) t.end = t3(a.end);
    if (a.color !== undefined) t.color = a.color;
    return { summary: `Updated text "${t.text}"`, at: t.start };
  }));

  tool('remove_text', 'Removes one text overlay or caption, or all captions when textId is "all-captions".', {
    textId: z.string(),
  }, ({ textId }) => store.edit('remove_text', { textId }, d => {
    if (textId === 'all-captions') { const k = d.texts.filter(t => t.style === 'caption').length; d.texts = d.texts.filter(t => t.style !== 'caption'); return { summary: `Removed ${k} captions` }; }
    const t = getText(d, textId);
    d.texts = d.texts.filter(x => x.id !== textId);
    return { summary: `Removed text "${t.text}"`, at: t.start };
  }));

  /* ---------- effects ---------- */

  tool('add_zoom', 'Punch-in zoom between two timeline times with smooth ease in/out. Use get_frame to aim the anchor at a face.', {
    start: z.number().min(0), end: z.number(),
    scale: z.number().min(1.01).max(3).optional().describe('Default 1.3'),
    ease: z.number().min(0).max(2).optional().describe('Ramp seconds, default 0.3'),
    anchorX: z.number().min(0).max(1).optional().describe('0 = left, 1 = right, default 0.5'),
    anchorY: z.number().min(0).max(1).optional().describe('0 = top, 1 = bottom, default 0.4'),
  }, a => store.edit('add_zoom', a, d => {
    if (a.end <= a.start) throw new Error('end must be after start.');
    const e = { id: newId('fx'), kind: 'zoom' as const, start: t3(a.start), end: t3(a.end), scale: a.scale ?? 1.3, ease: a.ease ?? 0.3, anchorX: a.anchorX ?? 0.5, anchorY: a.anchorY ?? 0.4 };
    d.effects.push(e);
    return { summary: `Zoom ${e.scale}× ${fmtTime(e.start)} → ${fmtTime(e.end)}`, at: t3(Math.min(e.end, e.start + e.ease)), detail: `effectId: ${e.id}` };
  }));

  tool('update_effect', 'Changes a zoom: timing, scale, ease or anchor.', {
    effectId: z.string(), start: z.number().optional(), end: z.number().optional(), scale: z.number().min(1.01).max(3).optional(),
    ease: z.number().min(0).max(2).optional(), anchorX: z.number().min(0).max(1).optional(), anchorY: z.number().min(0).max(1).optional(),
  }, ({ effectId, ...rest }) => store.edit('update_effect', { effectId, ...rest }, d => {
    const e = getEffect(d, effectId);
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) (e as any)[k] = v;
    return { summary: `Updated zoom: ${e.scale}× ${fmtTime(e.start)} → ${fmtTime(e.end)}, ease ${e.ease}s`, at: t3(Math.min(e.end, e.start + e.ease)) };
  }));

  tool('remove_effect', 'Removes an effect.', { effectId: z.string() },
    ({ effectId }) => store.edit('remove_effect', { effectId }, d => {
      const e = getEffect(d, effectId);
      d.effects = d.effects.filter(x => x.id !== effectId);
      return { summary: `Removed zoom at ${fmtTime(e.start)}`, at: e.start };
    }));

  /* ---------- export ---------- */

  tool('export_video', 'Renders the timeline to an MP4 with ffmpeg and returns a download link. Takes a while for long videos.', {},
    async () => {
      await store.waitForTurn();
      const file = await renderProject();
      return `Exported ${file}. Download: ${PUBLIC_URL()}/exports/${file}` + store.drainNotes();
    });

  return server;
}

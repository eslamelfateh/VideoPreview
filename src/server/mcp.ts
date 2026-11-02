import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { clipAt, clipEnd, duration, fmtTime, normalize, round, timelineWords } from '../shared/timeline.js';
import type { Project } from '../shared/types.js';
import { analyze } from './assets.js';
import { frameAt, importFile } from './media.js';
import * as ops from './ops.js';
import { renderProject } from './render.js';
import { Hold, store } from './store.js';
import { transcribe } from './transcribe.js';

const PUBLIC_URL = () => (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4317}`).replace(/\/$/, '');
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

const getMedia = ops.getMedia;
const t3 = (x: number) => round(x, 3);

function describe(p: Project): string {
  const out = {
    canvas: `${p.width}x${p.height} @ ${p.fps}fps`,
    duration: duration(p),
    mode: store.control.mode,
    media: p.media.map(m => ({ id: m.id, name: m.name, kind: m.kind, duration: m.duration, size: m.width ? `${m.width}x${m.height}` : undefined, hasAudio: m.hasAudio, transcript: p.transcripts.some(t => t.mediaId === m.id) })),
    clips: [...p.clips].sort((a, b) => a.start - b.start).map(c => ({ id: c.id, track: c.track, mediaId: c.mediaId, start: c.start, end: t3(clipEnd(c)), in: c.in, out: c.out, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut })),
    texts: p.texts.map(t => ({ id: t.id, style: t.style, start: t.start, end: t.end, text: t.text })),
    effects: p.effects,
    userNotes: p.markers.map(m => ({ id: m.id, start: m.start, end: m.end, kind: m.kind === 'dont' ? 'DO NOT TOUCH' : 'please do', text: m.text, status: m.status })),
  };
  return JSON.stringify(out, null, 1);
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
        'The user can pin notes on the timeline (userNotes in get_project). "please do" notes are requests for that time range: do them, then call resolve_note. "DO NOT TOUCH" notes lock a range: edits that change anything there are refused, so work around them.',
        'The user can also edit by hand at any time (trim, volume, text, zoom); you will be told in tool results. Do not undo their edits.',
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
    const out = await store.edit('import_media', { name }, d => {
      d.media.push(m);
      return { summary: `Imported ${m.name} (${m.kind}, ${m.duration}s)`, detail: `mediaId: ${m.id}` };
    });
    analyze(m);
    return out;
  });

  tool('set_canvas', 'Sets the output size and frame rate, e.g. 1080x1920 for Reels/TikTok/Shorts, 1920x1080 for YouTube, 1080x1080 square.', {
    width: z.number().int(), height: z.number().int(), fps: z.number().int().optional(),
  }, a => store.edit('set_canvas', a, d => ops.setCanvas(d, a)));

  /* ---------- clips and audio ---------- */

  tool('add_clip', 'Places a media item on the timeline. By default it is appended at the end of its track and uses the whole file.', {
    mediaId: z.string(), track: z.enum(['video', 'audio']).optional(),
    start: z.number().min(0).optional().describe('Timeline position; default: end of track'),
    in: z.number().min(0).optional().describe('Source in-point'), out: z.number().optional().describe('Source out-point'),
    volume: z.number().min(0).max(2).optional(),
  }, a => store.edit('add_clip', a, d => ops.addClip(d, a)));

  tool('update_clip', 'Moves or trims a clip, or sets its volume (1 = original, 0.5 = half, 2 = double) and fade in/out seconds.', {
    clipId: z.string(), start: z.number().min(0).optional(), in: z.number().min(0).optional(), out: z.number().optional(),
    volume: z.number().min(0).max(2).optional(), fadeIn: z.number().min(0).optional(), fadeOut: z.number().min(0).optional(),
  }, a => store.edit('update_clip', a, d => ops.updateClip(d, a)));

  tool('set_volume', 'Sets the volume over a timeline range (clips are split at the edges), or for one clip. 1 = original, 0 = mute, up to 2.', {
    volume: z.number().min(0).max(2), start: z.number().optional(), end: z.number().optional(),
    clipId: z.string().optional(), track: z.enum(['video', 'audio']).optional().describe('Limit to one track; default both'),
  }, a => store.edit('set_volume', a, d => ops.setVolume(d, a)));

  tool('split_clip', 'Splits a clip in two at a timeline time.', {
    clipId: z.string(), at: z.number(),
  }, a => store.edit('split_clip', a, d => ops.splitClip(d, a)));

  tool('remove_clip', 'Removes a clip. With ripple (default) later clips on the same track move left to close the gap.', {
    clipId: z.string(), ripple: z.boolean().optional(),
  }, a => store.edit('remove_clip', a, d => ops.removeClip(d, a)));

  tool('cut_range', 'Removes a time range from the whole video (all tracks, texts, zooms) and closes the gap. Use for "cut this part out".', {
    start: z.number(), end: z.number(),
  }, a => store.edit('cut_range', a, d => ops.cutRange(d, a)));

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
  }, a => store.edit('remove_silences', a, d => ops.removeSilences(d, a)));

  /* ---------- text ---------- */

  tool('add_captions', 'Creates word-by-word captions from the transcript (the spoken word is highlighted, karaoke style). Replaces existing captions in the range.', {
    start: z.number().optional(), end: z.number().optional(),
    wordsPerCaption: z.number().int().min(1).max(8).optional().describe('Default 3'),
    color: z.string().optional().describe('Highlight color, e.g. #f0cf6a'),
  }, a => store.edit('add_captions', a, d => ops.addCaptions(d, a)));

  tool('add_text', 'Adds a text overlay. style "title" sits near the top in large type; "caption" sits near the bottom.', {
    text: z.string(), start: z.number().min(0), end: z.number(), style: z.enum(['title', 'caption']).optional(), color: z.string().optional(),
  }, a => store.edit('add_text', a, d => ops.addText(d, a)));

  tool('update_text', 'Edits a text overlay or caption (wording, timing, color, style).', {
    textId: z.string(), text: z.string().optional(), start: z.number().optional(), end: z.number().optional(), color: z.string().optional(), style: z.enum(['title', 'caption']).optional(),
  }, a => store.edit('update_text', a, d => ops.updateText(d, a)));

  tool('remove_text', 'Removes one text overlay or caption, or all captions when textId is "all-captions".', {
    textId: z.string(),
  }, a => store.edit('remove_text', a, d => ops.removeText(d, a)));

  /* ---------- effects ---------- */

  tool('add_zoom', 'Punch-in zoom between two timeline times with smooth ease in/out. Use get_frame to aim the anchor at a face.', {
    start: z.number().min(0), end: z.number(),
    scale: z.number().min(1.01).max(3).optional().describe('Default 1.3'),
    ease: z.number().min(0).max(2).optional().describe('Ramp seconds, default 0.3'),
    anchorX: z.number().min(0).max(1).optional().describe('0 = left, 1 = right, default 0.5'),
    anchorY: z.number().min(0).max(1).optional().describe('0 = top, 1 = bottom, default 0.4'),
  }, a => store.edit('add_zoom', a, d => ops.addZoom(d, a)));

  tool('update_effect', 'Changes a zoom: timing, scale, ease or anchor.', {
    effectId: z.string(), start: z.number().optional(), end: z.number().optional(), scale: z.number().min(1.01).max(3).optional(),
    ease: z.number().min(0).max(2).optional(), anchorX: z.number().min(0).max(1).optional(), anchorY: z.number().min(0).max(1).optional(),
  }, a => store.edit('update_effect', a, d => ops.updateEffect(d, a)));

  tool('remove_effect', 'Removes an effect.', { effectId: z.string() },
    a => store.edit('remove_effect', a, d => ops.removeEffect(d, a)));

  /* ---------- the user's notes ---------- */

  tool('resolve_note', 'Marks one of the user\'s "please do" notes as done, with a short reply saying what you did. Call it after handling each note.', {
    noteId: z.string(), reply: z.string(),
  }, ({ noteId, reply }) => store.edit('resolve_note', { noteId }, d => {
    const m = d.markers.find(x => x.id === noteId);
    if (!m) throw new Error(`Note ${noteId} not found.`);
    if (m.kind === 'dont') throw new Error('"Do not touch" notes stay until the user removes them.');
    return ops.updateMarker(d, { markerId: noteId, status: 'done', reply });
  }));

  /* ---------- export ---------- */

  tool('export_video', 'Renders the timeline to an MP4 with ffmpeg and returns a download link. quality "draft" is about 2-3x faster for a quick check; "final" (default) is for publishing.', {
    quality: z.enum(['final', 'draft']).optional(),
  }, async ({ quality }) => {
      await store.waitForTurn();
      const file = await renderProject(quality);
      return `Exported ${file}. Download: ${PUBLIC_URL()}/exports/${file}` + store.drainNotes();
    });

  return server;
}

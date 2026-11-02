import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { clipEnd, duration, fmtTime, normalize, round, timelineWords } from '../shared/timeline.js';
import type { Project } from '../shared/types.js';
import { analyze } from './assets.js';
import { importFile } from './media.js';
import * as ops from './ops.js';
import { audioLevels, measureLoudness, renderContactSheet, renderJob, renderSourceFrame, renderStill, startRender, type Quality } from './render.js';
import { mediaPath } from './media.js';
import { clipAt, reframeAt, srcAt } from '../shared/timeline.js';
import { Hold, store, type EditOutcome, type StepResult } from './store.js';
import { transcribe, transcriptionEngine } from './transcribe.js';

const PUBLIC_URL = () => (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4317}`).replace(/\/$/, '');
const t3 = (x: number) => round(x, 3);
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

/* ---------- project views, sized for an agent's context ---------- */

const inRange = (s: number, e: number, a?: number, b?: number) => (a === undefined || e > a) && (b === undefined || s < b);

function itemLines(p: Project, kind: string, a?: number, b?: number): string[] {
  if (kind === 'clips') return [...p.clips].sort((x, y) => x.start - y.start).filter(c => inRange(c.start, clipEnd(c), a, b))
    .map(c => `${c.id} ${c.track} ${fmtTime(c.start)}–${fmtTime(clipEnd(c))} src ${c.in}–${c.out}s ${c.mediaId}${c.volume !== 1 ? ` vol ${Math.round(c.volume * 100)}%` : ''}${c.fadeIn ? ` fadeIn ${c.fadeIn}s` : ''}${c.fadeOut ? ` fadeOut ${c.fadeOut}s` : ''}`);
  if (kind === 'texts') return [...p.texts].sort((x, y) => x.start - y.start).filter(t => inRange(t.start, t.end, a, b))
    .map(t => `${t.id} ${t.style} ${fmtTime(t.start)}–${fmtTime(t.end)} "${t.text}"${t.color ? ` ${t.color}` : ''}`);
  if (kind === 'effects') return [...p.effects].sort((x, y) => x.start - y.start).filter(e => inRange(e.start, e.end, a, b))
    .map(e => `${e.id} zoom ${e.scale}× ${fmtTime(e.start)}–${fmtTime(e.end)} ease ${e.ease}s anchor ${e.anchorX},${e.anchorY}`);
  return [...p.markers].sort((x, y) => x.start - y.start).filter(m => inRange(m.start, m.end, a, b))
    .map(m => `${m.id} ${m.kind === 'dont' ? 'DO-NOT-TOUCH' : 'please-do'} ${m.status} ${fmtTime(m.start)}–${fmtTime(m.end)} "${m.text}"${m.reply ? ` → ${m.reply}` : ''}`);
}

function summary(p: Project) {
  const items = p.clips.length + p.texts.length + p.effects.length;
  return {
    canvas: `${p.width}x${p.height} @ ${p.fps}fps`,
    duration: duration(p),
    mode: store.control.mode,
    paused: store.control.paused,
    transcription: transcriptionEngine(),
    media: p.media.map(m => ({ id: m.id, name: m.name, kind: m.kind, duration: m.duration, size: m.width ? `${m.width}x${m.height}` : undefined, hasAudio: m.hasAudio, transcript: p.transcripts.some(t => t.mediaId === m.id) })),
    counts: {
      videoClips: p.clips.filter(c => c.track === 'video').length, audioClips: p.clips.filter(c => c.track === 'audio').length,
      captions: p.texts.filter(t => t.style === 'caption').length, titles: p.texts.filter(t => t.style === 'title').length, zooms: p.effects.length,
    },
    userNotes: itemLines(p, 'notes'),
    ...(items <= 40
      ? { clips: itemLines(p, 'clips'), texts: itemLines(p, 'texts'), effects: itemLines(p, 'effects') }
      : { items: `${items} items: use list_items with a kind and time range to see them.` }),
  };
}

const ITEM = z.object({ kind: z.string(), id: z.string() });
const EDIT_OUTPUT = {
  status: z.enum(['applied', 'rejected', 'dry-run', 'held']).describe('held = the user paused or is reviewing; call wait_for_user'),
  summary: z.string(),
  step: z.number().optional().describe('Step number in the user\'s history'),
  created: z.array(ITEM), changed: z.array(ITEM), removed: z.array(ITEM),
  blockedBy: z.string().optional().describe('Dry run only: why the edit would be refused'),
  message: z.string().describe('Full result, including any messages from the user'),
};
const DRY = { dry_run: z.boolean().optional().describe('Check what the edit would do (and whether a locked range blocks it) without changing anything') };

/* ---------- operations an agent can batch with apply_edits ---------- */

const resolveNote = (d: Project, a: { noteId: string; reply: string }): StepResult => {
  const m = d.markers.find(x => x.id === a.noteId);
  if (!m) throw new Error(`Note ${a.noteId} not found.`);
  if (m.kind === 'dont') throw new Error('"Do not touch" notes stay until the user removes them.');
  return ops.updateMarker(d, { markerId: a.noteId, status: 'done', reply: a.reply });
};

const AGENT_OPS: Record<string, (d: Project, a: any) => StepResult> = {
  add_clip: ops.addClip, update_clip: ops.updateClip, set_volume: ops.setVolume, split_clip: ops.splitClip, remove_clip: ops.removeClip, cut_range: ops.cutRange,
  remove_silences: ops.removeSilences, add_captions: ops.addCaptions,
  add_text: ops.addText, update_text: ops.updateText, remove_text: ops.removeText,
  add_zoom: ops.addZoom, update_effect: ops.updateEffect, remove_effect: ops.removeEffect,
  resolve_note: resolveNote, set_canvas: ops.setCanvas, set_ducking: ops.setDucking, set_denoise: ops.setDenoise, set_caption_style: ops.setCaptionStyle, set_reframe: ops.setReframe, set_reframe_key: ops.setReframeKey, set_speed: ops.setSpeed, add_transition: ops.addTransition, add_broll: (d: Project, a: any) => ops.addClip(d, { ...a, track: 'overlay' }),
};

/* ---------- prompts ---------- */

const PROMPTS: Record<string, { title: string; description: string; args: Record<string, z.ZodType>; text: (a: any) => string }> = {
  arabic_reel: {
    title: 'Arabic reel from a talking video',
    description: 'Vertical reel: cut pauses, Arabic word-by-word captions, a few punch-in zooms, clean audio.',
    args: { highlight: z.string().optional().describe('Caption highlight color, e.g. #f0cf6a'), focus: z.string().optional().describe('Words or moments to emphasize') },
    text: a => `Make a vertical reel in LiveCut from the video on the timeline.
1. get_project. If the canvas is not 1080x1920, set_canvas to 1080x1920.
2. transcribe the main video with language "ar" (or use set_transcript if you already have word timings).
3. remove_silences (minPause 0.5).
4. add_captions with 3 words per caption${a.highlight ? ` and highlight color ${a.highlight}` : ''}.
5. Add 3-6 short zooms (1.2-1.4×) on the strongest moments${a.focus ? `, especially: ${a.focus}` : ''}. Use get_frame on each to aim the anchor at the face. Batch them with apply_edits.
6. Check your work with get_contact_sheet over the whole video and get_audio_levels; fix anything off.
7. Respect every userNotes entry; resolve "please do" notes with resolve_note.
8. export_video with quality "draft" and give me the link.`,
  },
  clean_talking_head: {
    title: 'Clean up a talking-head video',
    description: 'Remove pauses, even out loudness, and add simple captions.',
    args: { language: z.string().optional().describe('Speech language, e.g. ar or en') },
    text: a => `Clean up the talking video in LiveCut: transcribe it${a.language ? ` (language ${a.language})` : ''}, remove_silences, check get_audio_levels and use set_volume so speech sits around -18 dB RMS without peaks above -1 dB, then add_captions. Keep edits small so I can review them, and do not touch locked ranges.`,
  },
  handle_my_notes: {
    title: 'Handle my notes on the timeline',
    description: 'Go through every open note the user pinned on the timeline.',
    args: {},
    text: () => `Read my notes in LiveCut (get_project → userNotes, or list_items kind "notes"). For each "please-do" note: look at that range (get_frame or get_contact_sheet), make the edit, then resolve_note with one sentence about what you did. Never change anything inside a DO-NOT-TOUCH range. If a note is unclear, use ask_user.`,
  },
  review_my_edit: {
    title: 'Review the current edit',
    description: 'Look and listen through the timeline and report problems without changing anything.',
    args: {},
    text: () => `Review my LiveCut timeline without editing: use get_contact_sheet across the video (in sections if it is long), get_audio_levels, and list_items for captions. Report concrete problems with timestamps: captions hanging over cuts, zooms that miss the face, jumps in loudness, black frames. Suggest fixes; do not apply them.`,
  },
};

/* ---------- the server ---------- */

export interface McpSession { subscriptions: Set<string> }

export function createMcpServer(session?: McpSession): McpServer {
  const server = new McpServer(
    { name: 'livecut', version: '0.2.0' },
    {
      capabilities: { resources: { subscribe: true, listChanged: false }, prompts: {}, tools: {} },
      instructions: [
        'LiveCut is a video editor the user watches while you edit. Every edit shows up live on their timeline as a step they can undo, compare before/after, or reject.',
        'Work in small, meaningful steps so the user can follow. Use apply_edits to batch related edits (e.g. several zooms) into one reviewable step.',
        'Edit tools return structured results with the ids they created. Add dry_run: true to check an edit first.',
        'Tool results may include messages from the user: read and follow them. If a result has status "held", call wait_for_user before editing again.',
        'Look before and after you edit: get_frame (rendered exactly like the export), get_contact_sheet for a range, get_audio_levels for loudness.',
        'Typical order: get_project → transcribe → remove_silences → add_captions → add_zoom / add_text → check → export_video (returns quickly; use get_export_status if it is still running).',
        'All times are seconds on the timeline unless a parameter says "source".',
        'The user can pin notes on the timeline (userNotes). "please-do" notes are requests: do them, then resolve_note. "DO-NOT-TOUCH" notes lock a range: edits that change anything there are refused.',
        'The user can edit by hand at any time; you will be told in tool results. Do not undo their edits. When something is ambiguous, ask_user.',
      ].join('\n'),
    },
  );

  type Ann = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  const READ: Ann = { readOnlyHint: true, openWorldHint: false };

  const reg = (name: string, title: string, description: string, shape: Record<string, z.ZodType>, annotations: Ann, run: (a: any, extra: any) => Promise<any> | any, outputSchema?: Record<string, z.ZodType>) => {
    server.registerTool(name, { title, description, inputSchema: shape as any, annotations: { title, openWorldHint: false, ...annotations }, ...(outputSchema ? { outputSchema: outputSchema as any } : {}) }, (async (args: any, extra: any) => {
      store.lastAgentSeen = Date.now();
      try {
        const r = await run(args ?? {}, extra);
        return typeof r === 'string' ? text(r) : r;
      } catch (e: any) {
        if (e instanceof Hold) {
          return outputSchema
            ? { ...text(e.message), structuredContent: { status: 'held', summary: e.message, created: [], changed: [], removed: [], message: e.message } }
            : text(e.message);
        }
        return { ...text(`Error: ${e?.message ?? e}`), isError: true };
      }
    }) as any);
  };

  const result = (o: EditOutcome) => ({ ...text(o.text), structuredContent: { status: o.status, summary: o.summary, step: o.step, created: o.created, changed: o.changed, removed: o.removed, blockedBy: o.blockedBy, message: o.text } });

  /** An edit tool backed by one operation; supports dry_run and returns structured ids. */
  const editTool = (name: string, title: string, description: string, shape: Record<string, z.ZodType>, annotations: Ann, op: (d: Project, a: any) => StepResult) =>
    reg(name, title, description, { ...shape, ...DRY }, { destructiveHint: false, ...annotations }, async ({ dry_run, ...a }) =>
      result(await store.editDetailed(name, a, d => op(d, a), 'agent', { dryRun: !!dry_run })), EDIT_OUTPUT);

  /* ---------- read ---------- */

  reg('get_project', 'Project overview', 'Canvas, media, counts, the user\'s notes, and (for small timelines) every item with its id. For big timelines use list_items. detail "full" returns everything in a time range.', {
    detail: z.enum(['summary', 'full']).optional(), start: z.number().optional(), end: z.number().optional(),
  }, READ, ({ detail = 'summary', start, end }) => {
    const p = store.project;
    const out: any = summary(p);
    if (detail === 'full') {
      delete out.items;
      for (const k of ['clips', 'texts', 'effects'] as const) out[k] = itemLines(p, k, start, end);
    }
    const notes = store.drainNotes();
    return { ...text(JSON.stringify(out, null, 1) + notes), structuredContent: { ...out, userMessages: notes || undefined } };
  });

  reg('list_items', 'List timeline items', 'Lists clips, texts (captions and titles), effects (zooms) or notes with ids, optionally in a time range, paginated.', {
    kind: z.enum(['clips', 'texts', 'effects', 'notes']), start: z.number().optional(), end: z.number().optional(),
    offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional().describe('Default 60'),
  }, READ, ({ kind, start, end, offset = 0, limit = 60 }) => {
    const all = itemLines(store.project, kind, start, end);
    const page = all.slice(offset, offset + limit);
    const more = offset + page.length < all.length ? `\n… ${all.length - offset - page.length} more: call again with offset ${offset + page.length}.` : '';
    return { ...text((page.join('\n') || `No ${kind} in that range.`) + more), structuredContent: { total: all.length, offset, items: page } };
  });

  reg('wait_for_user', 'Wait for the user', 'Waits until the user resumes or finishes reviewing, then returns any messages they left. Call it when a result says the user paused or is reviewing.', {}, READ,
    async () => {
      await store.waitForTurn(10 * 60_000).catch(() => { throw new Hold('Still waiting for the user. Call wait_for_user again.'); });
      return 'You can continue.' + (store.drainNotes() || ' No new messages from the user.');
    });

  reg('get_transcript', 'Transcript', 'Word-level transcript with timeline times (after cuts), paginated.', {
    start: z.number().optional(), end: z.number().optional(), limit: z.number().int().min(1).max(2000).optional().describe('Max words, default 400'),
  }, READ, ({ start = 0, end = Infinity, limit = 400 }) => {
    const all = timelineWords(store.project).filter(w => w.start >= start && w.start < end);
    if (!all.length) return store.project.transcripts.length ? 'No words in that range.' : 'No transcript yet. Call transcribe or set_transcript first.';
    const ws = all.slice(0, limit);
    return ws.map(w => `${w.start.toFixed(2)}-${w.end.toFixed(2)} ${w.text}`).join('\n') + (all.length > ws.length ? `\n… ${all.length - ws.length} more words: call again with start ${ws[ws.length - 1].end.toFixed(2)}.` : '');
  });

  reg('find_words', 'Find words', 'Finds a word or phrase in the transcript (Arabic spelling variants and diacritics are ignored). Returns timeline times.', {
    query: z.string(),
  }, READ, ({ query }) => {
    const q = String(query).split(/\s+/).map(normalize).filter(Boolean);
    const ws = timelineWords(store.project);
    const hits: { start: number; end: number; text: string }[] = [];
    for (let i = 0; i + q.length <= ws.length; i++) {
      if (q.every((x, j) => normalize(ws[i + j].text).includes(x))) hits.push({ start: ws[i].start, end: ws[i + q.length - 1].end, text: ws.slice(i, i + q.length).map(w => w.text).join(' ') });
    }
    const t = hits.length ? hits.map(h => `${h.start.toFixed(2)}-${h.end.toFixed(2)} "${h.text}"`).join('\n') : `"${query}" was not found in the transcript.`;
    return { ...text(t), structuredContent: { hits } };
  });

  reg('get_frame', 'Look at a frame', 'A still of the timeline at a time, rendered exactly like the export (zoom, captions, titles). Use it to aim zooms and check your edits.', {
    time: z.number(), width: z.number().int().min(120).max(1080).optional().describe('Image width, default 540'),
  }, READ, async ({ time, width }) => {
    const png = await renderStill(store.project, time, width);
    return { content: [{ type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text' as const, text: `Frame at ${fmtTime(time)} as it will be exported.` }] };
  });

  reg('get_source_frame', 'See the whole source frame', 'The full, uncropped source frame at a timeline time with the current crop window drawn in yellow and a 10×10 grid. Use it to aim reframing (e.g. landscape footage on a 9:16 canvas): x 0 = crop at the left edge, 1 = right edge.', {
    time: z.number(),
  }, READ, async ({ time }) => {
    const p = store.project;
    const c = clipAt(p, 'video', time);
    if (!c) throw new Error(`No video at ${time}s.`);
    const m = ops.getMedia(p, c.mediaId);
    if (!m.width || !m.height) throw new Error('This media has no picture.');
    const png = await renderSourceFrame(p, time, mediaPath(m), m.kind === 'image' ? 0 : srcAt(c, time), m.width, m.height);
    const pos = reframeAt(p.reframe, time);
    const fill = Math.abs(m.width / m.height - p.width / p.height) < 0.01;
    return { content: [{ type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text' as const, text: `Source ${m.width}x${m.height} at ${fmtTime(time)}; crop window at x ${pos.x.toFixed(2)}, y ${pos.y.toFixed(2)}.${fill ? ' The source already matches the canvas shape, so reframing has no effect.' : ''}` }] };
  });

  reg('get_contact_sheet', 'Look at a range', 'A grid of rendered frames spread across a time range, each labelled with its time. One call shows a whole section.', {
    start: z.number().optional(), end: z.number().optional(), count: z.number().int().min(1).max(16).optional().describe('Frames, default 9'),
  }, READ, async ({ start = 0, end, count = 9 }) => {
    const e = end ?? duration(store.project);
    if (e <= start) throw new Error('end must be after start.');
    const { png, times } = await renderContactSheet(store.project, start, e, count);
    return { content: [{ type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text' as const, text: `${count} frames from ${fmtTime(start)} to ${fmtTime(e)} at ${times.map(fmtTime).join(', ')}.` }] };
  });

  reg('get_audio_levels', 'Listen to levels', 'Loudness of the final mix per window, in dBFS (0 = maximum, speech usually -20 to -14 RMS). Use it before changing volume.', {
    start: z.number().optional(), end: z.number().optional(), step: z.number().min(0.1).max(30).optional().describe('Window seconds, default 1 (or longer for long ranges)'),
  }, READ, async ({ start = 0, end, step }) => {
    const e = end ?? duration(store.project);
    if (e <= start) throw new Error('end must be after start.');
    const st = step ?? Math.max(1, Math.round((e - start) / 120));
    const levels = await audioLevels(store.project, start, e, st);
    const loud = levels.filter(l => l.rms > -99);
    const avg = loud.length ? Math.round((loud.reduce((a, l) => a + l.rms, 0) / loud.length) * 10) / 10 : -99;
    const lines = levels.map(l => `${fmtTime(l.t)}  rms ${l.rms} dB  peak ${l.peak} dB${l.peak > -1 ? '  ← clipping risk' : ''}${l.rms < -45 ? '  (silent)' : ''}`);
    return { ...text(`Average ${avg} dB RMS over ${fmtTime(start)}–${fmtTime(e)}, ${st}s windows:\n${lines.join('\n')}`), structuredContent: { averageRms: avg, step: st, levels } };
  });

  reg('ask_user', 'Ask the user', 'Asks the user a question and waits for the answer (up to a few minutes). Shown in the LiveCut editor; with via "client" it uses your app\'s own prompt when supported.', {
    question: z.string(), options: z.array(z.string()).max(6).optional().describe('Quick answers to offer'), at: z.number().optional().describe('Timeline time the question is about'),
    via: z.enum(['editor', 'client']).optional(),
  }, READ, async ({ question, options, at, via = 'editor' }) => {
    if (via === 'client' && server.server.getClientCapabilities()?.elicitation) {
      const r = await server.server.elicitInput({
        message: question,
        requestedSchema: { type: 'object', properties: { answer: options?.length ? { type: 'string', title: 'Answer', enum: options } : { type: 'string', title: 'Answer' } }, required: ['answer'] },
      } as any);
      if (r.action !== 'accept') return `The user chose not to answer (${r.action}).`;
      return `The user answered: ${(r.content as any)?.answer}`;
    }
    const answer = await store.ask(question, options, at);
    return answer === null ? 'The user did not answer in time. Use your best judgment, or ask again later.' : `The user answered: ${answer}`;
  });

  /* ---------- media ---------- */

  reg('import_media', 'Import media', 'Imports a media file from a path on the server or an http(s) URL into the library. Users can also drag files into the editor.', {
    path: z.string().optional(), url: z.string().optional(),
  }, { openWorldHint: true, destructiveHint: false }, async ({ path: p, url }) => {
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
    const o = await store.editDetailed('import_media', { name }, d => { d.media.push(m); return { summary: `Imported ${m.name} (${m.kind}, ${m.duration}s)`, detail: `mediaId: ${m.id}` }; });
    analyze(m);
    return result(o);
  }, EDIT_OUTPUT);

  editTool('set_canvas', 'Set canvas', 'Sets the output size and frame rate, e.g. 1080x1920 for Reels/TikTok/Shorts, 1920x1080 for YouTube, 1080x1080 square.', {
    width: z.number().int(), height: z.number().int(), fps: z.number().int().optional(),
  }, { idempotentHint: true }, ops.setCanvas);

  /* ---------- clips and audio ---------- */

  editTool('add_clip', 'Add clip', 'Places a media item on the timeline. By default it is appended at the end of its track and uses the whole file.', {
    mediaId: z.string(), track: z.enum(['video', 'audio', 'overlay']).optional().describe('overlay = B-roll above the main video'),
    start: z.number().min(0).optional().describe('Timeline position; default: end of track'), end: z.number().optional().describe('Timeline end (alternative to out)'),
    layout: z.union([z.enum(['full', 'top-half', 'bottom-half', 'pip-top-right', 'pip-top-left', 'pip-bottom-right', 'pip-bottom-left']), z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })]).optional().describe('Overlay only'),
    in: z.number().min(0).optional().describe('Source in-point'), out: z.number().optional().describe('Source out-point'),
    volume: z.number().min(0).max(2).optional(),
  }, {}, ops.addClip);

  editTool('update_clip', 'Update clip', 'Moves or trims a clip, or sets its volume (1 = original, 0.5 = half, 2 = double) and fade in/out seconds.', {
    clipId: z.string(), start: z.number().min(0).optional(), in: z.number().min(0).optional(), out: z.number().optional(),
    volume: z.number().min(0).max(2).optional(), fadeIn: z.number().min(0).optional(), fadeOut: z.number().min(0).optional(),
    denoise: z.boolean().optional().describe('Background-noise reduction (applied on export)'),
    videoFadeIn: z.number().min(0).optional().describe('Seconds of fade from black at the start'), videoFadeOut: z.number().min(0).optional().describe('Seconds of fade to black at the end'),
    layout: z.union([z.enum(['full', 'top-half', 'bottom-half', 'pip-top-right', 'pip-top-left', 'pip-bottom-right', 'pip-bottom-left']), z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })]).optional().describe('B-roll clips: where on the canvas'),
  }, { idempotentHint: true }, ops.updateClip);

  editTool('add_broll', 'Add B-roll', 'Puts a video or image over the main video for a while (full frame or picture-in-picture), muted by default, so the speaker keeps talking underneath. It moves with the speech if pauses are cut later.', {
    mediaId: z.string(), start: z.number().min(0), end: z.number(), in: z.number().min(0).optional().describe('Source in-point, default 0'),
    layout: z.union([z.enum(['full', 'top-half', 'bottom-half', 'pip-top-right', 'pip-top-left', 'pip-bottom-right', 'pip-bottom-left']), z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })]).optional().describe('Default full'),
    volume: z.number().min(0).max(2).optional().describe('Default 0 (muted)'),
  }, {}, (d, a) => ops.addClip(d, { ...a, track: 'overlay' }));

  editTool('set_speed', 'Change speed', 'Plays one clip or a time range of the video track faster or slower (0.25–4×, audio keeps its pitch). Everything after it, including captions and zooms, moves to stay in sync.', {
    speed: z.number().min(0.25).max(4), clipId: z.string().optional(), start: z.number().optional(), end: z.number().optional(),
  }, {}, ops.setSpeed);

  editTool('add_transition', 'Add a transition', 'Fade through black at a cut between two video clips (at = the cut time), or fade in from black at 0 / fade out at the end.', {
    at: z.number(), duration: z.number().min(0.1).max(3).optional().describe('Seconds, default 0.6'),
  }, {}, ops.addTransition);

  editTool('set_ducking', 'Duck music under speech', 'Turns the music (audio track) down automatically while people talk, following the transcript, and back up in pauses. Same curve in the preview and the export.', {
    enabled: z.boolean().optional().describe('false turns it off'), amount: z.number().min(-40).max(-1).optional().describe('dB, default -12'),
    attack: z.number().min(0).max(2).optional().describe('Seconds to fade down before speech, default 0.3'), release: z.number().min(0).max(3).optional().describe('Seconds to come back up, default 0.6'),
  }, { idempotentHint: true }, ops.setDucking);

  editTool('set_denoise', 'Reduce background noise', 'Turns noise reduction on or off for one clip, one track, or every clip with audio. Applied on export (and in get_audio_levels).', {
    enabled: z.boolean(), clipId: z.string().optional(), track: z.enum(['video', 'audio', 'overlay']).optional(),
  }, { idempotentHint: true }, ops.setDenoise);

  reg('normalize_loudness', 'Normalize loudness', 'Measures the whole mix and sets a gain so it hits a loudness target (default -14 LUFS for TikTok/Reels/YouTube), with peaks limited to -1 dB. Re-run after big audio changes. off: true removes it.', {
    target: z.number().min(-30).max(-6).optional(), off: z.boolean().optional(), ...DRY,
  }, { idempotentHint: true, destructiveHint: false }, async ({ target, off, dry_run }) => {
    if (off) return result(await store.editDetailed('normalize_loudness', { off }, d => ops.setLoudness(d, { off: true }), 'agent', { dryRun: !!dry_run }));
    const measured = Math.round((await measureLoudness(store.project)) * 10) / 10;
    return result(await store.editDetailed('normalize_loudness', { target }, d => ops.setLoudness(d, { target, measured }), 'agent', { dryRun: !!dry_run }));
  }, EDIT_OUTPUT);

  editTool('set_volume', 'Set volume', 'Sets the volume over a timeline range (clips are split at the edges), or for one clip. 1 = original, 0 = mute, up to 2.', {
    volume: z.number().min(0).max(2), start: z.number().optional(), end: z.number().optional(),
    clipId: z.string().optional(), track: z.enum(['video', 'audio', 'overlay']).optional().describe('Limit to one track; default all'),
  }, { idempotentHint: true }, ops.setVolume);

  editTool('split_clip', 'Split clip', 'Splits a clip in two at a timeline time.', { clipId: z.string(), at: z.number() }, {}, ops.splitClip);

  editTool('remove_clip', 'Remove clip', 'Removes a clip. With ripple (default) later clips on the same track move left to close the gap.', {
    clipId: z.string(), ripple: z.boolean().optional(),
  }, { destructiveHint: true }, ops.removeClip);

  editTool('cut_range', 'Cut out a range', 'Removes a time range from the whole video (all tracks, texts, zooms) and closes the gap.', {
    start: z.number(), end: z.number(),
  }, { destructiveHint: true }, ops.cutRange);

  /* ---------- transcript ---------- */

  reg('transcribe', 'Transcribe', 'Transcribes speech in a media item with word timings (local Whisper on the server, or a speech-to-text API). Required before captions, find_words and remove_silences. Long files take a while; progress is reported.', {
    mediaId: z.string(), language: z.string().optional().describe('e.g. "ar" for Arabic, "en"'),
  }, { openWorldHint: true, destructiveHint: false, idempotentHint: true }, async ({ mediaId, language }, extra) => {
    await store.waitForTurn();
    const m = ops.getMedia(store.project, mediaId);
    const token = extra?._meta?.progressToken;
    const tr = await transcribe(m, language, p => { if (token !== undefined) extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round(p * 100), total: 100, message: 'Transcribing' } }).catch(() => {}); });
    return result(await store.editDetailed('transcribe', { mediaId, language }, d => {
      d.transcripts = d.transcripts.filter(t => t.mediaId !== mediaId).concat(tr);
      return { summary: `Transcribed ${m.name}: ${tr.words.length} words`, detail: tr.words.slice(0, 40).map(w => w.text).join(' ') + (tr.words.length > 40 ? ' …' : '') };
    }));
  }, EDIT_OUTPUT);

  editTool('set_transcript', 'Set transcript', 'Stores a word-level transcript you already have for a media item. Times are in SOURCE seconds of that file.', {
    mediaId: z.string(), language: z.string().optional(),
    words: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })),
  }, { idempotentHint: true }, (d, { mediaId, language, words }) => {
    const m = ops.getMedia(d, mediaId);
    d.transcripts = d.transcripts.filter(t => t.mediaId !== mediaId).concat({ mediaId, language, words });
    return { summary: `Transcript set for ${m.name}: ${words.length} words` };
  });

  editTool('remove_silences', 'Remove pauses', 'Cuts pauses out of video-track clips that have a transcript and closes the gaps. Captions, zooms and notes move with the speech. Limit it with start/end, e.g. to skip a locked range.', {
    minPause: z.number().min(0.1).optional().describe('Pauses longer than this are removed (default 0.6s)'),
    padding: z.number().min(0).optional().describe('Kept around speech (default 0.12s)'),
    start: z.number().optional().describe('Only remove pauses after this time'), end: z.number().optional().describe('Only remove pauses before this time'),
  }, { destructiveHint: true }, ops.removeSilences);

  /* ---------- text ---------- */

  editTool('add_captions', 'Add captions', 'Creates word-by-word captions from the transcript (the spoken word is highlighted, karaoke style). Replaces existing captions in the range.', {
    start: z.number().optional(), end: z.number().optional(),
    wordsPerCaption: z.number().int().min(1).max(8).optional().describe('Default 3'),
    color: z.string().optional().describe('Highlight color, e.g. #f0cf6a'),
    preset: z.enum(['karaoke', 'box', 'pop', 'minimal', 'bold']).optional().describe('Look: karaoke (default, spoken word highlighted), box (dark box behind), pop (one big word at a time), minimal (small, no outline), bold (yellow, heavy)'),
    position: z.enum(['bottom', 'middle', 'top']).optional().describe('Default bottom'),
  }, {}, ops.addCaptions);

  editTool('set_reframe', 'Reframe (all keys)', 'Sets where the crop window sits over time when the video does not fill the canvas, e.g. landscape footage on a vertical canvas. Keys ease smoothly; x/y 0 = left/top, 0.5 = center, 1 = right/bottom. An empty list re-centers.', {
    keys: z.array(z.object({ time: z.number(), x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional() })).max(500),
  }, { idempotentHint: true }, ops.setReframe);

  editTool('set_reframe_key', 'Reframe at one time', 'Adds or moves one crop keyframe (or removes it with remove: true).', {
    time: z.number(), x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional(), remove: z.boolean().optional(),
  }, { idempotentHint: true }, ops.setReframeKey);

  editTool('set_caption_style', 'Caption style', 'Changes the look and position of all captions (or those in a range) in one step. Check the result with get_frame.', {
    preset: z.enum(['karaoke', 'box', 'pop', 'minimal', 'bold']).optional(), position: z.enum(['bottom', 'middle', 'top']).optional(), color: z.string().optional().describe('Highlight color'),
    start: z.number().optional(), end: z.number().optional(),
  }, { idempotentHint: true }, ops.setCaptionStyle);

  editTool('add_text', 'Add text', 'Adds a text overlay. style "title" sits near the top in large type; "caption" sits near the bottom.', {
    text: z.string(), start: z.number().min(0), end: z.number(), style: z.enum(['title', 'caption']).optional(), color: z.string().optional(),
  }, {}, ops.addText);

  editTool('update_text', 'Update text', 'Edits a text overlay or caption (wording, timing, color, style).', {
    textId: z.string(), text: z.string().optional(), start: z.number().optional(), end: z.number().optional(), color: z.string().optional(), style: z.enum(['title', 'caption']).optional(),
    preset: z.enum(['karaoke', 'box', 'pop', 'minimal', 'bold']).optional(), position: z.enum(['bottom', 'middle', 'top']).optional(),
  }, { idempotentHint: true }, ops.updateText);

  editTool('remove_text', 'Remove text', 'Removes one text overlay or caption, or all captions when textId is "all-captions".', {
    textId: z.string(),
  }, { destructiveHint: true }, ops.removeText);

  /* ---------- effects ---------- */

  editTool('add_zoom', 'Add zoom', 'Punch-in zoom between two timeline times with smooth ease in/out. Use get_frame to aim the anchor at a face.', {
    start: z.number().min(0), end: z.number(),
    scale: z.number().min(1.01).max(3).optional().describe('Default 1.3'),
    ease: z.number().min(0).max(2).optional().describe('Ramp seconds, default 0.3'),
    anchorX: z.number().min(0).max(1).optional().describe('0 = left, 1 = right, default 0.5'),
    anchorY: z.number().min(0).max(1).optional().describe('0 = top, 1 = bottom, default 0.4'),
  }, {}, ops.addZoom);

  editTool('update_effect', 'Update zoom', 'Changes a zoom: timing, scale, ease or anchor.', {
    effectId: z.string(), start: z.number().optional(), end: z.number().optional(), scale: z.number().min(1.01).max(3).optional(),
    ease: z.number().min(0).max(2).optional(), anchorX: z.number().min(0).max(1).optional(), anchorY: z.number().min(0).max(1).optional(),
  }, { idempotentHint: true }, ops.updateEffect);

  editTool('remove_effect', 'Remove zoom', 'Removes an effect.', { effectId: z.string() }, { destructiveHint: true }, ops.removeEffect);

  /* ---------- projects ---------- */

  reg('list_projects', 'List projects', 'All projects on this server; the open one is marked. Edits always apply to the open project.', {}, READ, () => {
    const ps = store.listProjects();
    return { ...text(ps.map(p => `${p.id} "${p.name}"${p.current ? ' (open)' : ''} · updated ${new Date(p.updated).toISOString().slice(0, 16).replace('T', ' ')}`).join('\n')), structuredContent: { projects: ps } };
  });
  reg('open_project', 'Open a project', 'Switches the editor (and you) to another project. The user sees the switch.', { projectId: z.string() }, { destructiveHint: false, idempotentHint: true }, ({ projectId }) => {
    store.openProject(projectId);
    return `Opened "${store.project.name}".`;
  });
  reg('create_project', 'New project', 'Creates an empty project and opens it.', { name: z.string().optional() }, { destructiveHint: false }, ({ name }) => {
    const p = store.createProject(name);
    return { ...text(`Created and opened "${p.name}" (${p.id}).`), structuredContent: { id: p.id, name: p.name } };
  });
  reg('rename_project', 'Rename project', 'Renames the open project.', { name: z.string() }, { destructiveHint: false, idempotentHint: true }, ({ name }) => { store.renameProject(name); return `Renamed to "${store.project.name}".`; });
  reg('get_review_link', 'Review link', 'A link for a client or teammate to watch the open project and pin notes for you, without being able to edit. Creates it on first use.', {}, { destructiveHint: false, idempotentHint: true }, () => {
    const token = store.ensureReviewToken();
    return { ...text(`${PUBLIC_URL()}/review/${token}`), structuredContent: { url: `${PUBLIC_URL()}/review/${token}` } };
  });

  /* ---------- versions ---------- */

  reg('save_version', 'Save a version', 'Saves the whole timeline under a name (e.g. "A - fast cuts"), to compare later or switch back to. Saving with an existing name replaces it. Use with load_version to offer the user two versions.', {
    name: z.string(),
  }, { destructiveHint: false, idempotentHint: true }, ({ name }) => {
    const v = store.saveVersion(name);
    return { ...text(`Saved version "${v.name}" (${fmtTime(v.duration)}, ${v.clips} clips, ${v.texts} texts, ${v.effects} effects).`), structuredContent: { id: v.id, name: v.name } };
  });

  reg('list_versions', 'List versions', 'Saved versions of the timeline.', {}, READ, () => {
    const vs = store.versionList();
    return { ...text(vs.length ? vs.map(v => `${v.id} "${v.name}" ${fmtTime(v.duration)} · ${v.clips} clips · ${v.texts} texts · ${v.effects} effects`).join('\n') : 'No saved versions.'), structuredContent: { versions: vs } };
  });

  reg('load_version', 'Switch to a version', 'Replaces the timeline with a saved version (by id or name). It is a normal step, so the user can undo it. Save the current state first if you need it.', {
    version: z.string(), ...DRY,
  }, { destructiveHint: true }, async ({ version, dry_run }) => {
    const v = store.findVersion(version);
    return result(await store.editDetailed('load_version', { version: v.name }, d => ops.loadVersion(d, v), 'agent', { dryRun: !!dry_run }));
  }, EDIT_OUTPUT);

  /* ---------- notes ---------- */

  editTool('resolve_note', 'Resolve a note', 'Marks one of the user\'s "please-do" notes as done, with a short reply saying what you did.', {
    noteId: z.string(), reply: z.string(),
  }, { idempotentHint: true }, resolveNote);

  /* ---------- batch ---------- */

  reg('apply_edits', 'Apply several edits', `Applies several edits in order as ONE step the user can review or undo at once, all or nothing. ops: ${Object.keys(AGENT_OPS).join(', ')}. Each edit's args are the same as that tool's.`, {
    edits: z.array(z.object({ op: z.enum(Object.keys(AGENT_OPS) as [string, ...string[]]), args: z.record(z.string(), z.any()) })).min(1).max(200),
    summary: z.string().optional().describe('One line describing the batch, shown to the user'), ...DRY,
  }, { destructiveHint: true }, async ({ edits, summary: label, dry_run }) => result(await store.editDetailed('apply_edits', { count: edits.length, summary: label }, d => {
    const parts: string[] = [];
    let at: number | undefined;
    edits.forEach((e: { op: string; args: any }, i: number) => {
      try {
        const r = AGENT_OPS[e.op](d, e.args ?? {});
        parts.push(r.summary);
        if (at === undefined && r.at !== undefined) at = r.at;
      } catch (err: any) { throw new Error(`Edit ${i + 1} (${e.op}) failed: ${err.message}. Nothing was changed.`); }
    });
    return { summary: label ? `${label} (${edits.length} edits)` : `${edits.length} edits: ${parts.slice(0, 3).join('; ')}${parts.length > 3 ? '; …' : ''}`, at, detail: parts.map((x, i) => `${i + 1}. ${x}`).join('\n') };
  }, 'agent', { dryRun: !!dry_run })), EDIT_OUTPUT);

  /* ---------- export ---------- */

  const exportStatus = async (waitSec: number, extra: any) => {
    const token = extra?._meta?.progressToken;
    const deadline = Date.now() + waitSec * 1000;
    let lastSent = -1;
    while (store.render.status === 'rendering' && Date.now() < deadline) {
      const pct = Math.round(store.render.progress * 100);
      if (token !== undefined && pct !== lastSent) {
        lastSent = pct;
        await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: pct, total: 100, message: `Exporting ${pct}%` } }).catch(() => {});
      }
      await new Promise(r => setTimeout(r, 500));
    }
    const r = store.render;
    const link = r.file ? `${PUBLIC_URL()}/exports/${r.file}` : undefined;
    const msg = r.status === 'done' ? `Exported ${r.file} with ${r.encoder ?? 'x264'}. Download: ${link}`
      : r.status === 'rendering' ? `Export still running (${Math.round(r.progress * 100)}%). Call get_export_status to keep waiting.`
      : r.status === 'error' ? `Export failed: ${r.error}` : 'No export has been started.';
    return { ...text(msg + store.drainNotes()), structuredContent: { status: r.status, progress: Math.round(r.progress * 100) / 100, file: r.file, url: r.status === 'done' ? link : undefined, error: r.error, encoder: r.encoder } };
  };
  const EXPORT_OUTPUT = { status: z.enum(['idle', 'rendering', 'done', 'error']), progress: z.number(), file: z.string().optional(), url: z.string().optional(), error: z.string().optional(), encoder: z.string().optional() };

  reg('export_video', 'Export video', 'Starts rendering the timeline to an MP4 and waits up to wait_seconds (default 45) with progress updates. If it is not done by then it keeps running: call get_export_status. quality "draft" is 2-3x faster for checking.', {
    quality: z.enum(['final', 'draft']).optional(), wait_seconds: z.number().min(0).max(110).optional(),
  }, { destructiveHint: false }, async ({ quality, wait_seconds = 45 }, extra) => {
    await store.waitForTurn();
    if (!renderJob()) {
      if (!store.project.clips.length) throw new Error('The timeline is empty. Add a clip first.');
      startRender(quality as Quality | undefined).catch(() => { /* the status carries the error */ });
      await new Promise(r => setTimeout(r, 50));
    }
    return exportStatus(wait_seconds, extra);
  }, EXPORT_OUTPUT);

  reg('get_export_status', 'Export status', 'Waits up to wait_seconds (default 45) for the running export, with progress updates, and returns the download link when done.', {
    wait_seconds: z.number().min(0).max(110).optional(),
  }, READ, ({ wait_seconds = 45 }, extra) => exportStatus(wait_seconds, extra), EXPORT_OUTPUT);

  /* ---------- resources (with subscriptions) ---------- */

  const json = (uri: string, v: unknown) => ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(v, null, 1) }] });
  server.registerResource('project', 'livecut://project', { title: 'Project overview', description: 'Same as get_project. Subscribe to hear about every change.', mimeType: 'application/json' },
    uri => json(uri.href, summary(store.project)));
  server.registerResource('notes', 'livecut://notes', { title: 'The user\'s notes', description: 'Notes and locks the user pinned on the timeline. Subscribe to hear about new ones right away.', mimeType: 'application/json' },
    uri => json(uri.href, store.project.markers));
  server.registerResource('transcript', 'livecut://transcript', { title: 'Transcript', description: 'Word timings on the timeline.', mimeType: 'text/plain' },
    uri => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: timelineWords(store.project).map(w => `${w.start.toFixed(2)}-${w.end.toFixed(2)} ${w.text}`).join('\n') }] }));
  server.registerResource('history', 'livecut://history', { title: 'Edit history', description: 'Every step so far, by the agent and the user.', mimeType: 'application/json' },
    uri => json(uri.href, store.steps.map(s => ({ n: s.n, by: s.by, tool: s.tool, summary: s.summary, status: s.status, undone: s.undone, feedback: s.feedback }))));
  if (session) {
    server.server.setRequestHandler(SubscribeRequestSchema, async req => { session.subscriptions.add(req.params.uri); return {}; });
    server.server.setRequestHandler(UnsubscribeRequestSchema, async req => { session.subscriptions.delete(req.params.uri); return {}; });
  }

  /* ---------- prompts ---------- */

  for (const [name, pr] of Object.entries(PROMPTS)) {
    server.registerPrompt(name, { title: pr.title, description: pr.description, argsSchema: pr.args as any }, ((args: any) => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: pr.text(args ?? {}) } }],
    })) as any);
  }

  void t3;
  return server;
}

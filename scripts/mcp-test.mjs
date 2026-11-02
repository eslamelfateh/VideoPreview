/**
 * Checks every MCP feature against a running server, the way a client uses them:
 * sessions, annotations, structured output, dry runs, batches, locks, rendered
 * frames, contact sheets, audio levels, questions (editor + elicitation),
 * resources with subscriptions, prompts, async export with progress.
 * Usage: node scripts/mcp-test.mjs <video> [music] [out-dir]
 * Run the server with LIVECUT_WAIT_MS=5000 so the "held" check is quick.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema, ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const BASE = process.env.LIVECUT_URL ?? 'http://127.0.0.1:4317';
const [video, music, outDir = '.'] = process.argv.slice(2);
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`); };
const api = (p, body) => fetch(`${BASE}/api${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(100); } return null; }

const client = new Client({ name: 'mcp-test', version: '0' }, { capabilities: { elicitation: {} } });
client.setRequestHandler(ElicitRequestSchema, async req => ({ action: 'accept', content: { answer: req.params.requestedSchema.properties.answer.enum?.[1] ?? 'from the client' } }));
const updates = [];
client.setNotificationHandler(ResourceUpdatedNotificationSchema, n => { updates.push(n.params.uri); });
const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
await client.connect(transport);
const call = async (name, args = {}, opts = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000, ...opts });
  return { ...r, text: r.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '' };
};

try {
  /* setup */
  await api('/reset', {});
  const form = new FormData();
  form.append('files', new Blob([fs.readFileSync(video)]), path.basename(video));
  if (music) form.append('files', new Blob([fs.readFileSync(music)]), path.basename(music));
  await fetch(`${BASE}/api/media`, { method: 'POST', body: form });

  /* 1. sessions and discovery */
  check('session established', !!transport.sessionId, transport.sessionId?.slice(0, 8));
  const tools = (await client.listTools()).tools;
  const t = Object.fromEntries(tools.map(x => [x.name, x]));
  check('tools carry annotations', t.get_project.annotations?.readOnlyHint === true && t.cut_range.annotations?.destructiveHint === true && t.update_clip.annotations?.idempotentHint === true);
  check('edit tools declare an output schema', !!t.add_zoom.outputSchema && !!t.apply_edits.outputSchema && !!t.export_video.outputSchema);
  check('all new tools present', ['list_items', 'apply_edits', 'get_contact_sheet', 'get_audio_levels', 'ask_user', 'get_export_status'].every(n => t[n]), `${tools.length} tools`);
  const prompts = (await client.listPrompts()).prompts;
  const reel = await client.getPrompt({ name: 'arabic_reel', arguments: { highlight: '#ff0' } });
  check('prompts', prompts.length === 4 && /#ff0/.test(reel.messages[0].content.text), prompts.map(p => p.name).join(', '));
  const resources = (await client.listResources()).resources;
  check('resources listed', ['livecut://project', 'livecut://notes', 'livecut://transcript', 'livecut://history'].every(u => resources.some(r => r.uri === u)));

  /* 2. compact project view */
  const gp = await call('get_project');
  const vMedia = gp.structuredContent.media.find(m => m.kind === 'video');
  check('get_project is a compact summary with structured data', gp.structuredContent.counts.videoClips === 1 && gp.text.length < 4000, `${gp.text.length} chars`);
  const words = [];
  for (let i = 0; i < 40; i++) words.push({ text: ['النهارده', 'هوريكم', 'إزاي', 'تعدّلوا', 'الفيديو'][i % 5], start: 0.3 + i * 0.33, end: 0.3 + i * 0.33 + 0.28 });
  await call('set_transcript', { mediaId: vMedia.id, words });
  const caps = await call('add_captions', { wordsPerCaption: 1 });
  check('structured ids from an edit', caps.structuredContent.created.length === 40 && caps.structuredContent.created.every(c => c.kind === 'text'), `${caps.structuredContent.created.length} created`);
  const gp2 = await call('get_project');
  check('big timelines point to list_items instead of dumping', !gp2.structuredContent.texts && /list_items/.test(gp2.structuredContent.items));
  const page1 = await call('list_items', { kind: 'texts', limit: 15 });
  const page3 = await call('list_items', { kind: 'texts', limit: 15, offset: 30 });
  check('list_items paginates', page1.structuredContent.items.length === 15 && page3.structuredContent.items.length === 10 && page1.structuredContent.total === 40);
  const ranged = await call('list_items', { kind: 'texts', start: 2, end: 4 });
  check('list_items filters by time', ranged.structuredContent.total > 0 && ranged.structuredContent.total < 10, `${ranged.structuredContent.total} in 2–4s`);

  /* 3. batch, dry run, locks */
  const stepsBefore = (await api('/state')).steps.length;
  const batch = await call('apply_edits', { summary: 'Three zooms', edits: [
    { op: 'add_zoom', args: { start: 1, end: 2, scale: 1.3 } }, { op: 'add_zoom', args: { start: 4, end: 5, scale: 1.4 } }, { op: 'add_zoom', args: { start: 8, end: 9 } }] });
  const s1 = await api('/state');
  check('apply_edits: three edits, one step', batch.structuredContent.created.length === 3 && s1.steps.length === stepsBefore + 1, batch.structuredContent.summary);
  const bad = await call('apply_edits', { edits: [{ op: 'add_zoom', args: { start: 10, end: 11 } }, { op: 'remove_effect', args: { effectId: 'nope' } }] });
  const s2 = await api('/state');
  check('a failing batch changes nothing', bad.isError && s2.project.effects.length === 3 && /Edit 2/.test(bad.text));
  await api('/edit', { op: 'add_note', args: { start: 6, end: 7, text: 'keep this', kind: 'dont' } });
  const dry = await call('add_zoom', { start: 6.2, end: 6.8, dry_run: true });
  const s3 = await api('/state');
  check('dry run reports a lock without changing anything', dry.structuredContent.status === 'dry-run' && /locked/.test(dry.structuredContent.blockedBy ?? '') && s3.project.effects.length === 3);
  const dry2 = await call('add_text', { text: 'Hi', start: 0, end: 1, dry_run: true });
  check('dry run of a fine edit', dry2.structuredContent.status === 'dry-run' && !dry2.structuredContent.blockedBy && dry2.structuredContent.created.length === 1 && (await api('/state')).project.texts.length === 40);

  /* 4. look and listen */
  const frame = await call('get_frame', { time: 1.5 });
  const img = frame.content.find(c => c.type === 'image');
  if (img) fs.writeFileSync(path.join(outDir, 'mcp-frame.png'), Buffer.from(img.data, 'base64'));
  check('get_frame returns a rendered image', !!img && img.data.length > 1000, img ? `${Math.round(img.data.length * 0.75 / 1024)} KB` : frame.text);
  const sheetT = Date.now();
  const sheet = await call('get_contact_sheet', { start: 0, end: 12, count: 6 });
  const simg = sheet.content.find(c => c.type === 'image');
  if (simg) fs.writeFileSync(path.join(outDir, 'mcp-sheet.png'), Buffer.from(simg.data, 'base64'));
  check('get_contact_sheet returns a grid', !!simg, `${((Date.now() - sheetT) / 1000).toFixed(1)}s ${sheet.isError ? sheet.text : ''}`);
  const lv1 = await call('get_audio_levels', { start: 0, end: 12, step: 2 });
  const lockedVol = await call('set_volume', { start: 0, end: 12, volume: 0.25 });
  check('set_volume over a locked range is refused', lockedVol.isError && /locked/.test(lockedVol.text));
  check('get_audio_levels', lv1.structuredContent?.levels?.length >= 6, `avg ${lv1.structuredContent?.averageRms} dB`);
  await call('set_volume', { start: 0, end: 5, volume: 0.25 });
  const lv1b = await call('get_audio_levels', { start: 0, end: 5, step: 1 });
  const lv2 = { structuredContent: lv1b.structuredContent };
  lv1.structuredContent = (await call('get_audio_levels', { start: 0, end: 5, step: 1 })).structuredContent;
  await call('set_volume', { start: 0, end: 5, volume: 1 });
  lv1.structuredContent = (await call('get_audio_levels', { start: 0, end: 5, step: 1 })).structuredContent;
  const drop = lv1.structuredContent.averageRms - lv2.structuredContent.averageRms;
  check('levels follow volume changes (25% ≈ -12 dB)', drop > 10 && drop < 14, `${drop.toFixed(1)} dB quieter`);

  /* 5. questions */
  const askP = call('ask_user', { question: 'Which color for captions?', options: ['Yellow', 'White'], at: 2 });
  const q = await until(async () => (await api('/state')).questions[0]);
  await api(`/questions/${q.id}/answer`, { answer: 'Yellow' });
  const ask = await askP;
  check('ask_user in the editor', /answered: Yellow/.test(ask.text) && (await api('/state')).questions.length === 0);
  const ask2 = await call('ask_user', { question: 'Pick one', options: ['A', 'B'], via: 'client' });
  check('ask_user through the client (elicitation)', /answered: B/.test(ask2.text), ask2.text);

  /* 6. subscriptions */
  await client.subscribeResource({ uri: 'livecut://notes' });
  await client.subscribeResource({ uri: 'livecut://project' });
  updates.length = 0;
  await api('/edit', { op: 'add_note', args: { start: 3, end: 4, text: 'zoom in more here' } });
  const got = await until(async () => updates.includes('livecut://notes') && updates.includes('livecut://project'), 5000);
  check('subscribers are told about a new note right away', !!got, updates.join(', '));
  const notes = JSON.parse((await client.readResource({ uri: 'livecut://notes' })).contents[0].text);
  check('reading the notes resource', notes.some(n => n.text === 'zoom in more here'));
  const res = await call('resolve_note', { noteId: notes.find(n => n.kind === 'do').id, reply: 'Zoomed in' });
  check('resolve_note', res.structuredContent.status === 'applied');

  /* 7. held while paused */
  await api('/control', { paused: true });
  const t0 = Date.now();
  const held = await call('add_zoom', { start: 9.5, end: 10 });
  await api('/control', { paused: false });
  check('paused: the agent gets status "held"', held.structuredContent?.status === 'held', `${((Date.now() - t0) / 1000).toFixed(1)}s`);

  /* 8. async export with progress */
  const progress = [];
  const ex = await call('export_video', { quality: 'draft', wait_seconds: 1 }, { onprogress: p => progress.push(p.progress), resetTimeoutOnProgress: true });
  check('export returns before finishing', ex.structuredContent.status === 'rendering' || ex.structuredContent.status === 'done', `${ex.structuredContent.status} ${Math.round(ex.structuredContent.progress * 100)}%`);
  const st = await call('get_export_status', { wait_seconds: 110 }, { onprogress: p => progress.push(p.progress), resetTimeoutOnProgress: true });
  check('get_export_status finishes with a link', st.structuredContent.status === 'done' && /^http/.test(st.structuredContent.url ?? ''), st.structuredContent.file);
  check('progress notifications arrived', progress.length > 0, `${progress.length} updates`);
  const head = await fetch(st.structuredContent.url);
  check('download link works', head.ok && Number(head.headers.get('content-length')) > 10000);

  /* 9. pauses: captions, zooms and locks move with the speech; a pause inside a lock is protected */
  await api('/reset', {});
  const f2 = new FormData();
  f2.append('files', new Blob([fs.readFileSync(video)]), path.basename(video));
  await fetch(`${BASE}/api/media`, { method: 'POST', body: f2 });
  const mid = (await api('/state')).project.media[0].id;
  const w2 = [];
  for (let i = 0; i < 12; i++) { const s0 = i < 6 ? 0.5 + i * 0.5 : 6.5 + (i - 6) * 0.5; w2.push({ text: `w${i}`, start: s0, end: s0 + 0.4 }); } // a 3.1s pause at 3.4–6.5
  await call('set_transcript', { mediaId: mid, words: w2 });
  await call('add_captions', { wordsPerCaption: 2 });
  await call('add_zoom', { start: 7, end: 8 });
  await api('/edit', { op: 'add_note', args: { start: 8.5, end: 9, text: 'keep the ending', kind: 'dont' } });
  const before = await api('/state');
  const rs = await call('remove_silences', { minPause: 0.6 });
  const after = await api('/state');
  const capB = before.project.texts.find(t => t.text === 'w6 w7'), capA = after.project.texts.find(t => t.text === 'w6 w7');
  const shift = capB.start - capA.start;
  check('remove_silences after a lock elsewhere is allowed', rs.structuredContent?.status === 'applied', rs.text.split('\n')[0]);
  check('captions move with the speech', shift > 2.5 && Math.abs((capB.words[0].start - capA.words[0].start) - shift) < 0.01, `moved ${shift.toFixed(2)}s earlier`);
  check('zooms and locks move too', Math.abs((before.project.effects[0].start - after.project.effects[0].start) - shift) < 0.01 && Math.abs((before.project.markers[0].start - after.project.markers[0].start) - shift) < 0.01);
  const fr = await call('get_frame', { time: capA.start + 0.1 });
  check('the moved caption renders at its new time', fr.content.some(c => c.type === 'image'));
  await call('set_transcript', { mediaId: mid, words: w2.map(w => ({ ...w, start: w.start + 20, end: w.end + 20 })) }).catch(() => {});
  await api('/reset', {});
  const f3 = new FormData();
  f3.append('files', new Blob([fs.readFileSync(video)]), path.basename(video));
  await fetch(`${BASE}/api/media`, { method: 'POST', body: f3 });
  const mid3 = (await api('/state')).project.media[0].id;
  await call('set_transcript', { mediaId: mid3, words: w2 });
  await api('/edit', { op: 'add_note', args: { start: 3, end: 7, text: 'the pause is on purpose', kind: 'dont' } });
  const blocked = await call('remove_silences', {});
  check('a pause inside a locked range is protected', blocked.isError && /locked/.test(blocked.text));
  const partial = await call('remove_silences', { start: 7.5 });
  check('remove_silences limited to a range works around the lock', partial.structuredContent?.status === 'applied');

  /* 10. history resource */
  const hist = JSON.parse((await client.readResource({ uri: 'livecut://history' })).contents[0].text);
  check('history resource', hist.length >= 3 && hist.some(h => h.by === 'user'), `${hist.length} steps`);
} catch (e) {
  check('test run', false, e.stack);
} finally {
  await client.close();
}
const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

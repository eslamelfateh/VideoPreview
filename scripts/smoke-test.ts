/**
 * End-to-end check that drives a running LiveCut server the way an agent would.
 * Usage: npm start (in another terminal), then: npx tsx scripts/smoke-test.ts [mediaPath]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.LIVECUT_URL ?? 'http://127.0.0.1:4317';
const headers: Record<string, string> = process.env.LIVECUT_TOKEN ? { Authorization: `Bearer ${process.env.LIVECUT_TOKEN}` } : {};

const client = new Client({ name: 'smoke-test', version: '0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers } }));

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const out = r.content.map((c: any) => (c.type === 'text' ? c.text : `[${c.type} ${c.mimeType} ${c.data.length}b]`)).join('\n');
  console.log(`\n▸ ${name}${r.isError ? ' (error)' : ''}\n${out.slice(0, 600)}`);
  if (r.isError) throw new Error(out);
  return out;
};
const api = (p: string, body?: unknown) => fetch(`${BASE}/api${p}`, { method: body ? 'POST' : 'GET', headers: { ...headers, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());

const tools = await client.listTools();
console.log('tools:', tools.tools.map(t => t.name).join(', '));

if (process.argv[2]) await call('import_media', { path: process.argv[2] });
const project = JSON.parse((await call('get_project')).split('\n\nMessages')[0]);
const media = project.media.find((m: any) => m.kind === 'video');
if (!media) throw new Error('Upload or pass a video first.');
if (!project.clips.length) await call('add_clip', { mediaId: media.id });

// A fake Egyptian-Arabic transcript with a long pause in the middle.
const words = 'أهلاً النهارده هوريكم إزاي تعدّلوا الفيديو بجملة واحدة'.split(' ');
let t = 0.5;
const ws = words.map((w, i) => { const s = t; t += 0.55 + (i === 3 ? 2.5 : 0.1); return { text: w, start: s, end: s + 0.5 }; });
await call('set_transcript', { mediaId: media.id, language: 'ar', words: ws });
await call('remove_silences', {});
await call('add_captions', { wordsPerCaption: 3 });
const hit = await call('find_words', { query: 'النهاردة' }); // different spelling on purpose
const [s, e] = hit.split(' ')[0].split('-').map(Number);
await call('get_frame', { time: s });
await call('add_zoom', { start: s - 0.2, end: e + 0.4, scale: 1.35 });

// Step mode: the next edit must wait for the user's decision.
await api('/control', { mode: 'step' });
const pending = call('add_text', { text: 'خلّيك معايا', start: 0, end: 1.5, style: 'title' });
await new Promise(r => setTimeout(r, 500));
const state = await api('/state');
const review = state.steps.find((x: any) => x.status === 'review');
console.log('\nwaiting for review:', review?.tool);
await api(`/steps/${review.id}/decision`, { approve: false, note: 'خلي العنوان أصفر' });
await pending;
await api('/control', { mode: 'live' });

// Undo from the user side is reported back to the agent.
const zoomStep = (await api('/state')).steps.find((x: any) => x.tool === 'add_zoom');
await api(`/steps/${zoomStep.id}/undo`, {});
await api(`/steps/${zoomStep.id}/undo`, {});
await call('get_project');

await call('export_video');
await client.close();
console.log('\n✓ smoke test passed');

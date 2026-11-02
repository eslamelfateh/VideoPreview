# LiveCut

**An open-source video editor that AI agents drive while you watch, and review, every edit.**

Most AI video tools work in the background and hand you a finished file. LiveCut does the opposite: the agent edits a real timeline through [MCP](https://modelcontextprotocol.io), and every tool call appears live in your browser as a **step** you can inspect, undo, compare before/after, or reject before the agent moves on.

```
 you: "اعمل كابشن وزوم على النهارده"            ┌──────────── browser ────────────┐
        │                                      │  live preview     │ steps        │
        ▼                                      │  ┌────────┐       │ 03 add_capt… │
 Claude Code ──MCP──► LiveCut server ──WS────► │  │ caption│       │ 04 add_zoom  │
 (or any agent)       project.json + steps     │  └────────┘       │  [Undo][Hold]│
                            │                  │  ▓▓▓▓░░▓▓▓ timeline              │
                            └── ffmpeg ──► MP4 └──────────────────────────────────┘
```

Built Arabic-first: Egyptian/MSA transcripts, right-to-left word-by-word karaoke captions, and spelling-tolerant search (`النهاردة` finds `النهارده`). Works for any language.

## What you can do while the agent edits

| | |
|---|---|
| **Watch live** | Each edit lands on the timeline and preview as it happens. "Follow agent" moves the playhead to every change. |
| **Undo any step** | Not just the last one. If a later step touched the same items, LiveCut tells you which to undo first. |
| **Hold: before** | Press and hold on a step to see the video without it; let go to see it again. |
| **Step mode** | The agent waits after every edit until you **Accept** or **Reject** it. Your note ("slower", "make it yellow") goes back to the agent with the decision. |
| **Pause** | Stops the agent at its next edit so you can take a look. It waits until you press Resume. |
| **Message mid-edit** | Type a note at any time; it is delivered with the agent's next tool result. |
| **Edit by hand** | Drag clips, captions and zooms to move them, drag edges to trim, split with `S`. The inspector edits every detail: volume up to 200% with fades, text and colors, zoom amount/smoothness, and you click the video to aim a zoom. The agent is told about your edits. |
| **Point-by-point notes** | Drag on the ruler to select a range, then leave a note ("add a title here") or lock it ("don't touch this part"). The agent sees the notes, resolves them, and the server refuses agent edits inside locked ranges. |
| **Volume** | Per clip or over any range (`set_volume`), with a volume line and waveform drawn on the timeline. |
| **Export** | ffmpeg renders exactly what the preview shows: cuts, karaoke captions, titles, eased zooms, and mixed audio. **Quick draft** exports 2-3x faster for checking. |

## Quick start (local)

Needs Node.js 20+ and ffmpeg (with libass, the default in most builds).

```bash
git clone https://github.com/<you>/livecut && cd livecut
npm install
npm run build
npm start
```

Open http://127.0.0.1:4317, drop a video in, then connect an agent.

**Claude Code**

```bash
claude mcp add --transport http livecut http://127.0.0.1:4317/mcp
```

Then ask, for example: *"Use livecut: transcribe my video, cut the pauses, add Arabic captions and a zoom on النهارده."*

**Other MCP clients** (Cursor, Codex, Cline, …): add an HTTP MCP server pointing at `http://127.0.0.1:4317/mcp`.

For development with hot reload: `npm run dev`, then open http://localhost:5173.

## Transcription

Captions, `find_words` and `remove_silences` need word timings. LiveCut calls any OpenAI-compatible `/audio/transcriptions` endpoint:

```bash
TRANSCRIBE_API_KEY=sk-... npm start                                   # OpenAI whisper-1
TRANSCRIBE_BASE_URL=https://api.groq.com/openai/v1 \
TRANSCRIBE_MODEL=whisper-large-v3 TRANSCRIBE_API_KEY=gsk_... npm start  # Groq
```

A self-hosted faster-whisper server with an OpenAI-compatible API works too. Agents that already have word timings can call `set_transcript` instead.

## MCP tools

| Read | Edit (each one is a reviewable step) |
|---|---|
| `get_project` (includes the user's notes) · `get_transcript` · `find_words` · `get_frame` (the agent sees a frame as an image) · `wait_for_user` | `import_media` · `set_canvas` · `add_clip` · `update_clip` · `set_volume` · `split_clip` · `remove_clip` · `cut_range` · `transcribe` · `set_transcript` · `remove_silences` · `add_captions` · `add_text` · `update_text` · `remove_text` · `add_zoom` · `update_effect` · `remove_effect` · `resolve_note` · `export_video` |

The project is one JSON document (`src/shared/types.ts`): media, clips, texts, effects, transcripts. Every edit runs on a draft, gets diffed per entity, and is stored as a step with its before/after. That is what makes undo, before/after, and reject cheap.

## Deploy to the cloud

The server refuses to listen on a public interface without a token.

```bash
docker build -t livecut .
docker run -p 4317:4317 -v livecut-data:/data \
  -e LIVECUT_TOKEN=$(openssl rand -hex 24) \
  -e PUBLIC_URL=https://livecut.example.com \
  -e TRANSCRIBE_API_KEY=sk-... \
  livecut
```

- Open the editor once with `https://livecut.example.com/?token=YOUR_TOKEN`. It sets a cookie and removes the token from the address bar.
- Connect agents with the token as a header:
  ```bash
  claude mcp add --transport http livecut https://livecut.example.com/mcp --header "Authorization: Bearer YOUR_TOKEN"
  ```
- Mount `/data` on a persistent volume (Fly.io volume, Railway volume, a VPS disk). Media, exports, and project state live there.
- Put it behind HTTPS (Fly.io, Railway, Caddy, or nginx). WebSockets must be allowed on `/ws`.

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | `4317` / `127.0.0.1` | Docker sets `HOST=0.0.0.0` |
| `LIVECUT_TOKEN` | — | Required unless the server is only on localhost |
| `PUBLIC_URL` | `http://localhost:PORT` | Used in export links returned to the agent |
| `LIVECUT_DATA` | `./data` | Media, exports, state |
| `TRANSCRIBE_API_KEY` / `TRANSCRIBE_BASE_URL` / `TRANSCRIBE_MODEL` | OpenAI `whisper-1` | Speech-to-text |
| `LIVECUT_WAIT_MS` | `240000` | Longest a tool call waits on Pause/review before telling the agent to call `wait_for_user` |

## Project layout

```
src/shared/   project types, entity diff (undo/before-after), timeline math shared by preview and export
src/server/   Express + WebSocket server, MCP tools, step/review store, ffmpeg export, transcription
src/web/      React editor: preview, timeline, steps panel
scripts/      smoke-test.ts drives a running server through MCP the way an agent would
```

Check a change end to end with a running server (`npm start`):

- `npm run smoke` drives the server over MCP like an agent.
- `node scripts/e2e.mjs <video-with-speech> [music]` drives the browser like a person (upload, sliders, dragging, notes, locks, keyboard) while an MCP client plays the agent. Needs Playwright.
- `node scripts/perf.mjs <long-video>` is a load test: hundreds of clips and captions; it reports frame rate, stalls, edit latency and export time.

Measured on a 4-core container with a 10-minute video cut into 420 clips with 420 captions and 20 zooms: playback 59 fps with no stalls at cuts, edits reach the preview in ~160 ms, the editor opens in under a second, and export runs at about 0.6x real time (final) on 4 cores.

## Status and roadmap

This is an early version (0.1). Working: the full agent → live timeline → review → export loop, tested with an MCP client and a browser. Planned:

- Caption style presets and fonts, per-word emphasis
- Transitions, speed ramps, B-roll and music ducking
- Multiple projects and accounts on one server
- Async export with progress for agents, batched edits, structured tool output
- Rendered frames and contact sheets for the agent to review its own work

Contributions are welcome. Open an issue first for big changes.

## بالعربي

LiveCut محرر فيديو مفتوح المصدر. الـ AI agent، زي Claude Code، بيعدّل على timeline حقيقية، وانت بتشوف كل تعديل وهو بيحصل:
- كل تعديل بيظهر **خطوة** تقدر تعملها Undo، أو تمسك **Hold: before** وتقارن قبل وبعد.
- في **Step mode** الـ agent بيستنى موافقتك بعد كل خطوة، وتقدر ترفض وتكتبله ملاحظة.
- **Pause** بيوقف الـ agent عشان تبص بنفسك، وتقدر تبعتله رسالة في أي وقت.
- الكابشن العربي كلمة بكلمة، ومن اليمين للشمال، والتصدير بـ ffmpeg طالع زي الـ preview بالظبط.

التشغيل: `npm install && npm run build && npm start`، وبعدين:
`claude mcp add --transport http livecut http://127.0.0.1:4317/mcp`

## License

MIT. The bundled Cairo font is under the SIL Open Font License (`assets/Cairo-OFL.txt`).

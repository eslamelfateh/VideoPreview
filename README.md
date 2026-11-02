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

## Using Claude Code with ffmpeg or Remotion instead?

The **live-review** plugin in this repo adds the same "watch and stop it" review to Claude's own video edits, without LiveCut: each change shows up as a quick preview in a review page (Remotion Studio for Remotion), and your notes on a frame reach Claude while it works.

```
/plugin marketplace add eslamelfateh/VideoPreview
/plugin install live-review@videopreview
```

See [plugins/live-review](plugins/live-review/README.md).

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
| **Pro audio** | Music ducks automatically while people talk (same curve in preview and export), loudness normalization to -14 LUFS with a peak limiter, background-noise reduction. |
| **Captions** | Word-by-word, right to left, in five looks (karaoke, box, one word at a time, minimal, bold) at the bottom, middle or top. Preview and export match pixel for pixel. |
| **Reframe, speed, transitions** | Landscape footage on a vertical canvas with eased crop keyframes; 0.25–4× speed with pitch kept; fades through black. Captions and zooms stay in sync. |
| **B-roll** | Video or images over the main picture, full frame or picture-in-picture, muted by default. |
| **Versions** | Save a cut, try another, switch back (as an undoable step). The agent can make two versions for you to pick. |
| **Projects and review links** | Several projects on one server. A review link lets a client watch and pin notes for the agent, without editing. |
| **Arabic interface** | ع / EN switch; panels right to left, the timeline left to right. |
| **Export** | ffmpeg renders exactly what the preview shows, with a hardware H.264 encoder when one works (NVENC, VideoToolbox, Quick Sync) and x264 otherwise. **Quick draft** exports faster for checking. |

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

Captions, `find_words` and `remove_silences` need word timings.

**Local, no API key (default when no key is set):** install [faster-whisper](https://github.com/SYSTRAN/faster-whisper) on the server (`pip install faster-whisper`; the Docker image includes it). The model downloads on first use; `WHISPER_MODEL` picks it (`small` by default; `medium` / `large-v3` are more accurate for Egyptian Arabic). Audio never leaves the machine.

**Or an API:** any OpenAI-compatible `/audio/transcriptions` endpoint:

```bash
TRANSCRIBE_API_KEY=sk-... npm start                                   # OpenAI whisper-1
TRANSCRIBE_BASE_URL=https://api.groq.com/openai/v1 \
TRANSCRIBE_MODEL=whisper-large-v3 TRANSCRIBE_API_KEY=gsk_... npm start  # Groq
```

A self-hosted faster-whisper server with an OpenAI-compatible API works too. Agents that already have word timings can call `set_transcript` instead.

## MCP server

**Tools** (every edit is a reviewable step; edit tools return structured results with the ids they created and accept `dry_run: true`):

| Look and listen | Edit | Workflow |
|---|---|---|
| `get_project` (compact summary + the user's notes) · `list_items` (paginated, by time range) · `get_transcript` · `find_words` · `get_frame` (rendered exactly like the export) · `get_source_frame` (whole frame with the crop window, for reframing) · `get_contact_sheet` (a grid of frames across a range) · `get_audio_levels` (dBFS per window) · `list_versions` · `list_projects` | `add_clip` · `update_clip` · `set_volume` · `split_clip` · `remove_clip` · `cut_range` · `set_speed` · `add_transition` · `add_broll` · `transcribe` · `set_transcript` · `remove_silences` · `add_captions` · `set_caption_style` · `add_text` · `update_text` · `remove_text` · `add_zoom` · `update_effect` · `remove_effect` · `set_reframe` · `set_reframe_key` · `set_ducking` · `normalize_loudness` · `set_denoise` · `set_canvas` · `import_media` · `load_version` · **`apply_edits`** (many edits as one step, all or nothing) | `resolve_note` · `ask_user` (in the editor, or through the client with MCP elicitation) · `wait_for_user` · `save_version` · `open_project` · `create_project` · `rename_project` · `get_review_link` · `export_video` + `get_export_status` (returns before client timeouts, sends progress) |

- **Annotations** on every tool (`readOnlyHint`, `destructiveHint`, `idempotentHint`), so clients can auto-approve looking and ask before cutting.
- **Resources** with subscriptions: `livecut://project`, `livecut://notes`, `livecut://transcript`, `livecut://history`. A subscribed agent hears about a new note right away.
- **Prompts**: `arabic_reel`, `clean_talking_head`, `handle_my_notes`, `review_my_edit`.
- **Locks are enforced by the server**: an agent edit that would change what plays inside a "don't touch" range is refused; content that only slides (a pause cut earlier) is fine, and locks, captions, zooms and notes move with the speech.

The project is one JSON document (`src/shared/types.ts`). Every edit runs on a draft, gets diffed per entity, and is stored as a step with its before/after: that is what makes undo, before/after, reject and dry runs cheap.

## Deploy to the cloud

The server refuses to listen on a public interface without a token. Ready-made configs: `fly.toml` (Fly.io, with a volume) and `render.yaml` (Render Blueprint, with a disk). The steps are at the top of each file.

```bash
docker build -t livecut .
docker run -p 4317:4317 -v livecut-data:/data \
  -e LIVECUT_TOKEN=$(openssl rand -hex 24) \
  -e PUBLIC_URL=https://livecut.example.com \
  -e TRANSCRIBE_API_KEY=sk-... \
  livecut
```

- Open the editor once with `https://livecut.example.com/?token=YOUR_TOKEN`. It sets a cookie and removes the token from the address bar.
- **claude.ai (custom connector):** with `LIVECUT_TOKEN` and an `https://` `PUBLIC_URL`, LiveCut runs an OAuth server. Add `https://livecut.example.com/mcp` as a custom connector; the approval page asks for your LiveCut token, so only you can connect.
- Connect Claude Code (or any agent that can send headers) with the token:
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
| `LIVECUT_WHISPER` / `WHISPER_MODEL` / `WHISPER_PYTHON` | `auto` / `small` / `python3` | Local transcription (`off` disables it) |
| `LIVECUT_ENCODER` | `auto` | `nvenc`, `videotoolbox`, `qsv` or `x264` to force an encoder |

## Project layout

```
src/shared/   project types, entity diff (undo/before-after), timeline math shared by preview and export
src/server/   Express + WebSocket server, MCP tools, step/review store, ffmpeg export, transcription
src/web/      React editor: preview, timeline, inspector, steps panel, review page, Arabic/English
scripts/      end-to-end tests that drive a running server like an agent and a person
```

Check a change end to end with a running server (`npm start`):

- `npm run smoke` drives the server over MCP like an agent.
- `node scripts/e2e.mjs <video-with-speech> [music]` drives the browser like a person (upload, sliders, dragging, notes, locks, keyboard) while an MCP client plays the agent. Needs Playwright.
- `node scripts/mcp-test.mjs <video> [music]` checks every MCP feature (sessions, annotations, structured output, dry runs, batches, locks, frames, contact sheets, audio levels, questions, subscriptions, prompts, async export). Run the server with `LIVECUT_WAIT_MS=5000`.
- `node scripts/features-test.mjs <video> <music>` checks the editing features against real output: proxies, transcription, ducking (measured in dB), loudness (measured in LUFS), caption styles, speed (lengths), transitions (brightness), reframing and B-roll (pixel comparison), versions. Use `WHISPER_SCRIPT=scripts/fake_whisper.py` on the server when no Whisper model is available, and `LANDSCAPE=<16:9 video>` for reframing and B-roll.
- `node scripts/projects-test.mjs <video> <other-video>` checks projects and review links, including that a review link cannot reach the editor API or other projects' media.
- `node scripts/oauth-test.mjs` walks the OAuth connector flow against a server with `LIVECUT_TOKEN` and `PUBLIC_URL`.
- GitHub Actions (`.github/workflows/ci.yml`) runs all of these on every push, with synthetic test media.
- `node scripts/perf.mjs <long-video>` is a load test: hundreds of clips and captions; it reports frame rate, stalls, edit latency and export time.

Measured on a 4-core container with a 10-minute video cut into 420 clips with 420 captions and 20 zooms (0.2 build): playback 60 fps with no stalls at cuts (three runs), scrubbing ~29 ms per move, edits reach the preview in ~160–230 ms, the editor opens in about a second, and the 7.3-minute result exports in 217 s (final) on 4 cores. While a long video's preview proxy is still being made in the background, playback can dip to ~56 fps on a 4-core machine.

## Status and roadmap

Version 0.2. Working and tested end to end: the agent → live timeline → review → export loop, hand editing, pro audio, captions, reframing, speed, transitions, B-roll, versions, projects, review links, OAuth. Not tested yet: a real Whisper model on real Egyptian Arabic speech (tests use synthetic speech), and hardware encoders on real GPUs (only the fallback is tested). Ideas next:

- Turn one long video into several short reels (strongest moments, each as a version)
- Brand kit: logo, intro/outro, colors and fonts saved once
- Bilingual captions and translation; accounts and S3/R2 storage

Contributions are welcome. Open an issue first for big changes.

## بالعربي

LiveCut محرر فيديو مفتوح المصدر. الـ AI agent، زي Claude Code، بيعدّل على timeline حقيقية، وانت بتشوف كل تعديل وهو بيحصل:
- كل تعديل بيظهر **خطوة** تقدر تعملها Undo، أو تمسك **Hold: before** وتقارن قبل وبعد.
- في **Step mode** الـ agent بيستنى موافقتك بعد كل خطوة، وتقدر ترفض وتكتبله ملاحظة.
- **Pause** بيوقف الـ agent عشان تبص بنفسك، وتقدر تبعتله رسالة في أي وقت.
- الكابشن العربي كلمة بكلمة، ومن اليمين للشمال، بخمس ستايلات، والتصدير بـ ffmpeg طالع زي الـ preview بالظبط.
- تعدّل بإيدك أي حاجة، وتسيب ملاحظات أو تقفل أجزاء على الـ timeline، وتوطّي وتعلّي الصوت.
- الموسيقى بتوطى لوحدها وقت الكلام، وB-roll، وسرعة، وانتقالات، وتحويل الفيديو الأفقي لرأسي.
- نسخ تقارن بينها، وأكتر من مشروع، ولينك مراجعة للعميل، وواجهة بالعربي.

التشغيل: `npm install && npm run build && npm start`، وبعدين:
`claude mcp add --transport http livecut http://127.0.0.1:4317/mcp`

## License

MIT. The bundled Cairo font is under the SIL Open Font License (`assets/Cairo-OFL.txt`).

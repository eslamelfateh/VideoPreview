# live-review

Watch Claude edit your video **while it works**, and stop it at any moment.

When Claude edits a video in Claude Code (with **ffmpeg** or **Remotion**), you usually see nothing until the final render, and then you start asking for changes. With this plugin:

- Every change shows up in a review page as a **quick preview of just the part that changed** (a few seconds to make, low resolution), not a full render.
- With **Remotion**, the page shows Remotion Studio, which updates live as Claude edits the code.
- Pause on any frame and write what you want: **Send note**, or **Stop & change this**. The note (with a screenshot of that frame) reaches Claude after its current command, while it is still working.
- Claude cannot say "done" while one of your notes is still open; each note shows Claude's reply when it is handled.

## Install

```
/plugin marketplace add eslamelfateh/VideoPreview
/plugin install live-review@videopreview
```

Needs Node.js 18+ and ffmpeg. For Remotion, your project's own Remotion setup.

## Use

Ask Claude to edit a video as usual, e.g. *"قص أول ثانية وحط عنوان Welcome فوق في أول 3 ثواني"*. Claude starts the review page and gives you its address (http://127.0.0.1:4320/). Open it next to the chat.

| You | Claude |
|---|---|
| Watch each step's preview as it appears | Makes one change at a time and shows it (`live-review step`) |
| Pause, write a note, Send / Stop & change | Gets the note with the time and a screenshot, makes the change, shows it, marks the note done |
| Approve | Renders the full video once, at the end |

## How it works

- `bin/live-review.mjs`: a small server (no dependencies) for the review page, and the CLI Claude uses (`start`, `step`, `notes`, `done`, `remotion`).
- `skills/live-review`: tells Claude to work in small steps, preview only what changed, and render the full video last.
- `hooks/hooks.json`: after each tool call (and when you send a message) new notes are added to Claude's context; the Stop hook keeps Claude working while notes are open.
- State lives in `.live-review/` in your project (ignored by git): steps, notes, screenshots, previews.

The page listens on 127.0.0.1 only. `LIVE_REVIEW_PORT` changes the port.

## بالعربي

وانت بتخلّي Claude يعدّل فيديو بـ ffmpeg أو Remotion، بتفتح صفحة المراجعة جنب الشات:
- كل تعديل بيظهر فيها معاينة سريعة للجزء اللي اتغير بس. مع Remotion الـ Studio نفسه بيتحدّث لحظياً.
- توقف على أي لحظة وتكتب "لأ، الحتة دي كذا"، فتوصل لـ Claude بالوقت وصورة الفريم وهو لسه شغال.
- Claude مش بيقدر يقول "خلصت" وفيه ملاحظة منك لسه مفتوحة.

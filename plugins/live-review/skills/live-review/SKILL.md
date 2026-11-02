---
name: live-review
description: Use whenever you edit or make a video for the user with ffmpeg or Remotion (cutting, trimming, captions, titles, zooms, music, color, speed, transitions, rendering). Shows each change to the user as you go in a live review page, as a quick preview of just the part that changed instead of one full render at the end, so they can stop you at any moment with a note on the exact frame.
---

# Live review for video edits

The user wants to watch your edit as it happens and stop you when something is off,
instead of waiting for a full render and then asking for changes. Work in small steps
and show each one.

The CLI is `bin/live-review.mjs` in this plugin (two folders up from this skill's
base directory). Run it with `node`. Below, `LR` means `node "<plugin>/bin/live-review.mjs"`.

## 1. Start the review page (once per task)

```bash
LR start
```

It prints a URL (http://127.0.0.1:4320/). Tell the user to open it next to the chat
**before** you start editing. If the user is on another machine, say so plainly.

For Remotion projects, also start Remotion Studio and show it in the page; the Studio
updates live on every code change, with no rendering:

```bash
npx remotion studio --port 3000 &   # in the Remotion project
LR remotion http://localhost:3000
```

## 2. After every meaningful change, show it

One step = one idea the user can judge: "cut the first 2 s", "add captions", "title at
the top", "zoom on the face at 00:12", "music at 30%".

**ffmpeg:** do not render the whole video after each change. Make the change, then show
only the part it affects (with half a second of context), at low resolution:

```bash
LR step "Title 'Welcome' at the top" --source work/edit.mp4 --start 0 --end 3
```

The preview takes a few seconds. If you render work in pieces, point `--source` at the
piece you just made. For a still you already rendered: `LR step "Thumbnail" --file thumb.png`.

**Remotion:** the Studio already shows the change. Log what you changed and where, so the
user can follow:

```bash
LR step "Captions: yellow highlight on the spoken word" --at 4.2
```

To check a frame yourself, render a still (`npx remotion still <id> --frame=<n> out.png`)
and you can show it with `--file`.

## 3. The user's notes come to you automatically

After each of your tool calls, any new note the user left arrives in your context with
the time, the step, and a screenshot path of that exact frame (Read the image to see
what they mean). A note marked **STOP** means: stop the current plan and handle it first.

For each note:
1. Make the change.
2. Show it with `LR step ...` (same as above).
3. Mark it handled with one line saying what you did, in the user's language:
   `LR done <noteId> "خليت العنوان أصفر"`.

You will not be able to finish while a note is open: the plugin reminds you. `LR notes`
lists what is still open.

## 4. Only render the full video at the end

Render the final file once the user has seen the steps, unless they asked for it earlier.
Show the final render as a last step (`LR step "Final" --file out/final.mp4`).

## Good habits

- Keep previews short (the changed part only) so they appear in seconds.
- Label steps in plain words the user would use, in their language when they write Arabic.
- Never delete or overwrite the user's original footage; work on copies in a work folder.

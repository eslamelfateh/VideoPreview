"""Stand-in for whisper_local.py in tests (no model download): finds speech with
ffmpeg silencedetect and emits words with the same JSON and progress format.
Use with WHISPER_SCRIPT=scripts/fake_whisper.py."""
import json
import re
import subprocess
import sys

audio = sys.argv[1]
lang = sys.argv[sys.argv.index("--language") + 1] if "--language" in sys.argv else "ar"
err = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", audio, "-af", "silencedetect=n=-35dB:d=0.25", "-f", "null", "-"],
                     capture_output=True, text=True).stderr
starts = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", err)]
ends = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", err)]
dur = float(re.search(r"Duration: (\d+):(\d+):([\d.]+)", err).groups()[2]) if re.search(r"Duration", err) else 10.0
vocab = ["النهارده", "هوريكم", "إزاي", "تعدّلوا", "الفيديو", "بجملة", "واحدة"] if lang == "ar" else ["hello", "today", "video", "edit", "live"]
words, s = [], 0.0
for e in ends + ([dur] if len(starts) >= len(ends) else []):
    n = max(1, int((e - s) / 0.35))
    for k in range(n):
        a = s + k * (e - s) / n
        words.append({"text": vocab[len(words) % len(vocab)], "start": round(a, 3), "end": round(a + 0.85 * (e - s) / n, 3)})
    print(f"progress {min(1.0, e / dur):.3f}", file=sys.stderr, flush=True)
    s = starts.pop(0) if starts else e
json.dump({"language": lang, "words": words}, sys.stdout, ensure_ascii=False)

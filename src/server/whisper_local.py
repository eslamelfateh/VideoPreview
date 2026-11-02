"""Local speech-to-text for LiveCut with faster-whisper: no API key, audio never leaves the machine.

Usage: python3 whisper_local.py AUDIO [--model small] [--language ar] [--device auto]
Prints one JSON object: {"language": "ar", "words": [{"text", "start", "end"}, ...]}
Progress lines go to stderr as "progress 0.42".

The model is downloaded on first use (to HF_HOME, default ~/.cache/huggingface).
WHISPER_MODEL may also be a local folder with a converted CTranslate2 model.
For Egyptian Arabic, "small" is a good start and "medium" / "large-v3" are more accurate.
"""
import argparse
import json
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--model", default="small")
    ap.add_argument("--language", default=None)
    ap.add_argument("--device", default="auto")
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper is not installed. Run: pip install faster-whisper", file=sys.stderr)
        return 3

    try:
        model = WhisperModel(args.model, device=args.device, compute_type="int8")
    except Exception as e:  # download or load failure
        print(f"Could not load the Whisper model '{args.model}': {e}", file=sys.stderr)
        return 4

    segments, info = model.transcribe(
        args.audio,
        language=args.language or None,
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
    )
    words = []
    total = max(info.duration or 0, 0.001)
    for seg in segments:
        for w in seg.words or []:
            text = w.word.strip()
            if text:
                words.append({"text": text, "start": round(w.start, 3), "end": round(w.end, 3)})
        print(f"progress {min(1.0, seg.end / total):.3f}", file=sys.stderr, flush=True)
    json.dump({"language": info.language, "words": words}, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())

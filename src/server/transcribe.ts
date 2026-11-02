import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Media, Transcript, Word } from '../shared/types.js';
import { extractAudio } from './media.js';

/**
 * Speech-to-text through any OpenAI-compatible /audio/transcriptions endpoint
 * that returns word timestamps (OpenAI whisper-1, Groq whisper-large-v3, a local
 * faster-whisper server, ...). Agents that have their own transcription can skip
 * this and call set_transcript instead.
 */
const BASE = (process.env.TRANSCRIBE_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
const KEY = process.env.TRANSCRIBE_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
const MODEL = process.env.TRANSCRIBE_MODEL ?? 'whisper-1';

export const transcriptionConfigured = () => !!KEY || !!process.env.TRANSCRIBE_BASE_URL;

export async function transcribe(m: Media, language?: string): Promise<Transcript> {
  if (!transcriptionConfigured()) {
    throw new Error('Transcription is not configured on this server. Set TRANSCRIBE_API_KEY (and optionally TRANSCRIBE_BASE_URL / TRANSCRIBE_MODEL), or call set_transcript with word timings you already have.');
  }
  const tmp = path.join(os.tmpdir(), `${m.id}-${Date.now()}.mp3`);
  try {
    await extractAudio(m, tmp);
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(tmp)], { type: 'audio/mpeg' }), 'audio.mp3');
    form.append('model', MODEL);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    if (language) form.append('language', language.split('-')[0]);
    const res = await fetch(`${BASE}/audio/transcriptions`, { method: 'POST', headers: KEY ? { Authorization: `Bearer ${KEY}` } : {}, body: form });
    if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    let words: Word[] = (data.words ?? []).map((w: any) => ({ text: String(w.word).trim(), start: +w.start, end: +w.end }));
    if (!words.length && data.segments) {
      // Fallback: spread each segment's words evenly when the endpoint has no word timestamps.
      for (const s of data.segments) {
        const parts = String(s.text).trim().split(/\s+/).filter(Boolean);
        const d = (s.end - s.start) / Math.max(1, parts.length);
        parts.forEach((p, i) => words.push({ text: p, start: s.start + i * d, end: s.start + (i + 1) * d }));
      }
    }
    words = words.filter(w => w.text).map(w => ({ ...w, start: Math.round(w.start * 1000) / 1000, end: Math.round(w.end * 1000) / 1000 }));
    return { mediaId: m.id, language: data.language ?? language, words };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

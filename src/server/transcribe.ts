import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Media, Transcript, Word } from '../shared/types.js';
import { extractAudio } from './media.js';

/**
 * Speech-to-text, two ways:
 * - Local (default when no API key is set): faster-whisper on this machine. Free, private,
 *   no key. Needs `pip install faster-whisper`; the model downloads on first use.
 * - API: any OpenAI-compatible /audio/transcriptions endpoint with word timestamps
 *   (OpenAI whisper-1, Groq whisper-large-v3, a self-hosted server).
 * Agents that already have word timings can call set_transcript instead.
 */
const BASE = (process.env.TRANSCRIBE_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
const KEY = process.env.TRANSCRIBE_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
const MODEL = process.env.TRANSCRIBE_MODEL ?? 'whisper-1';
const LOCAL = (process.env.LIVECUT_WHISPER ?? 'auto').toLowerCase(); // auto | local | off
const PYTHON = process.env.WHISPER_PYTHON ?? 'python3';
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? 'small';
const SCRIPT = process.env.WHISPER_SCRIPT ?? path.resolve(fileURLToPath(import.meta.url), '../whisper_local.py');

const apiConfigured = () => !!KEY || !!process.env.TRANSCRIBE_BASE_URL;
let localOk: boolean | null = null;
function localAvailable(): boolean {
  if (LOCAL === 'off') return false;
  if (localOk === null) {
    try { execFileSync(PYTHON, ['-c', 'import faster_whisper'], { stdio: 'ignore', timeout: 20000 }); localOk = true; }
    catch { localOk = !!process.env.WHISPER_SCRIPT; }
  }
  return localOk;
}
const useLocal = () => LOCAL === 'local' || (!apiConfigured() && localAvailable());

export const transcriptionConfigured = () => apiConfigured() || localAvailable();
export const transcriptionEngine = () => (useLocal() ? `local Whisper (${WHISPER_MODEL})` : apiConfigured() ? `API (${MODEL})` : 'none');

const clean = (words: Word[]) => words.filter(w => w.text).map(w => ({ text: w.text, start: Math.round(w.start * 1000) / 1000, end: Math.round(Math.max(w.end, w.start + 0.01) * 1000) / 1000 }));

async function viaLocal(audio: string, language: string | undefined, onProgress?: (p: number) => void): Promise<{ language?: string; words: Word[] }> {
  const args = [SCRIPT, audio, '--model', WHISPER_MODEL, ...(language ? ['--language', language.split('-')[0]] : [])];
  return new Promise((resolve, reject) => {
    const p = spawn(PYTHON, args, { env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    let out = '', err = '';
    p.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    p.stderr.on('data', (b: Buffer) => {
      const s = b.toString();
      for (const m of s.matchAll(/progress ([\d.]+)/g)) onProgress?.(Number(m[1]));
      err += s.replace(/progress [\d.]+\n?/g, '');
    });
    p.on('error', e => reject(new Error(`Could not start ${PYTHON}: ${e.message}`)));
    p.on('close', code => {
      if (code !== 0) {
        const msg = err.trim().split('\n').filter(Boolean).slice(-3).join(' ');
        return reject(new Error(`Local transcription failed: ${msg || `exit ${code}`}. ${code === 4 ? 'The model could not be loaded: check internet access to huggingface.co for the first download, or set WHISPER_MODEL to a local model folder.' : ''}`.trim()));
      }
      try { const j = JSON.parse(out); resolve({ language: j.language, words: j.words ?? [] }); }
      catch { reject(new Error('Local transcription returned unreadable output.')); }
    });
  });
}

async function viaApi(audio: string, language: string | undefined): Promise<{ language?: string; words: Word[] }> {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(audio)], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  if (language) form.append('language', language.split('-')[0]);
  const res = await fetch(`${BASE}/audio/transcriptions`, { method: 'POST', headers: KEY ? { Authorization: `Bearer ${KEY}` } : {}, body: form });
  if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  const words: Word[] = (data.words ?? []).map((w: any) => ({ text: String(w.word).trim(), start: +w.start, end: +w.end }));
  if (!words.length && data.segments) {
    // Fallback: spread each segment's words evenly when the endpoint has no word timestamps.
    for (const s of data.segments) {
      const parts = String(s.text).trim().split(/\s+/).filter(Boolean);
      const d = (s.end - s.start) / Math.max(1, parts.length);
      parts.forEach((p, i) => words.push({ text: p, start: s.start + i * d, end: s.start + (i + 1) * d }));
    }
  }
  return { language: data.language ?? language, words };
}

export async function transcribe(m: Media, language?: string, onProgress?: (p: number) => void): Promise<Transcript> {
  if (!transcriptionConfigured()) {
    throw new Error('No speech-to-text is available. Either install local Whisper on the server (pip install faster-whisper), or set TRANSCRIBE_API_KEY (OpenAI) / TRANSCRIBE_BASE_URL (e.g. Groq). Agents can also call set_transcript with word timings.');
  }
  if (!m.hasAudio) throw new Error(`${m.name} has no audio.`);
  const tmp = path.join(os.tmpdir(), `${m.id}-${Date.now()}.wav`);
  try {
    await extractAudio(m, tmp);
    const r = useLocal() ? await viaLocal(tmp, language, onProgress) : await viaApi(tmp, language);
    return { mediaId: m.id, language: r.language ?? language, words: clean(r.words) };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

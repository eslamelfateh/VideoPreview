import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Media } from '../shared/types.js';
import { FFMPEG, mediaPath } from './media.js';
import { MEDIA_DIR, store } from './store.js';

const run = promisify(execFile);
const PEAKS_PER_SECOND = 50;
const THUMB_H = 64;

/** Audio peaks (0..255 per 20 ms) for drawing waveforms, without loading the whole file in memory. */
function peaks(m: Media, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const rate = 8000, per = rate / PEAKS_PER_SECOND;
    const p = spawn(FFMPEG, ['-v', 'error', '-i', mediaPath(m), '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1']);
    const result: number[] = [];
    let max = 0, n = 0, carry: Buffer = Buffer.alloc(0);
    p.stdout.on('data', (b: Buffer) => {
      const buf = carry.length ? Buffer.concat([carry, b]) : b;
      const usable = buf.length - (buf.length % 2);
      for (let i = 0; i < usable; i += 2) {
        const v = Math.abs(buf.readInt16LE(i));
        if (v > max) max = v;
        if (++n >= per) { result.push(max); max = 0; n = 0; }
      }
      carry = buf.subarray(usable);
    });
    p.on('error', reject);
    p.on('close', code => {
      if (code !== 0) return reject(new Error('peaks failed'));
      if (n) result.push(max);
      // Normalize so quiet recordings still show a readable waveform.
      const sorted = Int32Array.from(result).sort();
      const top = Math.max(1, sorted[Math.floor((sorted.length - 1) * 0.995)] ?? 1);
      fs.writeFileSync(out, Buffer.from(result.map(v => Math.min(255, Math.round((v / top) * 255)))));
      resolve();
    });
  });
}

async function thumbs(m: Media, out: string) {
  const count = Math.max(1, Math.min(120, Math.ceil(m.duration / 1)));
  const interval = m.duration / count;
  const w = Math.max(2, Math.round(((m.width ?? 16) / (m.height ?? 9)) * THUMB_H / 2) * 2);
  await run(FFMPEG, ['-v', 'error', '-y', '-i', mediaPath(m), '-vf',
    `fps=1/${interval.toFixed(4)},scale=${w}:${THUMB_H},tile=${count}x1`, '-frames:v', '1', '-q:v', '6', out]);
  return { count, interval, width: w, height: THUMB_H };
}

let queue = Promise.resolve();

/** Builds timeline assets in the background, one media file at a time. */
export function analyze(m: Media) {
  queue = queue.then(async () => {
    try {
      if (m.hasAudio) {
        const file = `${m.id}.peaks`;
        await peaks(m, path.join(MEDIA_DIR, file));
        store.setAssets(m.id, { peaks: { file, perSecond: PEAKS_PER_SECOND } });
      }
      if (m.kind === 'video' || m.kind === 'image') {
        const file = `${m.id}.thumbs.jpg`;
        const t = m.kind === 'image'
          ? (await run(FFMPEG, ['-v', 'error', '-y', '-i', mediaPath(m), '-vf', `scale=-2:${THUMB_H}`, '-frames:v', '1', path.join(MEDIA_DIR, file)]), { count: 1, interval: 1e9, width: Math.round(((m.width ?? 1) / (m.height ?? 1)) * THUMB_H), height: THUMB_H })
          : await thumbs(m, path.join(MEDIA_DIR, file));
        store.setAssets(m.id, { thumbs: { file, ...t } });
      }
    } catch (e) {
      console.warn(`Could not analyze ${m.name}:`, (e as Error).message);
    }
  });
}

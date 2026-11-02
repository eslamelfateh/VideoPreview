import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Media } from '../shared/types.js';
import { FFMPEG, mediaPath } from './media.js';
import { MEDIA_DIR, store } from './store.js';

/**
 * Background work (proxies, thumbnails, waveforms) runs at the lowest CPU priority, so a
 * long upload does not slow down playback in the editor or a running export.
 */
const NICE = process.platform !== 'win32' && spawnSync('nice', ['-n', '19', 'true']).status === 0;
const low = (cmd: string, args: string[]): [string, string[]] => (NICE ? ['nice', ['-n', '19', cmd, ...args]] : [cmd, args]);
/**
 * While someone is playing the preview, background jobs are paused (SIGSTOP) and resumed
 * when playback stops: on small machines a running ffmpeg costs the preview frames,
 * even at low priority. If the editor goes away mid-play, jobs resume after a minute.
 */
const jobs = new Set<ChildProcess>();
const CAN_PAUSE = process.platform !== 'win32';
let held = false, holdTimer: NodeJS.Timeout | null = null;
function track(p: ChildProcess) {
  jobs.add(p);
  p.on('exit', () => jobs.delete(p));
  if (held && CAN_PAUSE) p.kill('SIGSTOP');
  return p;
}
export function holdBackgroundJobs(playing: boolean) {
  if (!CAN_PAUSE) return;
  if (holdTimer) clearTimeout(holdTimer);
  if (playing) {
    if (!held) for (const j of jobs) j.kill('SIGSTOP');
    held = true;
    holdTimer = setTimeout(() => holdBackgroundJobs(false), 60_000);
  } else {
    if (held) for (const j of jobs) j.kill('SIGCONT');
    held = false;
  }
}
const run = (cmd: string, args: string[], _opts: object = {}) => new Promise<void>((resolve, reject) => {
  const p = track(spawn(...low(cmd, args), { stdio: ['ignore', 'ignore', 'pipe'] }));
  let err = '';
  p.stderr!.on('data', (d: Buffer) => { err += d.toString(); if (err.length > 8000) err = err.slice(-4000); });
  p.on('error', reject);
  p.on('close', code => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited with ${code}`))));
});
const PEAKS_PER_SECOND = 50;
const THUMB_H = 64;

/** Audio peaks (0..255 per 20 ms) for drawing waveforms, without loading the whole file in memory. */
function peaks(m: Media, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const rate = 8000, per = rate / PEAKS_PER_SECOND;
    const p = track(spawn(...low(FFMPEG, ['-v', 'error', '-i', mediaPath(m), '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'])));
    const result: number[] = [];
    let max = 0, n = 0, carry: Buffer = Buffer.alloc(0);
    p.stdout!.on('data', (b: Buffer) => {
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
      if (m.kind === 'video') {
        // 540p (or smaller), a keyframe every half second: seeking and cuts are instant in the preview.
        const file = `${m.id}.proxy.mp4`, h = Math.min(540, m.height ?? 540) - (Math.min(540, m.height ?? 540) % 2);
        await run(FFMPEG, ['-v', 'error', '-y', '-i', mediaPath(m), '-vf', `scale=-2:${h}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27',
          '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', path.join(MEDIA_DIR, file)],
          { maxBuffer: 1024 * 1024 });
        store.setAssets(m.id, { proxy: { file, height: h } });
      }
    } catch (e) {
      console.warn(`Could not analyze ${m.name}:`, (e as Error).message);
    }
  });
}

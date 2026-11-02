import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Media, MediaKind } from '../shared/types.js';
import { MEDIA_DIR, newId } from './store.js';

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

export async function probe(file: string): Promise<Omit<Media, 'id' | 'name' | 'file'>> {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(stdout);
  const v = info.streams.find((s: any) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = info.streams.find((s: any) => s.codec_type === 'audio');
  const dur = Number(info.format?.duration ?? v?.duration ?? a?.duration ?? 0);
  const isImage = v && (!dur || /image2|png_pipe|jpeg_pipe|webp_pipe/.test(info.format?.format_name ?? ''));
  const kind: MediaKind = isImage ? 'image' : v ? 'video' : 'audio';
  if (!v && !a) throw new Error('No audio or video streams found in this file.');
  let width = v?.width, height = v?.height;
  const rot = Math.abs(Number(v?.side_data_list?.find((d: any) => d.rotation != null)?.rotation ?? v?.tags?.rotate ?? 0));
  if (rot === 90 || rot === 270) [width, height] = [height, width];
  return { kind, duration: kind === 'image' ? 5 : Math.round(dur * 1000) / 1000, width, height, hasAudio: !!a };
}

/** Moves an uploaded or local file into the media directory and probes it. */
export async function importFile(src: string, originalName: string, move = false): Promise<Media> {
  const id = newId('media');
  const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
  const file = id + ext;
  const dest = path.join(MEDIA_DIR, file);
  if (move) fs.renameSync(src, dest); else fs.copyFileSync(src, dest);
  try {
    const info = await probe(dest);
    return { id, name: originalName, file, ...info };
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw e;
  }
}

export const mediaPath = (m: Media) => path.join(MEDIA_DIR, m.file);

/** A single frame as PNG, so the agent can look at the footage. */
export async function frameAt(m: Media, t: number, width = 512): Promise<Buffer> {
  const { stdout } = await run(FFMPEG, [
    '-v', 'error', '-ss', String(Math.max(0, t)), '-i', mediaPath(m), '-frames:v', '1',
    '-vf', `scale=${width}:-2`, '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
  return stdout as unknown as Buffer;
}

/** Mono 16 kHz mp3, small enough for speech-to-text APIs. */
export async function extractAudio(m: Media, out: string) {
  await run(FFMPEG, ['-v', 'error', '-y', '-i', mediaPath(m), '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', out]);
}

export { FFMPEG };

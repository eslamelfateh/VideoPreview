import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FFMPEG } from './media.js';

const run = promisify(execFile);

/**
 * H.264 encoders, fastest first. Hardware ones are used only if a short test
 * encode works on this machine; x264 always works. LIVECUT_ENCODER forces one
 * (auto | nvenc | videotoolbox | qsv | x264).
 */
type Q = 'final' | 'draft';
export interface Encoder { id: string; label: string; args: (q: Q) => string[] }
const ENCODERS: Encoder[] = [
  { id: 'nvenc', label: 'NVIDIA NVENC', args: q => ['-c:v', 'h264_nvenc', '-preset', q === 'draft' ? 'p1' : 'p5', '-rc', 'vbr', '-cq', q === 'draft' ? '27' : '21', '-b:v', '0', '-pix_fmt', 'yuv420p'] },
  { id: 'videotoolbox', label: 'Apple VideoToolbox', args: q => ['-c:v', 'h264_videotoolbox', '-allow_sw', '1', '-b:v', q === 'draft' ? '5M' : '10M', '-pix_fmt', 'yuv420p'] },
  { id: 'qsv', label: 'Intel Quick Sync', args: q => ['-c:v', 'h264_qsv', '-preset', q === 'draft' ? 'veryfast' : 'medium', '-global_quality', q === 'draft' ? '27' : '22', '-pix_fmt', 'nv12'] },
];
export const X264: Encoder = { id: 'x264', label: 'x264 (CPU)', args: q => ['-c:v', 'libx264', '-preset', q === 'draft' ? 'ultrafast' : 'veryfast', '-crf', q === 'draft' ? '25' : '20', '-pix_fmt', 'yuv420p'] };

let chosen: Promise<Encoder> | null = null;

async function works(e: Encoder): Promise<boolean> {
  try {
    await run(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=0.5', ...e.args('draft'), '-f', 'null', '-'], { timeout: 20000 });
    return true;
  } catch { return false; }
}

export function pickEncoder(): Promise<Encoder> {
  if (!chosen) chosen = (async () => {
    const want = (process.env.LIVECUT_ENCODER ?? 'auto').toLowerCase();
    if (want === 'x264') return X264;
    const forced = ENCODERS.find(e => e.id === want);
    if (forced) return forced; // forced: used even if the test fails, so a failure is visible (export falls back per run)
    let list = '';
    try { list = (await run(FFMPEG, ['-hide_banner', '-encoders'], { timeout: 10000 })).stdout; } catch { /* ignore */ }
    for (const e of ENCODERS) if (list.includes(`h264_${e.id}`) && await works(e)) return e;
    return X264;
  })();
  return chosen;
}

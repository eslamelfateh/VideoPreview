import { useSyncExternalStore } from 'react';

/**
 * The playhead lives outside React state so that playback (60 updates a second)
 * only re-renders the few components that read it, not the whole editor.
 */
type Fn = () => void;
let time = 0, playing = false, end = 0, raf = 0, last = 0;
const subs = new Set<Fn>();
const emit = () => subs.forEach(f => f());

function tick(now: number) {
  time = Math.min(end, time + (now - last) / 1000);
  last = now;
  if (time >= end) { playing = false; emit(); return; }
  emit();
  raf = requestAnimationFrame(tick);
}

export const clock = {
  get: () => time,
  isPlaying: () => playing,
  setEnd(e: number) { end = e; if (time > e) clock.seek(e); },
  seek(t: number) { time = Math.max(0, Math.min(end || t, t)); emit(); },
  play() {
    if (playing || end <= 0) return;
    if (time >= end - 0.02) time = 0;
    playing = true; last = performance.now();
    raf = requestAnimationFrame(tick);
    emit();
  },
  pause() { if (!playing) return; playing = false; cancelAnimationFrame(raf); emit(); },
  toggle() { playing ? clock.pause() : clock.play(); },
  subscribe(f: Fn) { subs.add(f); return () => { subs.delete(f); }; },
};

export const useTime = () => useSyncExternalStore(clock.subscribe, clock.get);
export const usePlaying = () => useSyncExternalStore(clock.subscribe, clock.isPlaying);

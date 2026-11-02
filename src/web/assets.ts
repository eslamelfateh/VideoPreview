import { useEffect, useState } from 'react';

/** Caches for timeline thumbnails (sprites) and waveform peaks, loaded once per media file. */
const images = new Map<string, Promise<HTMLImageElement>>();
const peaks = new Map<string, Promise<Uint8Array>>();

export function loadImage(file: string): Promise<HTMLImageElement> {
  let p = images.get(file);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = `/media/${encodeURIComponent(file)}`;
    });
    images.set(file, p);
  }
  return p;
}

export function loadPeaks(file: string): Promise<Uint8Array> {
  let p = peaks.get(file);
  if (!p) {
    p = fetch(`/media/${encodeURIComponent(file)}`, { credentials: 'same-origin' })
      .then(r => { if (!r.ok) throw new Error('peaks'); return r.arrayBuffer(); })
      .then(b => new Uint8Array(b));
    peaks.set(file, p);
  }
  return p;
}

export function useLoaded<T>(load: (() => Promise<T>) | null, key: string | undefined): T | null {
  const [v, setV] = useState<T | null>(null);
  useEffect(() => {
    if (!load || !key) { setV(null); return; }
    let live = true;
    load().then(x => live && setV(x)).catch(() => {});
    return () => { live = false; };
  }, [key]);
  return v;
}

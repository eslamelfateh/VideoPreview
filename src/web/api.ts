import { useEffect, useState } from 'react';
import type { ServerState } from '../shared/types';

/** Opened from a review link: watch and leave notes only. */
export const REVIEW = /^\/review\/([\w-]+)/.exec(location.pathname)?.[1] ?? null;
export const mediaUrl = (file: string) => `${REVIEW ? `/rmedia/${REVIEW}/` : '/media/'}${encodeURIComponent(file)}`;

export async function reviewNote(note: { start: number; end: number; text: string; kind: 'do' | 'dont' }) {
  const res = await fetch(`/rapi/${REVIEW}/note`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(note) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Could not save the note.');
  return data;
}

export async function post(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export async function upload(files: FileList | File[]): Promise<void> {
  const form = new FormData();
  for (const f of Array.from(files)) form.append('files', f, f.name);
  const res = await fetch('/api/media', { method: 'POST', body: form, credentials: 'same-origin' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Upload failed');
}

/** Live server state over WebSocket, reconnecting with backoff. */
export function useServerState(): { state: ServerState | null; online: boolean } {
  const [state, setState] = useState<ServerState | null>(null);
  const [online, setOnline] = useState(false);
  useEffect(() => {
    if (REVIEW) {
      // Reviewers poll a read-only view of the project.
      let live = true, last = '';
      const tick = async () => {
        try {
          const r = await fetch(`/rapi/${REVIEW}/state`);
          if (r.ok) { const t = await r.text(); if (t !== last) { last = t; setState(JSON.parse(t)); } setOnline(true); } else setOnline(false);
        } catch { setOnline(false); }
        if (live) setTimeout(tick, 1500);
      };
      tick();
      return () => { live = false; };
    }
    let ws: WebSocket | null = null, retry = 0, timer = 0, closed = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => { retry = 0; setOnline(true); };
      ws.onmessage = e => setState(JSON.parse(e.data));
      ws.onclose = () => {
        setOnline(false);
        if (!closed) timer = window.setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
      };
    };
    connect();
    return () => { closed = true; clearTimeout(timer); ws?.close(); };
  }, []);
  return { state, online };
}

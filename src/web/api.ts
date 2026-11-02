import { useEffect, useState } from 'react';
import type { ServerState } from '../shared/types';

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

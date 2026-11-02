import { useEffect, useRef, useState } from 'react';
import { clipEnd, duration } from '../shared/timeline';
import type { Project } from '../shared/types';

const ICONS = {
  video: <svg viewBox="0 0 24 24"><rect x="2" y="6" width="14" height="12" rx="2" /><path d="m16 10 6-3v10l-6-3" /></svg>,
  text: <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h13" /></svg>,
  fx: <svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2" /></svg>,
  audio: <svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></svg>,
};

interface Props {
  project: Project;
  time: number;
  onSeek: (t: number) => void;
  highlight: Set<string>; // ids touched by the hovered step
  fresh: Set<string>; // ids touched by the newest step
}

export function Timeline({ project, time, onSeek, highlight, fresh }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const total = Math.max(10, duration(project) * 1.08);
  const pps = (width / total) * zoom; // pixels per second
  const x = (t: number) => t * pps;
  const media = new Map(project.media.map(m => [m.id, m]));

  // Keep the playhead in view while zoomed in.
  useEffect(() => {
    const el = scroller.current;
    if (!el || zoom === 1) return;
    const px = x(time);
    if (px < el.scrollLeft + 20 || px > el.scrollLeft + el.clientWidth - 20) el.scrollLeft = px - el.clientWidth / 3;
  }, [time, zoom]);

  const seekFrom = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onSeek(Math.max(0, Math.min(duration(project), (e.clientX - r.left) / pps)));
  };
  const step = Math.max(1, [1, 2, 5, 10, 15, 30, 60].find(s => s * pps >= 60) ?? 60);
  const ticks: number[] = [];
  for (let t = 0; t <= total; t += step) ticks.push(t);

  const cls = (id: string, kind: string) => `clip ${kind}${highlight.has(id) ? ' hl' : ''}${fresh.has(id) ? ' fresh' : ''}`;
  const pos = (s: number, e: number) => ({ left: x(s), width: Math.max(4, x(e) - x(s) - 2) });

  return (
    <div className="timeline">
      <div className="tl-labels">
        <div className="tl-zoom">
          <button aria-label="Zoom out" onClick={() => setZoom(z => Math.max(1, z / 1.6))} disabled={zoom === 1}>−</button>
          <button aria-label="Zoom in" onClick={() => setZoom(z => Math.min(40, z * 1.6))}>+</button>
        </div>
        {(['video', 'text', 'fx', 'audio'] as const).map(k => <div key={k} className="tl-label">{ICONS[k]}{k}</div>)}
      </div>
      <div className="tl-scroll" ref={scroller}>
        <div className="tl-lanes" style={{ width: Math.max(width, x(total)) }}
          onPointerDown={e => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); seekFrom(e); }}
          onPointerMove={e => { if (e.buttons & 1) seekFrom(e); }}>
          <div className="ruler">{ticks.map(t => <span key={t} style={{ left: x(t) }}>{t}s</span>)}</div>
          <div className="lane">
            {project.clips.filter(c => c.track === 'video').map(c => (
              <div key={c.id} className={cls(c.id, 'v')} style={pos(c.start, clipEnd(c))} title={media.get(c.mediaId)?.name}>{media.get(c.mediaId)?.name}</div>
            ))}
          </div>
          <div className="lane">
            {project.texts.map(t => (
              <div key={t.id} className={cls(t.id, t.style === 'title' ? 't title' : 't')} style={pos(t.start, t.end)} title={t.text} dir="auto">{t.text}</div>
            ))}
          </div>
          <div className="lane">
            {project.effects.map(e => (
              <div key={e.id} className={cls(e.id, 'f')} style={pos(e.start, e.end)} title={`zoom ${e.scale}×`}>{e.scale}×</div>
            ))}
          </div>
          <div className="lane">
            {project.clips.filter(c => c.track === 'audio').map(c => (
              <div key={c.id} className={cls(c.id, 'a')} style={pos(c.start, clipEnd(c))} title={media.get(c.mediaId)?.name}>{media.get(c.mediaId)?.name}</div>
            ))}
          </div>
          <div className="playhead" style={{ left: x(time) }} />
        </div>
      </div>
    </div>
  );
}

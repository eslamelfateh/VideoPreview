import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { activeWord, clipAt, textsAt, TEXT_LAYOUT as L, zoomAt } from '../shared/timeline';
import type { Project } from '../shared/types';

const mediaUrl = (file: string) => `/media/${encodeURIComponent(file)}`;

/**
 * Renders the project at time t with plain <video>/<audio> elements and DOM text.
 * Geometry mirrors the ffmpeg export: cover-fit video, zoom anchored the same way,
 * text sized as fractions of the canvas.
 */
export function Preview({ project, time, playing, peeking }: { project: Project; time: number; playing: boolean; peeking: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const els = useRef(new Map<string, HTMLMediaElement>());

  useLayoutEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const v = clipAt(project, 'video', time);
  const a = clipAt(project, 'audio', time);

  // Keep each media element at the right source time; only the active ones play.
  useEffect(() => {
    for (const [id, el] of els.current) {
      const clip = v?.mediaId === id ? v : a?.mediaId === id ? a : undefined;
      if (!clip) { if (!el.paused) el.pause(); continue; }
      const target = clip.in + (time - clip.start);
      el.volume = Math.min(1, clip.volume);
      el.muted = clip.volume === 0;
      const drift = Math.abs(el.currentTime - target);
      if (playing) {
        if (drift > 0.25) el.currentTime = target;
        if (el.paused) el.play().catch(() => {});
      } else {
        if (!el.paused) el.pause();
        if (drift > 0.04 && !el.seeking) el.currentTime = target;
      }
    }
  });

  const scale = w / project.width;
  const z = zoomAt(project.effects, time);
  const texts = textsAt(project.texts, time);
  const base = Math.min(project.width, project.height) * scale;

  return (
    <div className="preview" ref={box} style={{ aspectRatio: `${project.width} / ${project.height}` }}>
      <div className="layer" style={{ transform: `scale(${z.scale})`, transformOrigin: `${z.x * 100}% ${z.y * 100}%` }}>
        {project.media.map(m => {
          const on = (v?.mediaId === m.id);
          if (m.kind === 'image') return on ? <img key={m.id} src={mediaUrl(m.file)} alt="" className="media on" /> : null;
          if (m.kind === 'audio') return <audio key={m.id} src={mediaUrl(m.file)} preload="auto" ref={el => { if (el) els.current.set(m.id, el); else els.current.delete(m.id); }} />;
          return (
            <video key={m.id} src={mediaUrl(m.file)} preload="auto" playsInline className={`media${on ? ' on' : ''}`}
              ref={el => { if (el) els.current.set(m.id, el); else els.current.delete(m.id); }} />
          );
        })}
      </div>
      {texts.map(t => t.style === 'title' ? (
        <div key={t.id} className="ov title" style={{ top: project.height * L.titleTop * scale, fontSize: base * L.titleSize, color: t.color, WebkitTextStrokeWidth: base * L.titleSize * L.outline * 2, padding: `0 ${project.width * L.side * scale}px` }}>{t.text}</div>
      ) : (
        <div key={t.id} className="ov caption" style={{ bottom: project.height * L.captionBottom * scale, fontSize: base * L.captionSize, WebkitTextStrokeWidth: base * L.captionSize * L.outline * 2, padding: `0 ${project.width * L.side * scale}px` }}>
          {t.words?.length
            ? t.words.map((wd, i) => <span key={i} className={i === activeWord(t, time) ? 'on' : ''} style={i === activeWord(t, time) ? { color: t.color ?? L.highlight, transform: `scale(${L.activeScale})` } : undefined}>{wd.text}</span>)
            : t.text}
        </div>
      ))}
      {!v && <div className="empty-frame">{project.clips.length ? 'No video at this point' : 'Drop a video here to start'}</div>}
      {z.scale > 1.001 && <div className="badge zoom">ZOOM {z.scale.toFixed(2)}×</div>}
      {peeking && <div className="badge before">BEFORE</div>}
    </div>
  );
}

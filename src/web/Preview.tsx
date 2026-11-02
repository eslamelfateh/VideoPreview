import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { activeWord, clipAt, clipEnd, duckFactor, masterGain, POSITION_MARGIN, positionOf, presetOf, textsAt, TEXT_LAYOUT as L, zoomAt } from '../shared/timeline';
import type { TextItem } from '../shared/types';
import type { Clip, MediaAssets, Project, ZoomEffect } from '../shared/types';
import { clock, usePlaying, useTime } from './clock';

const mediaUrl = (file: string) => `/media/${encodeURIComponent(file)}`;

/* ---------- audio: Web Audio gain per media element, so volume can go to 200% and fades are exact ---------- */

let ctx: AudioContext | null = null;
const gains = new WeakMap<HTMLMediaElement, GainNode>();
function gainFor(el: HTMLMediaElement): GainNode | null {
  if (!ctx) return null;
  let g = gains.get(el);
  if (!g) {
    try {
      const src = ctx.createMediaElementSource(el);
      g = ctx.createGain();
      src.connect(g).connect(ctx.destination);
      gains.set(el, g);
    } catch { return null; }
  }
  return g;
}
/** Must run inside a user gesture (the play button / space). */
export function unlockAudio() {
  if (!ctx) { try { ctx = new AudioContext(); } catch { /* no Web Audio: element volume is used */ } }
  ctx?.resume();
}

function clipGain(c: Clip, t: number): number {
  const into = t - c.start, left = clipEnd(c) - t;
  let g = c.volume;
  if (c.fadeIn && into < c.fadeIn) g *= Math.max(0, into / c.fadeIn);
  if (c.fadeOut && left < c.fadeOut) g *= Math.max(0, left / c.fadeOut);
  return g;
}

interface Props {
  project: Project;
  assets: Record<string, MediaAssets>;
  speech: [number, number][];
  peeking: boolean;
  /** When a zoom is selected, clicking the frame moves its anchor. */
  anchorFor?: ZoomEffect;
  onAnchor?: (x: number, y: number) => void;
}

/**
 * Renders the project at the playhead with plain <video>/<audio> elements and DOM text.
 * Geometry mirrors the ffmpeg export: cover-fit video, zoom anchored the same way,
 * text sized as fractions of the canvas.
 */
export const Preview = memo(function Preview({ project, assets, speech, peeking, anchorFor, onAnchor }: Props) {
  const time = useTime();
  const playing = usePlaying();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const els = useRef(new Map<string, HTMLMediaElement>());

  useLayoutEffect(() => {
    const el = box.current!.parentElement!;
    const fit = () => {
      const W = el.clientWidth, H = el.clientHeight, r = project.width / project.height;
      const w = Math.min(W, H * r);
      setSize({ w: Math.floor(w), h: Math.floor(w / r) });
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el); fit();
    return () => ro.disconnect();
  }, [project.width, project.height]);

  // Two players per video file: the next clip is cued on the idle one, so cuts swap instantly instead of seeking.
  const vclips = useMemo(() => project.clips.filter(c => c.track === 'video').sort((x, y) => x.start - y.start), [project.clips]);
  const k = vclips.findIndex(c => time >= c.start && time < clipEnd(c));
  const v = k >= 0 ? vclips[k] : undefined;
  const nextV = vclips[k >= 0 ? k + 1 : vclips.findIndex(c => c.start > time)];
  const vKey = v ? `${v.mediaId}:${k % 2}` : '';
  const nKey = nextV ? `${nextV.mediaId}:${(vclips.indexOf(nextV)) % 2}` : '';
  const a = clipAt(project, 'audio', time);
  const aKey = a ? `${a.mediaId}:a` : '';

  useEffect(() => {
    for (const [key, el] of els.current) {
      const clip = key === vKey ? v : key === aKey ? a : undefined;
      if (!clip) {
        if (!el.paused) el.pause();
        if (key === nKey && nextV && key !== vKey && !el.seeking && Math.abs(el.currentTime - nextV.in) > 0.05) el.currentTime = nextV.in;
        continue;
      }
      const target = clip.in + (time - clip.start);
      // Same levels as the export: clip volume and fades, music ducking under speech, loudness gain.
      const g = gainFor(el), level = clipGain(clip, time) * (clip.track === 'audio' ? duckFactor(project.audio, speech, time) : 1) * masterGain(project.audio);
      if (g) { g.gain.value = level; el.volume = 1; } else el.volume = Math.min(1, level);
      const drift = Math.abs(el.currentTime - target);
      if (playing) {
        if (drift > 0.3) el.currentTime = target;
        if (el.paused) el.play().catch(() => {});
      } else {
        if (!el.paused) el.pause();
        if (drift > 0.04 && !el.seeking) el.currentTime = target;
      }
    }
  });

  const scale = size.w / project.width;
  const z = zoomAt(project.effects, time);
  const texts = textsAt(project.texts, time);
  const base = Math.min(project.width, project.height) * scale;
  const pad = `0 ${project.width * L.side * scale}px`;
  const used = new Set(project.clips.map(c => c.mediaId));

  const pickAnchor = (e: React.PointerEvent) => {
    if (!anchorFor || !onAnchor) return;
    const r = box.current!.getBoundingClientRect();
    onAnchor(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)));
  };

  return (
    <div className={`preview${anchorFor ? ' picking' : ''}`} ref={box} style={{ width: size.w, height: size.h }} onPointerDown={pickAnchor}
      onClick={() => { if (!anchorFor) { unlockAudio(); clock.toggle(); } }}>
      <div className="layer" style={{ transform: `scale(${z.scale})`, transformOrigin: `${z.x * 100}% ${z.y * 100}%` }}>
        {project.media.filter(m => used.has(m.id)).flatMap(m => {
          const ref = (key: string) => (el: HTMLMediaElement | null) => { if (el) els.current.set(key, el); else els.current.delete(key); };
          if (m.kind === 'image') return v?.mediaId === m.id ? [<img key={m.id} src={mediaUrl(m.file)} alt="" className="media on" />] : [];
          const out = [];
          if (project.clips.some(c => c.mediaId === m.id && c.track === 'audio')) out.push(<audio key={`${m.id}:a`} src={mediaUrl(m.file)} preload="auto" ref={ref(`${m.id}:a`)} />);
          if (m.kind === 'video') for (const slot of [0, 1]) {
            const key = `${m.id}:${slot}`;
            out.push(<video key={key} src={mediaUrl(assets[m.id]?.proxy?.file ?? m.file)} preload="auto" playsInline className={`media${vKey === key ? ' on' : ''}`} ref={ref(key)} />);
          }
          return out;
        })}
      </div>
      {texts.map(t => <Overlay key={t.id} t={t} time={time} scale={scale} base={base} pad={pad} H={project.height} />)}
      {!v && <div className="empty-frame">{project.clips.length ? 'No video here' : 'Drop a video anywhere to start'}</div>}
      {z.scale > 1.001 && <div className="badge zoom">ZOOM {z.scale.toFixed(2)}×</div>}
      {peeking && <div className="badge before">BEFORE</div>}
      {anchorFor && <div className="anchor" style={{ left: `${anchorFor.anchorX * 100}%`, top: `${anchorFor.anchorY * 100}%` }} />}
      {anchorFor && <div className="badge hint">Click to aim the zoom</div>}
    </div>
  );
});

/** One caption or title, drawn the way the export draws it (see buildAss). */
function Overlay({ t, time, scale, base, pad, H }: { t: TextItem; time: number; scale: number; base: number; pad: string; H: number }) {
  const pos = positionOf(t);
  const place: React.CSSProperties = pos === 'middle' ? { top: '50%', transform: 'translateY(-50%)' } : pos === 'top' ? { top: H * POSITION_MARGIN.top * scale } : { bottom: H * POSITION_MARGIN.bottom * scale };
  if (t.style === 'title') {
    const size = base * L.titleSize;
    return <div className="ov title" dir="auto" style={{ ...place, fontSize: size / L.lineEm, lineHeight: L.lineEm, color: t.color, WebkitTextStrokeWidth: size * L.outline * 2, padding: pad }}>{t.text}</div>;
  }
  const P = presetOf(t);
  const size = base * P.size;
  const activeColor = t.color ?? P.active ?? L.highlight;
  const k = activeWord(t, time);
  const words = t.words?.length ? t.words.map(w => w.text) : [t.text];
  const shown = P.oneWord && k >= 0 ? [k] : words.map((_, i) => i);
  const inner = shown.map(i => {
    const on = i === k && t.words?.length;
    return <span key={i} style={on ? { color: activeColor, transform: P.activeScale !== 1 ? `scale(${P.activeScale})` : undefined } : { opacity: P.dim }}>{words[i]}</span>;
  });
  return (
    <div className={`ov caption${P.box ? ' boxed' : ''}`} style={{ ...place, fontSize: size / L.lineEm, lineHeight: L.lineEm, color: P.base, WebkitTextStrokeWidth: P.box ? 0 : size * P.outline * 2, padding: pad, textShadow: P.outline === 0 ? `0 ${size * 0.05}px ${size * 0.1}px #000a` : undefined }}>
      {P.box ? <span className="box" style={{ padding: `0 ${size * P.outline}px` }}>{inner}</span> : inner}
    </div>
  );
}

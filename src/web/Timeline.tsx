import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { clipEnd, duration, fmtTime } from '../shared/timeline';
import type { Clip, Media, MediaAssets, Project } from '../shared/types';
import { loadImage, loadPeaks } from './assets';
import { clock, useTime } from './clock';

export type Kind = 'clip' | 'text' | 'effect' | 'marker';
export type Selection = { kind: Kind; id: string } | null;
export type Range = { start: number; end: number } | null;

const ICONS = {
  notes: <svg viewBox="0 0 24 24"><path d="M5 21V4h11l-2 4 2 4H5" /></svg>,
  video: <svg viewBox="0 0 24 24"><rect x="2" y="6" width="14" height="12" rx="2" /><path d="m16 10 6-3v10l-6-3" /></svg>,
  text: <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h13" /></svg>,
  fx: <svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2" /></svg>,
  audio: <svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></svg>,
};

/* ---------- one canvas per track: thumbnails, waveforms, volume lines, only for the visible part ---------- */

const COLORS = { video: '#d6d3cb', audio: '#e3f4ec' };

function useMediaAssets(assets: Record<string, MediaAssets>) {
  const [loaded, setLoaded] = useState<Record<string, { img?: HTMLImageElement; peaks?: Uint8Array }>>({});
  useEffect(() => {
    let live = true;
    for (const [id, a] of Object.entries(assets)) {
      if (a.thumbs && !loaded[id]?.img) loadImage(a.thumbs.file).then(img => live && setLoaded(l => ({ ...l, [id]: { ...l[id], img } }))).catch(() => {});
      if (a.peaks && !loaded[id]?.peaks) loadPeaks(a.peaks.file).then(peaks => live && setLoaded(l => ({ ...l, [id]: { ...l[id], peaks } }))).catch(() => {});
    }
    return () => { live = false; };
  }, [assets]);
  return loaded;
}

interface LaneProps {
  track: 'video' | 'audio';
  clips: (Clip & { end: number })[];
  media: Map<string, Media>;
  assets: Record<string, MediaAssets>;
  loaded: Record<string, { img?: HTMLImageElement; peaks?: Uint8Array }>;
  pps: number; scrollX: number; width: number;
}

const LaneCanvas = memo(function LaneCanvas({ track, clips, media, assets, loaded, pps, scrollX, width }: LaneProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const cv = ref.current!;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.max(1, Math.round(width)), H = LANE_H;
    if (cv.width !== w * dpr || cv.height !== H * dpr) { cv.width = w * dpr; cv.height = H * dpr; }
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, H);
    const top = 6, h = CLIP_H;
    for (const c of clips) {
      const x0 = c.start * pps - scrollX, x1 = c.end * pps - scrollX - 1;
      if (x1 < 0 || x0 > w) continue;
      const cw = Math.max(6, x1 - x0);
      g.save();
      g.beginPath(); g.roundRect(x0, top, cw, h, 7); g.clip();
      g.fillStyle = COLORS[track]; g.fillRect(x0, top, cw, h);
      const len = c.out - c.in, cpps = cw / len;
      const from = Math.max(x0, 0), to = Math.min(x0 + cw, w);
      const th = assets[c.mediaId]?.thumbs, img = loaded[c.mediaId]?.img;
      if (track === 'video' && th && img) {
        const tw = th.width * (h / th.height);
        const k0 = Math.floor((from - x0) / tw);
        for (let xx = x0 + k0 * tw; xx < to; xx += tw) {
          const src = c.in + (xx - x0 + tw / 2) / cpps;
          const i = Math.max(0, Math.min(th.count - 1, Math.floor(src / th.interval)));
          g.drawImage(img, i * th.width, 0, th.width, th.height, xx, top, tw, h);
        }
        g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(x0, top, cw, h);
      }
      const pk = assets[c.mediaId]?.peaks, peaks = loaded[c.mediaId]?.peaks;
      if (pk && peaks) {
        const wt = track === 'video' ? top + h * 0.62 : top, wh = track === 'video' ? h * 0.38 : h, mid = wt + wh / 2;
        g.fillStyle = track === 'video' ? 'rgba(227,244,236,.75)' : 'rgba(31,74,55,.55)';
        for (let xx = Math.floor(from); xx < to; xx++) {
          const a = Math.floor((c.in + (xx - x0) / cpps) * pk.perSecond), b = Math.max(a + 1, Math.floor((c.in + (xx + 1 - x0) / cpps) * pk.perSecond));
          let m = 0;
          for (let i = a; i < b && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
          const amp = (m / 255) * Math.min(1, c.volume) * (wh / 2 - 1);
          g.fillRect(xx, mid - amp, 1, amp * 2 || 0.5);
        }
      }
      if (media.get(c.mediaId)?.hasAudio) {
        // Volume line: 0% at the bottom, 100% in the middle, 200% at the top; ramps show fades.
        const y = (v: number) => top + h - 3 - (v / 2) * (h - 6);
        const fi = (c.fadeIn ?? 0) * cpps, fo = (c.fadeOut ?? 0) * cpps;
        g.strokeStyle = c.volume === 0 ? '#e0706a' : '#f0cf6a'; g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(x0, y(fi ? 0 : c.volume)); g.lineTo(x0 + fi, y(c.volume)); g.lineTo(x0 + cw - fo, y(c.volume)); g.lineTo(x0 + cw, y(fo ? 0 : c.volume)); g.stroke();
      }
      g.restore();
    }
  }, [clips, assets, loaded, pps, scrollX, width, track, media]);
  return <canvas ref={ref} className="lane-canvas" style={{ left: scrollX, width, height: LANE_H }} />;
});

/* ---------- the timeline ---------- */

interface Props {
  project: Project;
  assets: Record<string, MediaAssets>;
  selection: Selection;
  onSelect: (s: Selection) => void;
  range: Range;
  onRange: (r: Range) => void;
  onEdit: (op: string, args: Record<string, unknown>) => Promise<unknown>;
  highlight: Set<string>;
  fresh: Set<string>;
}

type Drag = { kind: Kind; id: string; mode: 'move' | 'left' | 'right'; x0: number; d: number; moved: boolean };
type Box = { start: number; end: number; in?: number; out?: number };

const LANE_H = 44, CLIP_H = 32;

export function Timeline({ project, assets, selection, onSelect, range, onRange, onEdit, highlight, fresh }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pending, setPending] = useState<Record<string, Box>>({});
  const [scrollX, setScrollX] = useState(0);
  const loaded = useMediaAssets(assets);

  useEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => setPending({}), [project]);

  const total = Math.max(10, duration(project) * 1.1);
  const pps = (width / total) * zoom;
  const x = (t: number) => t * pps;
  const media = useMemo(() => new Map(project.media.map(m => [m.id, m])), [project.media]);
  // Only items near the visible part of the timeline are put in the DOM.
  const visA = scrollX / pps - 2, visB = (scrollX + width) / pps + 2;
  const visible = (s: number, e: number) => e >= visA && s <= visB;

  /* geometry of every item, with in-flight drags applied */
  const boxOf = (kind: Kind, id: string): Box | undefined => {
    if (pending[id]) return pending[id];
    if (kind === 'clip') { const c = project.clips.find(c => c.id === id); return c && { start: c.start, end: clipEnd(c), in: c.in, out: c.out }; }
    const list: any[] = kind === 'text' ? project.texts : kind === 'effect' ? project.effects : project.markers;
    const it = list.find(i => i.id === id);
    return it && { start: it.start, end: it.end };
  };

  const snapTimes = useMemo(() => {
    const ts = [0];
    for (const c of project.clips) ts.push(c.start, clipEnd(c));
    for (const t of project.texts) ts.push(t.start, t.end);
    for (const e of project.effects) ts.push(e.start, e.end);
    for (const m of project.markers) ts.push(m.start, m.end);
    return ts;
  }, [project]);

  const applyDrag = (dr: Drag): Box | undefined => {
    const b = boxOf(dr.kind, dr.id);
    if (!b) return;
    let d = dr.d;
    const tol = 8 / pps;
    const others = snapTimes.concat(clock.get()).filter(t => Math.abs(t - b.start) > 1e-6 && Math.abs(t - b.end) > 1e-6);
    const snap = (t: number) => { let best = 0, bd = tol; for (const o of others) { const k = Math.abs(o - t); if (k < bd) { bd = k; best = o - t; } } return bd < tol ? best : null; };
    if (dr.mode === 'move') {
      const s1 = snap(b.start + d), s2 = snap(b.end + d);
      if (s1 !== null && (s2 === null || Math.abs(s1) <= Math.abs(s2))) d += s1; else if (s2 !== null) d += s2;
      d = Math.max(d, -b.start);
      return { start: b.start + d, end: b.end + d, in: b.in, out: b.out };
    }
    if (dr.mode === 'left') {
      const s = snap(b.start + d); if (s !== null) d += s;
      d = Math.min(d, b.end - b.start - 0.1);
      d = Math.max(d, -b.start);
      if (b.in !== undefined) d = Math.max(d, -b.in);
      return { start: b.start + d, end: b.end, in: b.in !== undefined ? b.in + d : undefined, out: b.out };
    }
    const s = snap(b.end + d); if (s !== null) d += s;
    d = Math.max(d, b.start - b.end + 0.1);
    if (b.out !== undefined && dr.kind === 'clip') {
      const c = project.clips.find(c => c.id === dr.id)!;
      const m = media.get(c.mediaId);
      if (m && m.kind !== 'image') d = Math.min(d, m.duration - b.out);
    }
    return { start: b.start, end: b.end + d, in: b.in, out: b.out !== undefined ? b.out + d : undefined };
  };
  const live = drag ? applyDrag(drag) : undefined;
  const geo = (kind: Kind, id: string): Box | undefined => (drag && drag.id === id && live ? live : boxOf(kind, id));

  const commit = (dr: Drag, b: Box) => {
    const r = (n: number) => Math.round(n * 1000) / 1000;
    setPending(p => ({ ...p, [dr.id]: b }));
    const done = (pr: Promise<unknown>) => pr.catch(() => setPending(p => { const n = { ...p }; delete n[dr.id]; return n; }));
    if (dr.kind === 'clip') done(onEdit('update_clip', { clipId: dr.id, start: r(b.start), in: r(b.in!), out: r(b.out!) }));
    else if (dr.kind === 'text') done(onEdit('update_text', { textId: dr.id, start: r(b.start), end: r(b.end) }));
    else if (dr.kind === 'effect') done(onEdit('update_effect', { effectId: dr.id, start: r(b.start), end: r(b.end) }));
    else done(onEdit('update_note', { markerId: dr.id, start: r(b.start), end: r(b.end) }));
  };

  const itemDown = (kind: Kind, id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const edge = Math.min(8, r.width / 4);
    const mode = e.clientX - r.left < edge ? 'left' : r.right - e.clientX < edge ? 'right' : 'move';
    el.setPointerCapture(e.pointerId);
    onSelect({ kind, id });
    setDrag({ kind, id, mode, x0: e.clientX, d: 0, moved: false });
  };
  const itemMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    if (!drag.moved && Math.abs(dx) < 3) return;
    setDrag({ ...drag, d: dx / pps, moved: true });
  };
  const itemUp = (e: React.PointerEvent) => {
    if (!drag) return;
    if (drag.moved && live) commit(drag, live);
    else {
      // A click (no drag) also moves the playhead there.
      const lane = (e.currentTarget as HTMLElement).closest('.tl-lanes')!.getBoundingClientRect();
      clock.pause(); clock.seek((e.clientX - lane.left) / pps);
    }
    setDrag(null);
  };

  /* scrubbing on lanes, range selection on the ruler */
  const [rangeDrag, setRangeDrag] = useState<number | null>(null);
  const tAt = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).closest('.tl-lanes')!.getBoundingClientRect();
    return Math.max(0, Math.min(duration(project), (e.clientX - r.left) / pps));
  };

  useEffect(() => {
    const el = scroller.current;
    if (!el || zoom === 1) return;
    return clock.subscribe(() => {
      if (!clock.isPlaying()) return;
      const px = x(clock.get());
      if (px < el.scrollLeft || px > el.scrollLeft + el.clientWidth - 30) el.scrollLeft = px - 40;
    });
  }, [zoom, pps]);

  const stepSec = Math.max(1, [1, 2, 5, 10, 15, 30, 60, 120].find(s => s * pps >= 70) ?? 120);
  const ticks: number[] = [];
  for (let t = 0; t <= total; t += stepSec) ticks.push(t);

  const cls = (kind: Kind, id: string, extra: string) =>
    `item ${extra}${selection?.id === id ? ' sel' : ''}${highlight.has(id) ? ' hl' : ''}${fresh.has(id) ? ' fresh' : ''}${drag?.id === id && drag.moved ? ' dragging' : ''}`;
  const handlers = (kind: Kind, id: string) => ({ onPointerDown: itemDown(kind, id), onPointerMove: itemMove, onPointerUp: itemUp, onPointerCancel: () => setDrag(null) });
  const style = (b: Box) => ({ left: x(b.start), width: Math.max(6, x(b.end) - x(b.start) - 1) });

  const laneClips = (track: 'video' | 'audio') => project.clips.filter(c => c.track === track).map(c => {
    const b = geo('clip', c.id)!;
    return { ...c, start: b.start, in: b.in!, out: b.out!, end: b.end };
  });
  const videoClips = useMemo(() => laneClips('video'), [project.clips, pending, drag, live?.start, live?.end, live?.in, live?.out]);
  const audioClips = useMemo(() => laneClips('audio'), [project.clips, pending, drag, live?.start, live?.end, live?.in, live?.out]);

  const clipsOn = (track: 'video' | 'audio', list: (Clip & { end: number })[]) => <>
    <LaneCanvas track={track} clips={list} media={media} assets={assets} loaded={loaded} pps={pps} scrollX={scrollX} width={width} />
    {list.filter(c => visible(c.start, c.end)).map(c => {
      const m = media.get(c.mediaId);
      return (
        <div key={c.id} className={cls('clip', c.id, track === 'video' ? 'v' : 'a')} style={style(c)} {...handlers('clip', c.id)} title={`${m?.name ?? ''} · ${fmtTime(c.start)}–${fmtTime(c.end)} · volume ${Math.round(c.volume * 100)}%`}>
          <span className="label">{m?.name}{c.volume !== 1 && <b className="vol">{Math.round(c.volume * 100)}%</b>}</span>
        </div>
      );
    })}
  </>;

  const locks = project.markers.filter(m => m.kind === 'dont' && m.status === 'open');

  return (
    <div className="timeline">
      <div className="tl-labels">
        <div className="tl-zoom">
          <button aria-label="Zoom out timeline" onClick={() => setZoom(z => Math.max(1, z / 1.6))} disabled={zoom === 1}>−</button>
          <button aria-label="Zoom in timeline" onClick={() => setZoom(z => Math.min(60, z * 1.6))}>+</button>
        </div>
        {(['notes', 'video', 'text', 'fx', 'audio'] as const).map(k => <div key={k} className="tl-label">{ICONS[k]}{k}</div>)}
      </div>
      <div className="tl-scroll" ref={scroller} onScroll={e => { const v = (e.currentTarget as HTMLElement).scrollLeft; requestAnimationFrame(() => setScrollX(v)); }}>
        <div className="tl-lanes" style={{ width: Math.max(width, x(total)) }}
          onPointerDown={e => { if (e.button !== 0) return; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); clock.pause(); clock.seek(tAt(e)); onSelect(null); }}
          onPointerMove={e => { if ((e.buttons & 1) && !drag && rangeDrag === null) clock.seek(tAt(e)); }}>
          <div className="ruler" title="Drag here to select a range"
            onPointerDown={e => { e.stopPropagation(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); const t = tAt(e); setRangeDrag(t); onRange(null); clock.pause(); clock.seek(t); }}
            onPointerMove={e => { if (rangeDrag === null) return; const t = tAt(e); if (Math.abs(t - rangeDrag) * pps > 4) onRange({ start: Math.min(t, rangeDrag), end: Math.max(t, rangeDrag) }); }}
            onPointerUp={() => setRangeDrag(null)}>
            {ticks.map(t => <span key={t} style={{ left: x(t) }}>{fmtTime(t).replace(/\.0$/, '')}</span>)}
          </div>
          <div className="lane notes">
            {project.markers.map(m => { const b = geo('marker', m.id)!; if (!visible(b.start, b.end)) return null; return (
              <div key={m.id} className={cls('marker', m.id, `n ${m.kind}${m.status === 'done' ? ' done' : ''}`)} style={style(b)} {...handlers('marker', m.id)} title={m.text} dir="auto">
                {m.kind === 'dont' ? '🔒 ' : m.status === 'done' ? '✓ ' : ''}{m.text}
              </div>); })}
          </div>
          <div className="lane">{clipsOn('video', videoClips)}</div>
          <div className="lane">
            {project.texts.map(t => { const b = geo('text', t.id)!; if (!visible(b.start, b.end)) return null; return (
              <div key={t.id} className={cls('text', t.id, t.style === 'title' ? 't title' : 't')} style={style(b)} {...handlers('text', t.id)} title={t.text} dir="auto">{t.text}</div>); })}
          </div>
          <div className="lane">
            {project.effects.map(e => { const b = geo('effect', e.id)!; if (!visible(b.start, b.end)) return null; return (
              <div key={e.id} className={cls('effect', e.id, 'f')} style={style(b)} {...handlers('effect', e.id)} title={`zoom ${e.scale}×`}>{e.scale}×</div>); })}
          </div>
          <div className="lane">{clipsOn('audio', audioClips)}</div>
          {locks.map(m => <div key={m.id} className="lock-shade" style={{ left: x(m.start), width: x(m.end) - x(m.start) }} />)}
          {range && <div className="range" style={{ left: x(range.start), width: x(range.end) - x(range.start) }} />}
          <Playhead pps={pps} />
        </div>
      </div>
    </div>
  );
}

function Playhead({ pps }: { pps: number }) {
  const t = useTime();
  return <div className="playhead" style={{ transform: `translateX(${t * pps}px)` }} />;
}

export { LANE_H };

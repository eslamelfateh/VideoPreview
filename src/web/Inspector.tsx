import { memo, useEffect, useRef, useState } from 'react';
import { CAPTION_PRESETS, clipAt, clipEnd, clipLen, fmtTime, LAYOUTS, positionOf, reframeAt } from '../shared/timeline';
import type { Project } from '../shared/types';
import { clock, useTime } from './clock';
import { post } from './api';
import type { Range, Selection } from './Timeline';

type Edit = (op: string, args: Record<string, unknown>) => Promise<unknown>;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Sends at most ~10 edits a second while a slider moves; the server merges them into one step. */
function useThrottled(fn: (v: number) => void) {
  const last = useRef(0), timer = useRef(0), next = useRef<number | null>(null);
  return (v: number) => {
    next.current = v;
    const now = performance.now();
    const run = () => { last.current = performance.now(); timer.current = 0; if (next.current !== null) fn(next.current); next.current = null; };
    if (now - last.current > 100) run();
    else if (!timer.current) timer.current = window.setTimeout(run, 100 - (now - last.current));
  };
}

function NumField({ id, label, value, step = 0.1, min, max, suffix = 's', onCommit }: { id: string; label: string; value: number; step?: number; min?: number; max?: number; suffix?: string; onCommit: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(r3(value))), [value]);
  const commit = () => { const n = Number(v); if (Number.isFinite(n) && n !== value) onCommit(n); else setV(String(r3(value))); };
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <span className="num-in"><input id={id} type="number" inputMode="decimal" step={step} min={min} max={max} value={v}
        onChange={e => setV(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />{suffix}</span>
    </label>
  );
}

function Slider({ id, label, value, min, max, step, format, onLive }: { id: string; label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onLive: (v: number) => void }) {
  const [v, setV] = useState(value);
  const dragging = useRef(false);
  useEffect(() => { if (!dragging.current) setV(value); }, [value]);
  const send = useThrottled(onLive);
  return (
    <label className="field slider" htmlFor={id}>
      <span>{label}<b>{format(v)}</b></span>
      <input id={id} type="range" min={min} max={max} step={step} value={v}
        onPointerDown={() => { dragging.current = true; }} onPointerUp={() => { dragging.current = false; }}
        onChange={e => { const n = Number(e.target.value); setV(n); send(n); }} />
    </label>
  );
}

function TextBox({ id, label, value, placeholder, onCommit }: { id: string; label: string; value: string; placeholder?: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="field col" htmlFor={id}>
      <span>{label}</span>
      <textarea id={id} rows={2} dir="auto" value={v} placeholder={placeholder} onChange={e => setV(e.target.value)}
        onBlur={() => v.trim() && v !== value && onCommit(v)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }} />
    </label>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Crop position over time, for video that does not match the canvas shape. */
function Framing({ project, onEdit }: { project: Project; onEdit: Edit }) {
  const mismatch = project.clips.some(c => {
    const m = project.media.find(x => x.id === c.mediaId);
    return c.track === 'video' && m?.width && m.height && Math.abs(m.width / m.height - project.width / project.height) > 0.01;
  });
  const t = useTime();
  if (!mismatch) return null;
  const pos = reframeAt(project.reframe, t);
  const keys = project.reframe ?? [];
  const set = (k: 'x' | 'y') => (v: number) => { const now = reframeAt(project.reframe, clock.get()); onEdit('set_reframe_key', { time: Math.round(clock.get() * 1000) / 1000, x: now.x, y: now.y, [k]: v }); };
  return (
    <div className="audio-settings">
      <h4>Framing</h4>
      <p className="meta-line">The video is a different shape than the canvas. Move the frame at the playhead; it eases between keyframes.</p>
      <Slider id="frame-x" label="Left ↔ right" value={pos.x} min={0} max={1} step={0.01} format={v => `${Math.round(v * 100)}%`} onLive={set('x')} />
      <Slider id="frame-y" label="Up ↕ down" value={pos.y} min={0} max={1} step={0.01} format={v => `${Math.round(v * 100)}%`} onLive={set('y')} />
      {keys.length > 0 && <ul className="keylist">{keys.map(k => (
        <li key={k.t}><button className="quiet" onClick={() => { clock.pause(); clock.seek(k.t); }}>{fmtTime(k.t)}</button><span>{Math.round(k.x * 100)}% · {Math.round(k.y * 100)}%</span><button className="quiet danger" aria-label="Remove keyframe" onClick={() => onEdit('set_reframe_key', { time: k.t, remove: true })}>×</button></li>
      ))}</ul>}
    </div>
  );
}

function AudioSettings({ project, onEdit }: { project: Project; onEdit: Edit }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const duck = project.audio?.duck, loud = project.audio?.loudness;
  const hasMusic = project.clips.some(c => c.track === 'audio');
  const normalize = async (target: number) => {
    setBusy(true); setErr('');
    try { await post('/audio/normalize', { target }); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="audio-settings">
      <h4>Audio</h4>
      <label className="check" htmlFor="duck-on"><input id="duck-on" type="checkbox" checked={!!duck} disabled={!hasMusic}
        onChange={e => onEdit('set_ducking', e.target.checked ? {} : { enabled: false }).catch(() => {})} /> Lower the music while people talk</label>
      {duck && <Slider id="duck-amount" label="Music under speech" value={duck.amount} min={-30} max={-3} step={1} format={v => `${v} dB`} onLive={v => onEdit('set_ducking', { amount: v })} />}
      <div className="row">
        <button disabled={busy || !project.clips.length} onClick={() => normalize(-14)}>{busy ? 'Measuring…' : loud ? 'Re-measure loudness' : 'Normalize loudness (-14 LUFS)'}</button>
        {loud && <button className="quiet" onClick={() => onEdit('set_loudness_off', {})}>Off</button>}
      </div>
      {loud && <p className="meta-line">Mix measured {loud.measured} LUFS → {loud.target} LUFS ({loud.gainDb >= 0 ? '+' : ''}{loud.gainDb} dB), peaks limited.</p>}
      {err && <p className="meta-line danger">{err}</p>}
    </div>
  );
}
const secs = (v: number) => `${v.toFixed(1)}s`;

interface Props { project: Project; selection: Selection; range: Range; onEdit: Edit; onSelect: (s: Selection) => void; onRange: (r: Range) => void }

export const Inspector = memo(function Inspector({ project, selection, range, onEdit, onSelect, onRange }: Props) {
  const [noteText, setNoteText] = useState('');
  const [rangeVol, setRangeVol] = useState(0.5);

  if (selection?.kind === 'clip') {
    const c = project.clips.find(x => x.id === selection.id);
    if (!c) return null;
    const m = project.media.find(x => x.id === c.mediaId);
    const up = (k: string) => (v: number) => onEdit('update_clip', { clipId: c.id, [k]: v });
    const len = clipLen(c);
    return (
      <div className="inspector">
        <h3><span className={`chip ${c.track}`}>{c.track === 'overlay' ? 'b-roll' : c.track}</span><span className="name">{m?.name}</span></h3>
        <div className="grid3">
          <NumField id="clip-start" label="Starts at" value={c.start} min={0} onCommit={up('start')} />
          <NumField id="clip-in" label="From (source)" value={c.in} min={0} onCommit={up('in')} />
          <NumField id="clip-out" label="To (source)" value={c.out} onCommit={up('out')} />
        </div>
        <p className="meta-line">Length {secs(len)} · ends at {fmtTime(clipEnd(c))}</p>
        {m?.hasAudio && <>
          <Slider id="clip-vol" label="Volume" value={c.volume} min={0} max={2} step={0.05} format={pct} onLive={up('volume')} />
          <div className="row">
            {[0, 0.5, 1, 1.5].map(v => <button key={v} className={c.volume === v ? 'on' : ''} onClick={() => up('volume')(v)}>{v === 0 ? 'Mute' : pct(v)}</button>)}
          </div>
          <div className="grid2">
            <Slider id="clip-fin" label="Fade in" value={c.fadeIn ?? 0} min={0} max={Math.min(3, len / 2)} step={0.1} format={secs} onLive={up('fadeIn')} />
            <Slider id="clip-fout" label="Fade out" value={c.fadeOut ?? 0} min={0} max={Math.min(3, len / 2)} step={0.1} format={secs} onLive={up('fadeOut')} />
          </div>
        </>}
        {c.track === 'overlay' && <div className="field"><span>Where</span>
          <div className="layouts">{Object.entries(LAYOUTS).map(([k, b]) => {
            const on = c.layout && Math.abs(c.layout.x - b.x) < 0.01 && Math.abs(c.layout.y - b.y) < 0.01 && Math.abs(c.layout.w - b.w) < 0.01 && Math.abs(c.layout.h - b.h) < 0.01;
            return <button key={k} title={k} aria-label={k} className={`layout${on ? ' on' : ''}`} onClick={() => onEdit('update_clip', { clipId: c.id, layout: k })}><i style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }} /></button>;
          })}</div>
        </div>}
        {c.track !== 'audio' && <>
          <div className="field"><span>Speed<b>{c.speed ?? 1}×</b></span>
            <div className="row">{[0.5, 0.75, 1, 1.25, 1.5, 2].map(v => <button key={v} className={(c.speed ?? 1) === v ? 'on' : ''} onClick={() => onEdit('set_speed', { clipId: c.id, speed: v })}>{v}×</button>)}</div>
          </div>
          <div className="grid2">
            <Slider id="clip-vfin" label="Fade from black" value={c.videoFadeIn ?? 0} min={0} max={Math.min(3, len / 2)} step={0.1} format={secs} onLive={up('videoFadeIn')} />
            <Slider id="clip-vfout" label="Fade to black" value={c.videoFadeOut ?? 0} min={0} max={Math.min(3, len / 2)} step={0.1} format={secs} onLive={up('videoFadeOut')} />
          </div>
        </>}
        {m?.hasAudio && <label className="check" htmlFor="clip-denoise"><input id="clip-denoise" type="checkbox" checked={!!c.denoise} onChange={e => onEdit('update_clip', { clipId: c.id, denoise: e.target.checked })} /> Reduce background noise <span className="meta-line">(on export)</span></label>}
        <div className="row actions">
          <button onClick={() => { const t = clock.get(); onEdit('split_clip', { clipId: c.id, at: t }); }} disabled={!(clock.get() > c.start && clock.get() < clipEnd(c))}>Split at playhead</button>
          <button className="danger" onClick={() => { onEdit('remove_clip', { clipId: c.id, ripple: true }); onSelect(null); }}>Delete</button>
          <button className="danger quiet" onClick={() => { onEdit('remove_clip', { clipId: c.id, ripple: false }); onSelect(null); }}>Delete, keep gap</button>
        </div>
      </div>
    );
  }

  if (selection?.kind === 'text') {
    const t = project.texts.find(x => x.id === selection.id);
    if (!t) return null;
    const up = (k: string) => (v: unknown) => onEdit('update_text', { textId: t.id, [k]: v });
    return (
      <div className="inspector">
        <h3><span className="chip text">{t.style}</span><span className="name">Text</span></h3>
        <TextBox id="text-body" label="Text" value={t.text} onCommit={up('text')} />
        {t.words?.length ? <p className="meta-line">Word-by-word highlight is kept if you only change spelling, not the number of words.</p> : null}
        <div className="grid3">
          <NumField id="text-start" label="Start" value={t.start} min={0} onCommit={up('start')} />
          <NumField id="text-end" label="End" value={t.end} onCommit={up('end')} />
          <label className="field" htmlFor="text-color"><span>{t.style === 'caption' ? 'Highlight' : 'Color'}</span>
            <input id="text-color" type="color" value={t.color ?? (t.style === 'caption' ? '#f0cf6a' : '#ffffff')} onChange={e => up('color')(e.target.value)} /></label>
        </div>
        <div className="row">
          <div className="seg"><button aria-pressed={t.style === 'title'} onClick={() => up('style')('title')}>Title</button><button aria-pressed={t.style === 'caption'} onClick={() => up('style')('caption')}>Caption</button></div>
          <div className="seg">{(['top', 'middle', 'bottom'] as const).map(p => <button key={p} aria-pressed={positionOf(t) === p} onClick={() => up('position')(p)}>{p}</button>)}</div>
        </div>
        {t.style === 'caption' && <>
          <div className="presets">
            {(Object.keys(CAPTION_PRESETS) as (keyof typeof CAPTION_PRESETS)[]).map(k => (
              <button key={k} className={`preset p-${k}${(t.preset ?? 'karaoke') === k ? ' on' : ''}`} onClick={() => up('preset')(k)}><b>Aa</b>{CAPTION_PRESETS[k].label}</button>
            ))}
          </div>
          <button onClick={() => onEdit('set_caption_style', { preset: t.preset ?? 'karaoke', position: positionOf(t), color: t.color ?? '' })}>Use this look for all captions</button>
        </>}
        <div className="row actions"><button className="danger" onClick={() => { onEdit('remove_text', { textId: t.id }); onSelect(null); }}>Delete</button></div>
      </div>
    );
  }

  if (selection?.kind === 'effect') {
    const e = project.effects.find(x => x.id === selection.id);
    if (!e) return null;
    const up = (k: string) => (v: number) => onEdit('update_effect', { effectId: e.id, [k]: v });
    return (
      <div className="inspector">
        <h3><span className="chip fx">zoom</span><span className="name">Zoom {e.scale}×</span></h3>
        <Slider id="fx-scale" label="Amount" value={e.scale} min={1.05} max={2.5} step={0.05} format={v => `${v.toFixed(2)}×`} onLive={up('scale')} />
        <Slider id="fx-ease" label="Smoothness (ease)" value={e.ease} min={0} max={1.5} step={0.05} format={secs} onLive={up('ease')} />
        <div className="grid2">
          <NumField id="fx-start" label="Start" value={e.start} min={0} onCommit={up('start')} />
          <NumField id="fx-end" label="End" value={e.end} onCommit={up('end')} />
        </div>
        <p className="meta-line">Click on the video to aim the zoom (now {Math.round(e.anchorX * 100)}%, {Math.round(e.anchorY * 100)}%).</p>
        <div className="row actions"><button className="danger" onClick={() => { onEdit('remove_effect', { effectId: e.id }); onSelect(null); }}>Delete</button></div>
      </div>
    );
  }

  if (selection?.kind === 'marker') {
    const m = project.markers.find(x => x.id === selection.id);
    if (!m) return null;
    const up = (k: string) => (v: unknown) => onEdit('update_note', { markerId: m.id, [k]: v });
    return (
      <div className="inspector">
        <h3><span className={`chip note ${m.kind}`}>{m.kind === 'dont' ? 'locked' : 'note for agent'}</span><span className="name">{fmtTime(m.start)} → {fmtTime(m.end)}</span></h3>
        <div className="seg wide"><button aria-pressed={m.kind === 'do'} onClick={() => up('kind')('do')}>Do this here</button><button aria-pressed={m.kind === 'dont'} onClick={() => up('kind')('dont')}>Don't touch this part</button></div>
        <TextBox id="note-text" label={m.kind === 'dont' ? 'Why (the agent sees this)' : 'What should the agent do here?'} value={m.text} onCommit={up('text')} />
        <div className="grid2">
          <NumField id="note-start" label="Start" value={m.start} min={0} onCommit={up('start')} />
          <NumField id="note-end" label="End" value={m.end} onCommit={up('end')} />
        </div>
        {m.reply && <p className="reply" dir="auto">Agent: {m.reply}</p>}
        <div className="row actions">
          {m.kind === 'do' && <button onClick={() => up('status')(m.status === 'done' ? 'open' : 'done')}>{m.status === 'done' ? 'Reopen' : 'Mark done'}</button>}
          <button className="danger" onClick={() => { onEdit('remove_note', { markerId: m.id }); onSelect(null); }}>Delete</button>
        </div>
      </div>
    );
  }

  if (range) {
    const len = range.end - range.start;
    const addNote = (kind: 'do' | 'dont') => { if (!noteText.trim()) return; onEdit('add_note', { start: r3(range.start), end: r3(range.end), text: noteText, kind }).then(() => { setNoteText(''); onRange(null); }); };
    return (
      <div className="inspector">
        <h3><span className="chip range">range</span><span className="name">{fmtTime(range.start)} → {fmtTime(range.end)} · {secs(len)}</span></h3>
        <label className="field col" htmlFor="range-note"><span>Tell the agent what to do (or not do) here</span>
          <textarea id="range-note" rows={2} dir="auto" value={noteText} onChange={e => setNoteText(e.target.value)} placeholder='e.g. زوّد الزوم هنا · don’t cut this joke' /></label>
        <div className="row">
          <button className="primary" disabled={!noteText.trim()} onClick={() => addNote('do')}>Add note</button>
          <button disabled={!noteText.trim()} onClick={() => addNote('dont')}>🔒 Lock: don't touch</button>
        </div>
        <Slider id="range-vol" label="Volume for this part" value={rangeVol} min={0} max={2} step={0.05} format={pct} onLive={setRangeVol} />
        <div className="row actions">
          <button onClick={() => onEdit('set_volume', { start: r3(range.start), end: r3(range.end), volume: rangeVol })}>Apply volume</button>
          <button onClick={() => onEdit('add_zoom', { start: r3(range.start), end: r3(range.end) }).then(() => onRange(null))}>Zoom here</button>
          <button onClick={() => onEdit('add_text', { text: 'عنوان', start: r3(range.start), end: r3(range.end), style: 'title' }).then(() => onRange(null))}>Title here</button>
          <button className="danger" onClick={() => onEdit('cut_range', { start: r3(range.start), end: r3(range.end) }).then(() => onRange(null))}>Cut out</button>
          <button className="quiet" onClick={() => onRange(null)}>Clear</button>
        </div>
      </div>
    );
  }

  const presets: [string, number, number][] = [['9:16', 1080, 1920], ['16:9', 1920, 1080], ['1:1', 1080, 1080], ['4:5', 1080, 1350]];
  const under = clipAt(project, 'video', clock.get());
  return (
    <div className="inspector">
      <h3><span className="name">Project</span></h3>
      <div className="row">
        {presets.map(([label, w, h]) => <button key={label} className={project.width === w && project.height === h ? 'on' : ''} onClick={() => onEdit('set_canvas', { width: w, height: h })}>{label}</button>)}
      </div>
      <Framing project={project} onEdit={onEdit} />
      <AudioSettings project={project} onEdit={onEdit} />
      <p className="meta-line">Click anything on the timeline to edit it. Drag on the ruler to select a range, then cut it, change its volume, or leave a note for the agent.</p>
      <dl className="keys">
        <div><dt>Space</dt><dd>play / pause</dd></div>
        <div><dt>S</dt><dd>split at playhead{under ? '' : ' (no clip here)'}</dd></div>
        <div><dt>Del</dt><dd>delete selected</dd></div>
        <div><dt>N</dt><dd>note for the agent here</dd></div>
        <div><dt>T / Z</dt><dd>add title / zoom here</dd></div>
        <div><dt>← →</dt><dd>one frame (Shift: 1s)</dd></div>
        <div><dt>⌘/Ctrl Z</dt><dd>undo last step</dd></div>
      </dl>
    </div>
  );
});

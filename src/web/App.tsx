import { useEffect, useMemo, useRef, useState } from 'react';
import { applyChanges } from '../shared/diff';
import { duration, fmtTime } from '../shared/timeline';
import type { Step } from '../shared/types';
import { post, upload, useServerState } from './api';
import { Preview } from './Preview';
import { Steps } from './Steps';
import { Timeline } from './Timeline';

export function App() {
  const { state, online } = useServerState();
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [follow, setFollow] = useState(true);
  const [peek, setPeek] = useState<string | null>(null);
  const [hover, setHover] = useState<Step | null>(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const steps = state?.steps ?? [];
  const last = steps[steps.length - 1];
  const peekStep = steps.find(s => s.id === peek);
  // "Hold: before" shows the project with that one step reverted.
  const project = useMemo(() => {
    if (!state) return null;
    return peekStep ? applyChanges(state.project, peekStep.changes, 'revert') : state.project;
  }, [state, peekStep]);
  const total = project ? duration(project) : 0;

  // Playback clock.
  useEffect(() => {
    if (!playing) return;
    let raf = 0, prev = performance.now();
    const tick = (now: number) => {
      setTime(t => {
        const n = t + (now - prev) / 1000;
        if (n >= total) { setPlaying(false); return total; }
        return n;
      });
      prev = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, total]);

  // Follow the agent: jump to where each new step happened.
  useEffect(() => {
    if (follow && !playing && last?.at != null) setTime(last.at);
  }, [last?.id, last?.status]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || (e.target as HTMLElement).closest('input, textarea, button')) return;
      e.preventDefault();
      setPlaying(p => !p);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => { if (error) { const t = setTimeout(() => setError(''), 5000); return () => clearTimeout(t); } }, [error]);

  const doUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try { await upload(files); } catch (e: any) { setError(e.message); } finally { setUploading(false); }
  };

  const ids = (s?: Step | null) => new Set((s?.changes ?? []).map(c => c.id));
  const fresh = useMemo(() => ids(last), [last?.id]);
  const highlight = useMemo(() => ids(hover), [hover?.id]);

  if (!state || !project) return <div className="loading">{online ? 'Loading…' : 'Connecting to LiveCut…'}</div>;
  const render = state.render;

  return (
    <div className="app"
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={e => { e.preventDefault(); setDragging(false); doUpload(e.dataTransfer.files); }}>
      <header className="topbar">
        <div className="brand"><span className="mark" aria-hidden="true" />LiveCut</div>
        <span className="meta">{project.width}×{project.height} · {project.fps}fps · {fmtTime(total)}</span>
        {!online && <span className="offline">reconnecting…</span>}
        <div className="spacer" />
        <input ref={fileInput} id="file-input" type="file" multiple accept="video/*,audio/*,image/*" hidden onChange={e => { doUpload(e.target.files); e.target.value = ''; }} />
        <button onClick={() => fileInput.current?.click()} disabled={uploading}>{uploading ? 'Uploading…' : 'Add media'}</button>
        {render.status === 'rendering'
          ? <span className="progress"><span style={{ width: `${Math.round(render.progress * 100)}%` }} />Exporting {Math.round(render.progress * 100)}%</span>
          : <button className="primary" onClick={() => post('/export').catch(e => setError(e.message))} disabled={!project.clips.length}>Export MP4</button>}
        {render.status === 'done' && render.file && <a className="download" href={`/exports/${render.file}`}>Download</a>}
        {confirmReset
          ? <span className="confirm">Delete all media and steps? <button onClick={() => { post('/reset'); setConfirmReset(false); setTime(0); }}>Delete</button><button onClick={() => setConfirmReset(false)}>Cancel</button></span>
          : <button className="ghost" onClick={() => setConfirmReset(true)}>New project</button>}
      </header>

      <main className="workspace">
        <section className="editor">
          <div className="stage"><Preview project={project} time={time} playing={playing} peeking={!!peekStep} /></div>
          <div className="transport">
            <button className="play" aria-label={playing ? 'Pause' : 'Play'} onClick={() => { if (time >= total) setTime(0); setPlaying(p => !p); }}>
              <svg viewBox="0 0 14 14">{playing ? <path d="M3 1.5h3v11H3zM8 1.5h3v11H8z" /> : <path d="M3 1.5v11l9-5.5z" />}</svg>
            </button>
            <span className="tc">{fmtTime(time)} <i>/ {fmtTime(total)}</i></span>
            <label className="follow"><input id="follow" type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} /> follow agent</label>
            <span className={`live ${state.control.paused ? 'paused' : state.agentConnected ? 'busy' : ''}`}><b />{state.control.paused ? 'paused · you have control' : peekStep ? `before step ${peekStep.n}` : 'live preview'}</span>
          </div>
          <Timeline project={project} time={time} onSeek={t => { setPlaying(false); setTime(t); }} highlight={highlight} fresh={fresh} />
          {render.status === 'error' && <div className="render-error">Export failed: {render.error}</div>}
        </section>
        <Steps state={state} onJump={t => { setPlaying(false); setTime(t); }} onPeek={setPeek} onHover={setHover} onError={setError} />
      </main>

      {dragging && <div className="dropzone">Drop to add to the timeline</div>}
      {error && <div className="toast" role="alert">{error}</div>}
    </div>
  );
}

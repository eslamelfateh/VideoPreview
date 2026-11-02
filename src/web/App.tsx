import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from './i18n';
import { applyChanges } from '../shared/diff';
import { clipAt, clipEnd, duration, fmtTime } from '../shared/timeline';
import type { Marker, ProjectInfo, Step, VersionInfo } from '../shared/types';
import { post, REVIEW, reviewNote, upload, useServerState } from './api';
import { clock, usePlaying, useTime } from './clock';
import { Inspector } from './Inspector';
import { Preview, unlockAudio } from './Preview';
import { Steps } from './Steps';
import { Timeline, type Range, type Selection } from './Timeline';

function Projects({ projects, current, name, reviewToken, onError }: { projects: ProjectInfo[]; current: string; name: string; reviewToken?: string; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [rename, setRename] = useState(name);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => setRename(name), [name]);
  const act = (p: Promise<unknown>) => p.catch(e => onError(e.message));
  const link = reviewToken ? `${location.origin}/review/${reviewToken}` : '';
  return (
    <div className="versions">
      <button aria-expanded={open} onClick={() => setOpen(o => !o)} className="project-name" title="Projects">{name}</button>
      {open && (
        <div className="menu" role="dialog" aria-label="Projects">
          <form className="row" onSubmit={e => { e.preventDefault(); act(post('/projects/rename', { name: rename })); }}>
            <input id="project-rename" value={rename} onChange={e => setRename(e.target.value)} aria-label="Project name" dir="auto" />
            <button type="submit" disabled={rename === name}>{t("Rename")}</button>
          </form>
          <div className="review-link">
            <b>{t("Review link")}</b>
            <span className="meta-line">{t("Anyone with it can watch this project and pin notes for the agent, but not edit.")}</span>
            {link
              ? <div className="row"><input id="review-url" readOnly value={link} aria-label={t("Review link")} onFocus={e => e.currentTarget.select()} />
                  <button onClick={() => navigator.clipboard.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => (document.getElementById('review-url') as HTMLInputElement)?.select())}>{copied ? 'Copied' : 'Copy'}</button>
                  <button className="quiet danger" onClick={() => act(post('/review-link/revoke'))}>{t("Turn off")}</button></div>
              : <button onClick={() => act(post('/review-link'))}>{t("Create review link")}</button>}
          </div>
          <form className="row" onSubmit={e => { e.preventDefault(); act(post('/projects', { name: newName }).then(() => setNewName(''))); }}>
            <input id="project-new" value={newName} onChange={e => setNewName(e.target.value)} placeholder={t("New project name")} dir="auto" aria-label={t("New project name")} />
            <button type="submit" className="primary">{t("New")}</button>
          </form>
          <ul>{projects.map(p => (
            <li key={p.id} className={p.id === current ? 'current' : ''}>
              <div><b dir="auto">{p.name}</b><span className="meta-line">{p.id === current ? 'open now' : new Date(p.updated).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span></div>
              {p.id !== current && (confirm === p.id
                ? <><button className="danger" onClick={() => { act(post(`/projects/${p.id}/delete`)); setConfirm(null); }}>{t("Delete")}</button><button onClick={() => setConfirm(null)}>{t("Keep")}</button></>
                : <><button onClick={() => act(post(`/projects/${p.id}/open`))}>{t("Open")}</button><button className="quiet" aria-label={`Delete ${p.name}`} onClick={() => setConfirm(p.id)}>×</button></>)}
            </li>
          ))}</ul>
        </div>
      )}
    </div>
  );
}

/** What a reviewer sees beside the video: how to leave notes, and the notes so far. */
function ReviewPanel({ markers, range, onRange, onError }: { markers: Marker[]; range: Range; onRange: (r: Range) => void; onError: (m: string) => void }) {
  const [text, setText] = useState('');
  const [sent, setSent] = useState('');
  const send = (kind: 'do' | 'dont') => {
    const r = range ?? { start: clock.get(), end: clock.get() + 2 };
    reviewNote({ start: Math.round(r.start * 100) / 100, end: Math.round(r.end * 100) / 100, text, kind })
      .then(() => { setText(''); setSent('Sent. The editor will see it on the timeline.'); onRange(null); setTimeout(() => setSent(''), 4000); })
      .catch(e => onError(e.message));
  };
  return (
    <div className="inspector">
      <h3><span className="chip range">review</span><span className="name">{t("Leave a note")}</span></h3>
      <p className="meta-line">{t("Play the video, then drag on the ruler above the timeline to pick a moment (or use the playhead). Your note is pinned there for the editor and the AI agent.")}</p>
      <label className="field col" htmlFor="review-text"><span>{range ? `${fmtTime(range.start)} → ${fmtTime(range.end)}` : `At ${fmtTime(clock.get())}`}</span>
        <textarea id="review-text" rows={3} dir="auto" value={text} onChange={e => setText(e.target.value)} placeholder="e.g. الكابشن هنا صغير · cut this part" /></label>
      <div className="row">
        <button className="primary" disabled={!text.trim()} onClick={() => send('do')}>{t("Send note")}</button>
        <button disabled={!text.trim()} onClick={() => send('dont')}>{t("🔒 Keep this part as is")}</button>
      </div>
      {sent && <p className="reply">{sent}</p>}
      {markers.length > 0 && <ul className="keylist">{markers.map(m => (
        <li key={m.id}><button className="quiet" onClick={() => { clock.pause(); clock.seek(m.start); }}>{fmtTime(m.start)}</button><span dir="auto">{m.kind === 'dont' ? '🔒 ' : m.status === 'done' ? '✓ ' : ''}{m.text}</span></li>
      ))}</ul>}
    </div>
  );
}

function Versions({ versions, onError }: { versions: VersionInfo[]; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const act = (p: Promise<unknown>) => p.catch(e => onError(e.message));
  return (
    <div className="versions">
      <button aria-expanded={open} onClick={() => setOpen(o => !o)}>Versions{versions.length ? ` (${versions.length})` : ''}</button>
      {open && (
        <div className="menu" role="dialog" aria-label={t("Versions")}>
          <form className="row" onSubmit={e => { e.preventDefault(); act(post('/versions', { name }).then(() => setName(''))); }}>
            <input id="version-name" value={name} onChange={e => setName(e.target.value)} placeholder={t("Name this version")} dir="auto" aria-label="Version name" />
            <button type="submit" className="primary">{t("Save")}</button>
          </form>
          {versions.length === 0 && <p className="meta-line">{t("Save the current edit to compare it with another one later, or ask the agent for two versions.")}</p>}
          <ul>{[...versions].reverse().map(v => (
            <li key={v.id}>
              <div><b dir="auto">{v.name}</b><span className="meta-line">{fmtTime(v.duration)} · {v.clips} clips · {v.texts} texts · {new Date(v.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
              {confirm === v.id
                ? <><button className="danger" onClick={() => { act(post(`/versions/${v.id}/delete`)); setConfirm(null); }}>{t("Delete")}</button><button onClick={() => setConfirm(null)}>{t("Keep")}</button></>
                : <><button onClick={() => act(post(`/versions/${v.id}/load`))} title="Replaces the timeline; you can undo it">{t("Open")}</button><button className="quiet" aria-label={`Delete ${v.name}`} onClick={() => setConfirm(v.id)}>×</button></>}
            </li>
          ))}</ul>
        </div>
      )}
    </div>
  );
}

function TimeDisplay({ total }: { total: number }) {
  const t = useTime();
  return <span className="tc">{fmtTime(t)} <i>/ {fmtTime(total)}</i></span>;
}

function PlayButton() {
  const playing = usePlaying();
  return (
    <button className="play" aria-label={playing ? 'Pause' : 'Play'} onClick={() => { unlockAudio(); clock.toggle(); }}>
      <svg viewBox="0 0 14 14">{playing ? <path d="M3 1.5h3v11H3zM8 1.5h3v11H8z" /> : <path d="M3 1.5v11l9-5.5z" />}</svg>
    </button>
  );
}

export function App() {
  const { state, online } = useServerState();
  const [follow, setFollow] = useState(true);
  const [peek, setPeek] = useState<string | null>(null);
  const [hover, setHover] = useState<Step | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [range, setRange] = useState<Range>(null);
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
  }, [state?.project, peekStep]);
  const total = project ? duration(project) : 0;
  useEffect(() => clock.setEnd(total), [total]);

  // Follow the agent: jump to where each new agent step happened.
  useEffect(() => {
    if (follow && last?.by === 'agent' && !clock.isPlaying() && last.at != null) clock.seek(last.at);
  }, [last?.id, last?.status]);

  // Drop a selection that no longer exists (deleted by the agent or undone).
  useEffect(() => {
    if (!selection || !project) return;
    const lists = { clip: project.clips, text: project.texts, effect: project.effects, marker: project.markers } as const;
    if (!(lists[selection.kind] as { id: string }[]).some(x => x.id === selection.id)) setSelection(null);
  }, [project, selection]);

  useEffect(() => { if (error) { const t = setTimeout(() => setError(''), 6000); return () => clearTimeout(t); } }, [error]);

  const edit = useCallback(async (op: string, args: Record<string, unknown>) => {
    try { return await post('/edit', { op, args }); }
    catch (e: any) { setError(e.message); throw e; }
  }, []);

  // Keyboard shortcuts (ignored while typing).
  const ref = useRef({ project, selection, range, steps });
  ref.current = { project, selection, range, steps };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]')) return;
      const { project: p, selection: sel } = ref.current;
      if (!p) return;
      const t = clock.get();
      const fps = p.fps || 30;
      const k = e.key.toLowerCase();
      const fail = () => {};
      if (e.code === 'Space' && !el.closest('button')) { e.preventDefault(); unlockAudio(); clock.toggle(); }
      else if ((e.metaKey || e.ctrlKey) && k === 'z' && !REVIEW) {
        e.preventDefault();
        post('/undo-last').catch(er => setError(er.message));
      }
      else if (e.metaKey || e.ctrlKey || e.altKey) return;
      else if (REVIEW && !['arrowleft', 'arrowright', 'escape'].includes(k)) return;
      else if (k === 'arrowleft' || k === 'arrowright') { e.preventDefault(); clock.pause(); clock.seek(t + (k === 'arrowright' ? 1 : -1) * (e.shiftKey ? 1 : 1 / fps)); }
      else if (k === 's') {
        const c = sel?.kind === 'clip' ? p.clips.find(x => x.id === sel.id) : clipAt(p, 'video', t) ?? clipAt(p, 'audio', t);
        if (c && t > c.start && t < clipEnd(c)) edit('split_clip', { clipId: c.id, at: Math.round(t * 1000) / 1000 }).catch(fail);
      }
      else if ((k === 'delete' || k === 'backspace') && sel) {
        e.preventDefault();
        const op = { clip: ['remove_clip', 'clipId'], text: ['remove_text', 'textId'], effect: ['remove_effect', 'effectId'], marker: ['remove_note', 'markerId'] }[sel.kind];
        edit(op[0], { [op[1]]: sel.id, ...(sel.kind === 'clip' ? { ripple: true } : {}) }).then(() => setSelection(null)).catch(fail);
      }
      else if (k === 'n') { const r = ref.current.range ?? { start: t, end: Math.min(t + 2, duration(p) || t + 2) }; onRange(r); setTimeout(() => (document.getElementById('range-note') as HTMLTextAreaElement | null)?.focus(), 30); }
      else if (k === 't') edit('add_text', { text: 'عنوان', start: t, end: t + 2, style: 'title' }).catch(fail);
      else if (k === 'z') edit('add_zoom', { start: t, end: t + 1.5 }).catch(fail);
      else if (k === 'escape') { setSelection(null); setRange(null); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [edit]);

  const doUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try { await upload(files); } catch (e: any) { setError(e.message); } finally { setUploading(false); }
  };

  const ids = (s?: Step | null) => new Set((s?.changes ?? []).map(c => c.id));
  const fresh = useMemo(() => ids(last), [last?.id, last?.time]);
  const highlight = useMemo(() => ids(hover), [hover?.id]);
  const onJump = useCallback((t: number) => { clock.pause(); clock.seek(t); }, []);
  const onSelect = useCallback((s: Selection) => { setSelection(s); if (s) setRange(null); }, []);
  const onRange = useCallback((r: Range) => { setRange(r); if (r) setSelection(null); }, []);

  const zoomSel = selection?.kind === 'effect' ? project?.effects.find(e => e.id === selection.id) : undefined;
  const onAnchor = useCallback((x: number, y: number) => {
    if (selection?.kind === 'effect') edit('update_effect', { effectId: selection.id, anchorX: Math.round(x * 100) / 100, anchorY: Math.round(y * 100) / 100 }).catch(() => {});
  }, [selection, edit]);

  if (!state || !project) return <div className="loading">{online ? 'Loading…' : 'Connecting to LiveCut…'}</div>;
  const render = state.render;
  const openNotes = project.markers.filter(m => m.kind === 'do' && m.status === 'open').length;

  return (
    <div className={`app${REVIEW ? ' reviewing' : ''}`}
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={e => { e.preventDefault(); setDragging(false); if (!REVIEW) doUpload(e.dataTransfer.files); }}>
      <header className="topbar">
        <div className="brand"><span className="mark" aria-hidden="true" />LiveCut</div>
        {REVIEW ? <span className="review-badge">Review · {project.name}</span>
          : <Projects projects={state.projects} current={state.projectId} name={project.name} reviewToken={state.reviewToken} onError={setError} />}
        <span className="meta">{project.width}×{project.height} · {project.fps}fps · {fmtTime(total)}</span>
        {!online && <span className="offline">{t("reconnecting…")}</span>}
        <div className="spacer" />
        <input ref={fileInput} id="file-input" type="file" multiple accept="video/*,audio/*,image/*" hidden onChange={e => { doUpload(e.target.files); e.target.value = ''; }} />
        {!REVIEW && <>
        <Versions versions={state.versions} onError={setError} />
        <button onClick={() => fileInput.current?.click()} disabled={uploading}>{uploading ? 'Uploading…' : 'Add media'}</button>
        {render.status === 'rendering'
          ? <span className="progress" title={render.encoder}><span style={{ width: `${Math.round(render.progress * 100)}%` }} />Exporting {Math.round(render.progress * 100)}%</span>
          : <>
            <button onClick={() => post('/export', { quality: 'draft' }).catch(e => setError(e.message))} disabled={!project.clips.length} title="Faster, lower quality, for checking">{t("Quick draft")}</button>
            <button className="primary" onClick={() => post('/export', { quality: 'final' }).catch(e => setError(e.message))} disabled={!project.clips.length}>{t("Export MP4")}</button>
          </>}
        {render.status === 'done' && render.file && <a className="download" href={`/exports/${render.file}`} title={render.encoder ? `Encoded with ${render.encoder}` : undefined}>{t("Download")}</a>}
        {confirmReset
          ? <span className="confirm">{t("Empty this project (clips, steps, versions)?")} <button onClick={() => { post('/reset'); setConfirmReset(false); clock.seek(0); setSelection(null); setRange(null); }}>{t("Delete")}</button><button onClick={() => setConfirmReset(false)}>{t("Cancel")}</button></span>
          : <button className="ghost" onClick={() => setConfirmReset(true)}>{t("Clear")}</button>}
        </>}
      </header>

      <main className="workspace">
        <section className="editor">
          <div className="stage-row">
            <div className="stage"><div className="fit">
              <Preview project={project} assets={state.assets} speech={state.speech} peeking={!!peekStep} anchorFor={zoomSel} onAnchor={onAnchor} />
            </div></div>
            {REVIEW ? <ReviewPanel markers={project.markers} range={range} onRange={onRange} onError={setError} />
              : <Inspector project={project} selection={selection} range={range} onEdit={edit} onSelect={onSelect} onRange={onRange} />}
          </div>
          <div className="transport">
            <PlayButton />
            <TimeDisplay total={total} />
            {!REVIEW && <label className="follow"><input id="follow" type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} /> {t("follow agent")}</label>}
            {openNotes > 0 && <span className="open-notes">{openNotes} note{openNotes > 1 ? 's' : ''} waiting for the agent</span>}
            <span className={`live ${state.control.paused ? 'paused' : state.agentConnected ? 'busy' : ''}`}><b />{state.control.paused ? 'paused · you have control' : peekStep ? `before step ${peekStep.n}` : 'live preview'}</span>
          </div>
          <Timeline project={project} assets={state.assets} selection={selection} onSelect={onSelect} range={range} onRange={onRange} onEdit={edit} highlight={highlight} fresh={fresh} readOnly={!!REVIEW} />
          {render.status === 'error' && <div className="render-error">Export failed: {render.error}</div>}
        </section>
        {!REVIEW && <Steps state={state} onJump={onJump} onPeek={setPeek} onHover={setHover} onError={setError} />}
      </main>

      {dragging && <div className="dropzone">{t("Drop to add to the timeline")}</div>}
      {error && <div className="toast" role="alert" onClick={() => setError('')}>{error}</div>}
    </div>
  );
}

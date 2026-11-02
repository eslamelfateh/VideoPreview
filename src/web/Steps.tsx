import { memo, useEffect, useRef, useState } from 'react';
import type { ServerState, Step } from '../shared/types';
import { post } from './api';

interface Props {
  state: ServerState;
  onJump: (t: number) => void;
  onPeek: (stepId: string | null) => void;
  onHover: (step: Step | null) => void;
  onError: (msg: string) => void;
}

const mcpUrl = () => `${location.origin}/mcp`;

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy">
      <code>{text}</code>
      <button onClick={() => navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }).catch(() => {})}>{done ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

function StepCard({ step, reviewing, onJump, onPeek, onHover, onError }: { step: Step; reviewing: boolean } & Omit<Props, 'state'>) {
  const [note, setNote] = useState('');
  const peeking = useRef(false);
  const act = (p: Promise<unknown>) => p.catch(e => onError(e.message));
  const start = () => { if (!step.undone && step.status !== 'rejected') { peeking.current = true; onPeek(step.id); } };
  const end = () => { if (peeking.current) { peeking.current = false; onPeek(null); } };
  const canReview = step.changes.length > 0 && step.status !== 'rejected';

  return (
    <li className={`step ${step.status}${step.undone ? ' undone' : ''}`} onMouseEnter={() => onHover(step)} onMouseLeave={() => onHover(null)}>
      <div className="step-top">
        <span className={`dot ${step.status}`} aria-hidden="true" />
        <span className="num">{String(step.n).padStart(2, '0')}</span>
        <button className="tool" onClick={() => step.at != null && onJump(step.at)} title={step.at != null ? 'Jump to this point' : undefined}>{step.tool}</button>
        {step.by === 'user' && <span className="by">you</span>}
        <span className="state">{step.undone ? 'undone' : step.status === 'review' ? 'needs review' : step.status === 'rejected' ? 'rejected' : ''}</span>
      </div>
      <div className="summary" dir="auto">{step.summary}</div>
      {step.feedback && <div className="feedback" dir="auto">“{step.feedback}”</div>}
      {reviewing ? (
        <form className="review" onSubmit={e => { e.preventDefault(); act(post(`/steps/${step.id}/decision`, { approve: true, note })); }}>
          <input id={`note-${step.id}`} value={note} onChange={e => setNote(e.target.value)} placeholder="Optional note, e.g. make it slower" dir="auto" aria-label="Note to the agent" />
          <div className="row">
            <button type="button" className="hold" onPointerDown={start} onPointerUp={end} onPointerLeave={end} onKeyDown={e => (e.key === ' ' || e.key === 'Enter') && start()} onKeyUp={end}>Hold: before</button>
            <button type="button" className="reject" onClick={() => act(post(`/steps/${step.id}/decision`, { approve: false, note }))}>Reject</button>
            <button type="submit" className="accept">Accept</button>
          </div>
        </form>
      ) : canReview && (
        <div className="row">
          <button onClick={() => act(post(`/steps/${step.id}/undo`))}>{step.undone ? 'Redo' : 'Undo'}</button>
          {!step.undone && <button className="hold" onPointerDown={start} onPointerUp={end} onPointerLeave={end} onKeyDown={e => (e.key === ' ' || e.key === 'Enter') && start()} onKeyUp={end}>Hold: before</button>}
        </div>
      )}
    </li>
  );
}

export const Steps = memo(function Steps({ state, onJump, onPeek, onHover, onError }: Props) {
  const list = useRef<HTMLOListElement>(null);
  const [msg, setMsg] = useState('');
  const { control, steps, agentConnected, notes } = state;
  const reviewId = steps.find(s => s.status === 'review')?.id;

  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' }); }, [steps.length, reviewId]);

  const send = async () => {
    if (!msg.trim()) return;
    try { await post('/notes', { text: msg }); setMsg(''); } catch (e: any) { onError(e.message); }
  };

  return (
    <aside className="agent">
      <header>
        <h2>Agent</h2>
        <span className={`conn${agentConnected ? ' on' : ''}`}>{agentConnected ? 'connected' : 'not connected'}</span>
        <div className="seg" role="group" aria-label="Review mode">
          <button aria-pressed={control.mode === 'live'} onClick={() => post('/control', { mode: 'live' })} title="Edits apply right away; you can undo any of them">Live</button>
          <button aria-pressed={control.mode === 'step'} onClick={() => post('/control', { mode: 'step' })} title="The agent waits for you to accept each edit">Step</button>
        </div>
        <button className={`pause${control.paused ? ' on' : ''}`} onClick={() => post('/control', { paused: !control.paused })}>{control.paused ? 'Resume' : 'Pause'}</button>
      </header>

      {steps.length === 0 ? (
        <div className="onboard">
          <p><b>1.</b> Drop a video into the editor.</p>
          <p><b>2.</b> Connect an agent. For Claude Code:</p>
          <Copy text={`claude mcp add --transport http livecut ${mcpUrl()}`} />
          <p><b>3.</b> Ask it for an edit, for example:</p>
          <p className="example" dir="rtl">اعمل كابشن وزوم على "النهارده"</p>
          <p className="muted">Every edit appears here as a step you can undo, compare before/after, or (in Step mode) accept or reject before the agent continues.</p>
        </div>
      ) : (
        <ol className="steps" ref={list}>
          {steps.map(s => <StepCard key={s.id} step={s} reviewing={s.id === reviewId} onJump={onJump} onPeek={onPeek} onHover={onHover} onError={onError} />)}
        </ol>
      )}

      <div className="composer">
        {notes.length > 0 && <div className="queued">{notes.length} message{notes.length > 1 ? 's' : ''} waiting for the agent's next step</div>}
        <textarea id="agent-note" value={msg} onChange={e => setMsg(e.target.value)} dir="auto" rows={2}
          placeholder="Message the agent mid-edit, e.g. خلّي الكابشن أصفر"
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button onClick={send} disabled={!msg.trim()}>Send</button>
      </div>
    </aside>
  );
});

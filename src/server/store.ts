import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyChanges, clone, conflicts, diff } from '../shared/diff.js';
import { clipEnd, fmtTime } from '../shared/timeline.js';
import type { Change, Control, MediaAssets, Project, RenderState, ServerState, Step } from '../shared/types.js';

export const DATA_DIR = path.resolve(process.env.LIVECUT_DATA ?? 'data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const EXPORT_DIR = path.join(DATA_DIR, 'exports');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const WAIT_MS = Number(process.env.LIVECUT_WAIT_MS ?? 240_000);

for (const d of [DATA_DIR, MEDIA_DIR, EXPORT_DIR]) fs.mkdirSync(d, { recursive: true });

export const newId = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

export function emptyProject(): Project {
  return { name: 'Untitled', width: 1080, height: 1920, fps: 30, media: [], clips: [], texts: [], effects: [], transcripts: [], markers: [] };
}

/** Thrown when the agent has to stop and hand control to the user. */
export class Hold extends Error {}

type Listener = (s: ServerState) => void;
type Decision = { approve: boolean; note?: string };

export interface StepResult { summary: string; at?: number; detail?: string }

class Store {
  project: Project = emptyProject();
  steps: Step[] = [];
  control: Control = { mode: 'live', paused: false };
  render: RenderState = { status: 'idle', progress: 0 };
  notes: string[] = [];
  assets: Record<string, MediaAssets> = {};
  lastAgentSeen = 0;

  private listeners = new Set<Listener>();
  private waiters = new Set<() => void>();
  private review: { stepId: string; resolve: (d: Decision) => void } | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor() {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      this.project = { ...emptyProject(), ...s.project };
      this.steps = (s.steps ?? []).map((x: Step) => (x.status === 'review' || x.status === 'running' ? { ...x, status: 'done' } : x));
      this.control = { mode: s.control?.mode ?? 'live', paused: false };
      this.assets = s.assets ?? {};
    } catch { /* first run */ }
  }

  /** What the browser needs. Transcripts are left out: they can be large and the editor never reads them. */
  snapshot(): ServerState {
    const slim = (c: Change) => (c.coll === 'transcripts' ? { coll: c.coll, id: c.id } : c);
    return {
      project: { ...this.project, transcripts: this.project.transcripts.map(t => ({ mediaId: t.mediaId, language: t.language, words: [] })) },
      assets: this.assets,
      steps: this.steps.map(st => (st.changes.some(c => c.coll === 'transcripts') ? { ...st, changes: st.changes.map(slim) } : st)),
      control: this.control, render: this.render,
      notes: this.notes, agentConnected: Date.now() - this.lastAgentSeen < 90_000,
    };
  }

  setAssets(mediaId: string, a: MediaAssets) { this.assets[mediaId] = { ...this.assets[mediaId], ...a }; this.changed(); }

  subscribe(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  changed() {
    const s = this.snapshot();
    for (const fn of this.listeners) fn(s);
    for (const w of this.waiters) w();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ project: this.project, steps: this.steps, control: this.control, assets: this.assets }));
      fs.renameSync(tmp, STATE_FILE);
    }, 300);
  }

  private waitUntil(ready: () => boolean, ms = WAIT_MS): Promise<boolean> {
    if (ready()) return Promise.resolve(true);
    return new Promise(resolve => {
      const check = () => { if (ready()) { done(); resolve(true); } };
      const timer = setTimeout(() => { done(); resolve(false); }, ms);
      const done = () => { clearTimeout(timer); this.waiters.delete(check); };
      this.waiters.add(check);
    });
  }

  /** Waits while the user has paused the agent or a step is still under review. */
  async waitForTurn(ms = WAIT_MS): Promise<void> {
    const ok = await this.waitUntil(() => !this.control.paused && !this.review, ms);
    if (!ok) {
      throw new Hold(this.review
        ? 'The user is still reviewing the previous step. Call wait_for_user, then continue.'
        : 'The user paused editing to take a look. Call wait_for_user, then continue.');
    }
  }

  drainNotes(): string {
    if (!this.notes.length) return '';
    const text = this.notes.map(n => `- ${n}`).join('\n');
    this.notes = [];
    this.changed();
    return `\n\nMessages from the user (address these before continuing):\n${text}`;
  }

  /**
   * Every edit goes through here: it runs on a draft, is recorded as a step with
   * an entity diff (so it can be undone or compared before/after), is shown live,
   * and in step mode waits for the user to accept or reject it.
   */
  async edit(tool: string, args: Record<string, unknown>, fn: (draft: Project) => StepResult, by: Step['by'] = 'agent'): Promise<string> {
    if (by === 'agent') await this.waitForTurn();
    const draft = clone(this.project);
    const res = fn(draft);
    const changes = diff(this.project, draft);
    if (by === 'agent') {
      const locked = lockedBy(this.project, changes);
      if (locked) throw new Error(`The user locked ${fmtTime(locked.start)}–${fmtTime(locked.end)} ("${locked.text}"), and this edit would change it. Leave that range alone or limit the edit to other times.`);
    }
    this.project = draft;

    // Rapid edits by the user to the same item (dragging, sliders) merge into one step.
    const prev = this.steps[this.steps.length - 1];
    const ids = (cs: Change[]) => cs.map(c => c.coll + '/' + c.id).sort().join();
    if (by === 'user' && prev && prev.by === 'user' && prev.tool === tool && !prev.undone && prev.status === 'done'
        && Date.now() - prev.time < 4000 && ids(prev.changes) === ids(changes) && changes.length) {
      prev.changes = prev.changes.map(c => ({ ...c, after: changes.find(x => x.coll === c.coll && x.id === c.id)!.after }));
      prev.summary = res.summary; prev.at = res.at; prev.time = Date.now(); prev.args = args;
      this.changed();
      return res.summary;
    }

    const step: Step = {
      id: newId('step'), n: this.steps.length + 1, tool, args, summary: res.summary,
      status: by === 'agent' && this.control.mode === 'step' ? 'review' : 'done',
      undone: false, changes, at: res.at, by, time: Date.now(),
    };
    this.steps.push(step);
    if (by === 'user' && changes.length) this.notes.push(`The user edited the video by hand (${tool}): ${res.summary}.${tool === 'add_note' ? ' This is an instruction for you at that time range.' : ''}`);
    this.changed();
    if (by === 'user') return res.summary;

    let text = res.summary + (res.detail ? `\n${res.detail}` : '');
    if (step.status === 'review') {
      const decision = await new Promise<Decision | null>(resolve => {
        this.review = { stepId: step.id, resolve };
        setTimeout(() => resolve(null), WAIT_MS);
      });
      this.review = null;
      if (!decision) {
        step.status = 'done';
        text += '\n\n(The user did not review this step in time; it was kept.)';
      } else if (decision.approve) {
        step.status = 'done';
        step.feedback = decision.note;
        if (decision.note) text += `\n\nThe user accepted this step and said: ${decision.note}`;
      } else {
        this.project = applyChanges(this.project, changes, 'revert');
        step.status = 'rejected';
        step.feedback = decision.note;
        text = `The user REJECTED this step (${res.summary}), so it was reverted.` + (decision.note ? ` Their feedback: ${decision.note}` : ' Ask what they want instead, or try a different approach.');
      }
      this.changed();
    }
    return text + this.drainNotes();
  }

  decide(stepId: string, d: Decision) {
    if (!this.review || this.review.stepId !== stepId) throw new Error('That step is not waiting for review.');
    this.review.resolve(d);
  }

  toggleUndo(stepId: string) {
    const step = this.steps.find(s => s.id === stepId);
    if (!step) throw new Error('Unknown step');
    if (step.status === 'rejected' || step.status === 'review') throw new Error('This step cannot be undone right now.');
    const dir = step.undone ? 'apply' : 'revert';
    const bad = conflicts(this.project, step.changes, dir);
    if (bad.length) throw new Error(`A later step changed the same items (${bad.join(', ')}). Undo that step first.`);
    this.project = applyChanges(this.project, step.changes, dir);
    step.undone = !step.undone;
    this.notes.push(`The user ${step.undone ? 'undid' : 'redid'} step ${step.n} (${step.tool}: ${step.summary}).`);
    this.changed();
  }

  setControl(c: Partial<Control>) {
    this.control = { ...this.control, ...c };
    if (c.mode === 'live' && this.review) this.review.resolve({ approve: true });
    this.changed();
  }

  addNote(text: string) { this.notes.push(text); this.changed(); }

  setRender(r: Partial<RenderState>) { this.render = { ...this.render, ...r }; this.changed(); }

  reset() {
    if (this.review) this.review.resolve({ approve: false, note: 'The user reset the project.' });
    this.project = emptyProject(); this.steps = []; this.notes = []; this.assets = {}; this.render = { status: 'idle', progress: 0 };
    for (const f of fs.readdirSync(MEDIA_DIR)) fs.rmSync(path.join(MEDIA_DIR, f), { force: true });
    this.changed();
  }
}

/** The first open "don't touch" note that a change overlaps, if any. */
function lockedBy(p: Project, changes: Change[]) {
  const locks = p.markers.filter(m => m.kind === 'dont' && m.status === 'open');
  if (!locks.length) return undefined;
  const span = (coll: string, e: any): [number, number] | undefined =>
    !e ? undefined : coll === 'clips' ? [e.start, clipEnd(e)] : coll === 'texts' || coll === 'effects' ? [e.start, e.end] : undefined;
  for (const c of changes) {
    if (c.coll === 'markers') {
      const m = c.before ?? c.after;
      if (m?.kind === 'dont' && (!c.after || c.after.kind !== 'dont' || c.after.start !== m.start || c.after.end !== m.end)) return m;
      continue;
    }
    for (const r of [span(c.coll, c.before), span(c.coll, c.after)]) {
      if (!r) continue;
      const hit = locks.find(m => r[0] < m.end - 1e-6 && r[1] > m.start + 1e-6);
      if (hit) return hit;
    }
  }
  return undefined;
}

export const store = new Store();

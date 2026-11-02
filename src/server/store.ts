import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyChanges, clone, conflicts, diff } from '../shared/diff.js';
import { clipEnd, DUCK_GAP, fmtTime, speechRegions, srcAt } from '../shared/timeline.js';
import type { Change, Control, MediaAssets, Project, Question, RenderState, ServerState, Step } from '../shared/types.js';

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

/** What an edit did, for tools that return structured results. */
export interface EditOutcome {
  text: string;
  summary: string;
  step?: number;
  status: 'applied' | 'rejected' | 'dry-run';
  created: { kind: string; id: string }[];
  changed: { kind: string; id: string }[];
  removed: { kind: string; id: string }[];
  blockedBy?: string;
}

const KIND: Record<string, string> = { clips: 'clip', texts: 'text', effects: 'effect', markers: 'note', media: 'media', transcripts: 'transcript' };
function outcomeLists(changes: Change[]) {
  const pick = (f: (c: Change) => boolean) => changes.filter(f).map(c => ({ kind: KIND[c.coll] ?? c.coll, id: c.id }));
  return { created: pick(c => !c.before && !!c.after), changed: pick(c => !!c.before && !!c.after), removed: pick(c => !!c.before && !c.after) };
}

class Store {
  project: Project = emptyProject();
  steps: Step[] = [];
  control: Control = { mode: 'live', paused: false };
  render: RenderState = { status: 'idle', progress: 0 };
  notes: string[] = [];
  assets: Record<string, MediaAssets> = {};
  questions: (Question & { resolve: (answer: string | null) => void })[] = [];
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
      questions: this.questions.map(({ resolve: _r, ...q }) => q),
      speech: this.speechCache(),
      steps: this.steps.map(st => (st.changes.some(c => c.coll === 'transcripts') ? { ...st, changes: st.changes.map(slim) } : st)),
      control: this.control, render: this.render,
      notes: this.notes, agentConnected: Date.now() - this.lastAgentSeen < 90_000,
    };
  }

  private speechMemo: { project: Project | null; regions: [number, number][] } = { project: null, regions: [] };
  speechCache(): [number, number][] {
    if (this.speechMemo.project !== this.project) this.speechMemo = { project: this.project, regions: this.project.audio?.duck ? speechRegions(this.project, DUCK_GAP) : [] };
    return this.speechMemo.regions;
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
    return (await this.editDetailed(tool, args, fn, by)).text;
  }

  /**
   * Every edit goes through here: it runs on a draft, is recorded as a step with
   * an entity diff (so it can be undone or compared before/after), is shown live,
   * and in step mode waits for the user to accept or reject it. With dryRun the
   * draft is only inspected: nothing changes and no step is recorded.
   */
  async editDetailed(tool: string, args: Record<string, unknown>, fn: (draft: Project) => StepResult, by: Step['by'] = 'agent', opts: { dryRun?: boolean } = {}): Promise<EditOutcome> {
    if (by === 'agent' && !opts.dryRun) await this.waitForTurn();
    const draft = clone(this.project);
    const res = fn(draft);
    const changes = diff(this.project, draft);
    const lists = outcomeLists(changes);
    const locked = by === 'agent' ? lockedBy(this.project, draft, changes) : undefined;
    const lockMsg = locked && `The user locked ${fmtTime(locked.start)}–${fmtTime(locked.end)} ("${locked.text}"), and this edit would change it. Leave that range alone or limit the edit to other times.`;
    if (opts.dryRun) {
      const text = `Dry run, nothing changed: ${res.summary}. Would create ${lists.created.length}, change ${lists.changed.length}, remove ${lists.removed.length} item(s).` + (lockMsg ? `\nIt would be REFUSED: ${lockMsg}` : '');
      return { text, summary: res.summary, status: 'dry-run', ...lists, blockedBy: lockMsg };
    }
    if (lockMsg) throw new Error(lockMsg);
    this.project = draft;

    // Rapid edits by the user to the same item (dragging, sliders) merge into one step.
    const prev = this.steps[this.steps.length - 1];
    const ids = (cs: Change[]) => cs.map(c => c.coll + '/' + c.id).sort().join();
    if (by === 'user' && prev && prev.by === 'user' && prev.tool === tool && !prev.undone && prev.status === 'done'
        && Date.now() - prev.time < 4000 && ids(prev.changes) === ids(changes) && changes.length) {
      prev.changes = prev.changes.map(c => ({ ...c, after: changes.find(x => x.coll === c.coll && x.id === c.id)!.after }));
      prev.summary = res.summary; prev.at = res.at; prev.time = Date.now(); prev.args = args;
      this.changed();
      return { text: res.summary, summary: res.summary, step: prev.n, status: 'applied', ...lists };
    }

    const step: Step = {
      id: newId('step'), n: this.steps.length + 1, tool, args, summary: res.summary,
      status: by === 'agent' && this.control.mode === 'step' ? 'review' : 'done',
      undone: false, changes, at: res.at, by, time: Date.now(),
    };
    this.steps.push(step);
    if (by === 'user' && changes.length) this.notes.push(`The user edited the video by hand (${tool}): ${res.summary}.${tool === 'add_note' ? ' This is an instruction for you at that time range.' : ''}`);
    this.changed();
    if (by === 'user') return { text: res.summary, summary: res.summary, step: step.n, status: 'applied', ...lists };

    let text = res.summary + (res.detail ? `\n${res.detail}` : '');
    let status: EditOutcome['status'] = 'applied';
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
        status = 'rejected';
        text = `The user REJECTED this step (${res.summary}), so it was reverted.` + (decision.note ? ` Their feedback: ${decision.note}` : ' Ask what they want instead, or try a different approach.');
      }
      this.changed();
    }
    return { text: text + this.drainNotes(), summary: res.summary, step: step.n, status, ...lists };
  }

  /** Asks the user in the editor; resolves with their answer, or null if they do not answer in time. */
  ask(text: string, options?: string[], at?: number, ms = WAIT_MS): Promise<string | null> {
    return new Promise(resolve => {
      const id = newId('q');
      const done = (answer: string | null) => {
        clearTimeout(timer);
        this.questions = this.questions.filter(q => q.id !== id);
        this.changed();
        resolve(answer);
      };
      const timer = setTimeout(() => done(null), ms);
      this.questions.push({ id, text, options, at, time: Date.now(), resolve: done });
      this.changed();
    });
  }

  answer(id: string, answer: string) {
    const q = this.questions.find(x => x.id === id);
    if (!q) throw new Error('That question was already answered or expired.');
    q.resolve(answer);
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
    this.project = emptyProject(); this.steps = []; this.notes = []; this.assets = {};
    for (const q of [...this.questions]) q.resolve(null); this.render = { status: 'idle', progress: 0 };
    for (const f of fs.readdirSync(MEDIA_DIR)) fs.rmSync(path.join(MEDIA_DIR, f), { force: true });
    this.changed();
  }
}

/**
 * What plays inside [s, e]: clip pieces with their source position and level,
 * merged where a clip was merely split. Two projects with the same fragments
 * look and sound the same in that range.
 */
function fragments(p: Project, s: number, e: number): string {
  const r = (x: number) => Math.round(x * 1000) / 1000;
  const parts = p.clips.filter(c => c.start < e && clipEnd(c) > s).map(c => {
    const a = Math.max(s, c.start), b = Math.min(e, clipEnd(c));
    const fadeIn = c.fadeIn && c.start + c.fadeIn > s ? c.fadeIn : 0;
    const fadeOut = c.fadeOut && clipEnd(c) - c.fadeOut < e ? c.fadeOut : 0;
    return { track: c.track, media: c.mediaId, a, b, src: srcAt(c, a), vol: c.volume, fadeIn, fadeOut, speed: c.speed ?? 1, dip: [c.videoFadeIn ?? 0, c.videoFadeOut ?? 0] };
  }).sort((x, y) => (x.track + x.a).localeCompare(y.track + y.a) || x.a - y.a);
  const merged: typeof parts = [];
  for (const f of parts) {
    const m = merged[merged.length - 1];
    if (m && m.track === f.track && m.media === f.media && m.speed === f.speed && Math.abs(m.b - f.a) < 1e-3 && Math.abs(m.src + (m.b - m.a) * m.speed - f.src) < 1e-3 && !m.dip[1] && !f.dip[0]
        && m.vol === f.vol && !m.fadeOut && !f.fadeIn) { m.b = f.b; m.fadeOut = f.fadeOut; continue; }
    merged.push({ ...f });
  }
  return JSON.stringify(merged.map(f => [f.track, f.media, r(f.a - s), r(f.b - s), r(f.src), f.vol, r(f.fadeIn), r(f.fadeOut), f.speed, f.dip]));
}

/** The first open "don't touch" note that a change would alter, if any. */
function lockedBy(before: Project, after: Project, changes: Change[]) {
  const locks = before.markers.filter(m => m.kind === 'dont' && m.status === 'open');
  if (!locks.length) return undefined;
  const span = (coll: string, e: any): [number, number] | undefined => (!e ? undefined : coll === 'texts' || coll === 'effects' ? [e.start, e.end] : undefined);
  const clipsChanged = changes.some(c => c.coll === 'clips' || c.coll === 'media');
  for (const c of changes) {
    if (c.coll !== 'markers') continue;
    const m = c.before ?? c.after;
    // Moving a lock together with its content is fine; removing it or changing its length is not.
    if (m?.kind === 'dont' && (!c.after || c.after.kind !== 'dont' || c.after.text !== m.text || Math.abs((c.after.end - c.after.start) - (m.end - m.start)) > 1e-3)) return m;
  }
  for (const m of locks) {
    // The lock may have moved with its content (e.g. a pause cut earlier in the video).
    const moved = after.markers.find(x => x.id === m.id) ?? m;
    if (clipsChanged && fragments(before, m.start, m.end) !== fragments(after, moved.start, moved.end)) return m;
    for (const c of changes) {
      const shiftedOnly = c.before && c.after && Math.abs((c.after.start - c.before.start) - (moved.start - m.start)) < 1e-3
        && Math.abs((c.after.end - c.before.end) - (moved.end - m.end)) < 1e-3 && JSON.stringify({ ...c.before, start: 0, end: 0, words: undefined }) === JSON.stringify({ ...c.after, start: 0, end: 0, words: undefined });
      if (shiftedOnly) continue;
      for (const r of [span(c.coll, c.before), span(c.coll, c.after)]) {
        if (r && r[0] < m.end - 1e-6 && r[1] > m.start + 1e-6) return m;
      }
    }
  }
  return undefined;
}

export const store = new Store();

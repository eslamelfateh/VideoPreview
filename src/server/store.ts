import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { applyChanges, clone, conflicts, diff } from '../shared/diff.js';
import { clipEnd, DUCK_GAP, duration, fmtTime, speechRegions, srcAt } from '../shared/timeline.js';
import type { Change, Control, MediaAssets, Project, ProjectInfo, Question, RenderState, ServerState, Step, VersionInfo } from '../shared/types.js';

export const DATA_DIR = path.resolve(process.env.LIVECUT_DATA ?? 'data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const EXPORT_DIR = path.join(DATA_DIR, 'exports');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
const projectFile = (id: string) => path.join(PROJECTS_DIR, `${id.replace(/[^\w-]/g, '')}.json`);

/** What is saved per project. */
interface ProjectFile { project: Project; steps: Step[]; versions: { id: string; name: string; time: number; project: Project }[]; reviewToken?: string; notes?: string[]; updated: number }
function readProjectFile(id: string): ProjectFile | null {
  try { return JSON.parse(fs.readFileSync(projectFile(id), 'utf8')); } catch { return null; }
}
function writeJson(file: string, v: unknown) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v));
  fs.renameSync(tmp, file);
}
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
  versions: { id: string; name: string; time: number; project: Project }[] = [];
  projectId = '';
  reviewToken: string | undefined;
  lastAgentSeen = 0;

  private listeners = new Set<Listener>();
  private waiters = new Set<() => void>();
  private review: { stepId: string; resolve: (d: Decision) => void } | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor() {
    let s: any = {};
    try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* first run */ }
    this.control = { mode: s.control?.mode ?? 'live', paused: false };
    this.assets = s.assets ?? {};
    if (s.project) {
      // Older data kept one project inside state.json: move it into its own file.
      const id = newId('proj');
      writeJson(projectFile(id), { project: s.project, steps: s.steps ?? [], versions: s.versions ?? [], updated: Date.now() } satisfies ProjectFile);
      s.current = id;
    }
    const current = s.current && readProjectFile(s.current) ? s.current : this.listProjects()[0]?.id;
    if (current) this.load(current);
    else { this.projectId = newId('proj'); this.flush(); }
  }

  private load(id: string) {
    const f = readProjectFile(id);
    if (!f) throw new Error('Project not found.');
    this.projectId = id;
    this.project = { ...emptyProject(), ...f.project };
    this.steps = (f.steps ?? []).map((x: Step) => (x.status === 'review' || x.status === 'running' ? { ...x, status: 'done' } : x));
    this.versions = f.versions ?? [];
    this.reviewToken = f.reviewToken;
    this.notes = f.notes ?? [];
  }

  /** Writes the current project and the server state now. */
  flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    writeJson(projectFile(this.projectId), { project: this.project, steps: this.steps, versions: this.versions, reviewToken: this.reviewToken, notes: this.notes, updated: Date.now() } satisfies ProjectFile);
    writeJson(STATE_FILE, { current: this.projectId, control: this.control, assets: this.assets });
  }

  listProjects(): ProjectInfo[] {
    return fs.readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json')).map(f => {
      const id = f.slice(0, -5);
      const st = fs.statSync(path.join(PROJECTS_DIR, f));
      let name = 'Untitled';
      if (id === this.projectId) name = this.project.name;
      else { const pf = readProjectFile(id); if (pf) name = pf.project?.name ?? name; }
      return { id, name, updated: st.mtimeMs, current: id === this.projectId };
    }).sort((a, b) => b.updated - a.updated);
  }

  private beforeSwitch() {
    if (this.render.status === 'rendering') throw new Error('Wait for the export to finish before switching projects.');
    if (this.review) this.review.resolve({ approve: true, note: 'The user switched to another project.' });
    for (const q of [...this.questions]) q.resolve(null);
    this.flush();
  }

  createProject(name?: string): ProjectInfo {
    this.beforeSwitch();
    this.projectId = newId('proj');
    this.project = { ...emptyProject(), name: (name ?? '').trim().slice(0, 80) || 'Untitled' };
    this.steps = []; this.versions = []; this.notes = []; this.reviewToken = undefined;
    this.render = { status: 'idle', progress: 0 };
    this.flush(); this.changed();
    return this.listProjects().find(p => p.id === this.projectId)!;
  }

  openProject(id: string) {
    if (id === this.projectId) return;
    if (!readProjectFile(id)) throw new Error(`No project ${id}.`);
    this.beforeSwitch();
    this.load(id);
    this.render = { status: 'idle', progress: 0 };
    this.flush(); this.changed();
  }

  renameProject(name: string) {
    this.project = { ...this.project, name: name.trim().slice(0, 80) || 'Untitled' };
    this.changed();
  }

  /** Deletes a project that is not open, and media files no other project uses. */
  deleteProject(id: string) {
    if (id === this.projectId) throw new Error('Open another project before deleting this one.');
    const f = readProjectFile(id);
    if (!f) throw new Error(`No project ${id}.`);
    fs.rmSync(projectFile(id), { force: true });
    this.removeUnusedMedia(f.project.media.map(m => m.id));
    this.changed();
  }

  /** Media ids used by any project (and its saved versions). */
  private mediaInUse(): Set<string> {
    const used = new Set<string>();
    const add = (p: Project) => p.media.forEach(m => used.add(m.id));
    add(this.project); this.versions.forEach(v => add(v.project));
    for (const pi of this.listProjects()) {
      if (pi.id === this.projectId) continue;
      const f = readProjectFile(pi.id);
      if (f) { add(f.project); (f.versions ?? []).forEach(v => add(v.project)); }
    }
    return used;
  }

  private removeUnusedMedia(candidates: string[]) {
    const used = this.mediaInUse();
    for (const id of candidates) {
      if (used.has(id)) continue;
      for (const f of fs.readdirSync(MEDIA_DIR)) if (f.startsWith(id + '.') || f.startsWith(id)) fs.rmSync(path.join(MEDIA_DIR, f), { force: true });
      delete this.assets[id];
    }
  }

  /* ---------- review links ---------- */

  ensureReviewToken(): string {
    if (!this.reviewToken) { this.reviewToken = randomBytes(18).toString('base64url'); this.changed(); }
    return this.reviewToken;
  }
  revokeReviewToken() { this.reviewToken = undefined; this.changed(); }

  /** The project a review link points to: the open one, or a saved one read from disk. */
  reviewTarget(token: string): { id: string; project: Project; open: boolean } | null {
    if (!token) return null;
    if (this.reviewToken && token === this.reviewToken) return { id: this.projectId, project: this.project, open: true };
    for (const pi of this.listProjects()) {
      if (pi.id === this.projectId) continue;
      const f = readProjectFile(pi.id);
      if (f?.reviewToken === token) return { id: pi.id, project: { ...emptyProject(), ...f.project }, open: false };
    }
    return null;
  }

  /** A note left on a review link; goes to the open project live, or into the saved file. */
  async reviewNote(token: string, note: { start: number; end: number; text: string; kind: 'do' | 'dont' }, add: (d: Project) => StepResult) {
    const t = this.reviewTarget(token);
    if (!t) throw new Error('This review link is no longer valid.');
    if (t.open) {
      const summary = await this.edit('add_note', { ...note, by: 'reviewer' }, add, 'user');
      this.notes[this.notes.length - 1] = `A reviewer left a note on the review link: ${summary}. Treat it like a request from the user.`;
      this.changed();
      return summary;
    }
    const f = readProjectFile(t.id)!;
    const draft = clone({ ...emptyProject(), ...f.project });
    const res = add(draft);
    f.project = draft;
    f.notes = [...(f.notes ?? []), `A reviewer left a note: ${res.summary}.`];
    f.updated = Date.now();
    writeJson(projectFile(t.id), f);
    return res.summary;
  }

  /** What the browser needs. Transcripts are left out: they can be large and the editor never reads them. */
  snapshot(): ServerState {
    const slim = (c: Change) => (c.coll === 'transcripts' ? { coll: c.coll, id: c.id } : c);
    return {
      projectId: this.projectId, projects: this.listProjects(), reviewToken: this.reviewToken,
      project: { ...this.project, transcripts: this.project.transcripts.map(t => ({ mediaId: t.mediaId, language: t.language, words: [] })) },
      assets: this.assets,
      questions: this.questions.map(({ resolve: _r, ...q }) => q),
      versions: this.versionList(),
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
    this.saveTimer = setTimeout(() => this.flush(), 300);
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

  versionList(): VersionInfo[] {
    return this.versions.map(v => ({ id: v.id, name: v.name, time: v.time, duration: duration(v.project), clips: v.project.clips.length, texts: v.project.texts.length, effects: v.project.effects.length }));
  }

  /** Saves the current project under a name (replacing a version with the same name). */
  saveVersion(name: string): VersionInfo {
    const n = name.trim().slice(0, 60) || `Version ${this.versions.length + 1}`;
    const existing = this.versions.find(v => v.name === n);
    const v = { id: existing?.id ?? newId('ver'), name: n, time: Date.now(), project: clone(this.project) };
    this.versions = this.versions.filter(x => x.id !== v.id).concat(v);
    this.changed();
    return this.versionList().find(x => x.id === v.id)!;
  }

  findVersion(idOrName: string) {
    const v = this.versions.find(x => x.id === idOrName || x.name === idOrName);
    if (!v) throw new Error(`No version "${idOrName}". Saved: ${this.versions.map(x => x.name).join(', ') || 'none'}.`);
    return v;
  }

  deleteVersion(id: string) { this.findVersion(id); this.versions = this.versions.filter(v => v.id !== id); this.changed(); }

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

  /** Empties the open project (keeps its name and review link); media no other project uses is deleted. */
  reset() {
    if (this.review) this.review.resolve({ approve: false, note: 'The user reset the project.' });
    const media = [...this.project.media.map(m => m.id), ...this.versions.flatMap(v => v.project.media.map(m => m.id))];
    this.project = { ...emptyProject(), name: this.project.name }; this.steps = []; this.notes = []; this.versions = [];
    for (const q of [...this.questions]) q.resolve(null); this.render = { status: 'idle', progress: 0 };
    this.removeUnusedMedia(media);
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

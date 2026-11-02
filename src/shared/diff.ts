import { COLLECTIONS, type Change, type Project } from './types.js';

const key = (v: unknown) => JSON.stringify(v);
const SETTINGS = ['name', 'width', 'height', 'fps', 'audio'] as const;
const settingsOf = (p: Project) => Object.fromEntries(SETTINGS.map(k => [k, (p as any)[k]]));

/** Entity-level diff between two project versions. */
export function diff(a: Project, b: Project): Change[] {
  const out: Change[] = [];
  for (const coll of COLLECTIONS) {
    const idOf = (e: any) => (coll === 'transcripts' ? e.mediaId : e.id);
    const before = new Map((a[coll] as any[]).map(e => [idOf(e), e]));
    const after = new Map((b[coll] as any[]).map(e => [idOf(e), e]));
    for (const [id, e] of before) {
      const n = after.get(id);
      if (!n) out.push({ coll, id, before: e });
      else if (key(n) !== key(e)) out.push({ coll, id, before: e, after: n });
    }
    for (const [id, e] of after) if (!before.has(id)) out.push({ coll, id, after: e });
  }
  const sa = settingsOf(a), sb = settingsOf(b);
  if (key(sa) !== key(sb)) out.push({ coll: 'settings', id: 'project', before: sa, after: sb });
  return out;
}

function setEntity(p: Project, coll: Change['coll'], id: string, value: any) {
  if (coll === 'settings') { for (const k of SETTINGS) (p as any)[k] = value?.[k]; return; }
  const list = p[coll] as any[];
  const idOf = (e: any) => (coll === 'transcripts' ? e.mediaId : e.id);
  const i = list.findIndex(e => idOf(e) === id);
  if (value === undefined) { if (i >= 0) list.splice(i, 1); }
  else if (i >= 0) list[i] = value;
  else list.push(value);
}

function getEntity(p: Project, coll: Change['coll'], id: string) {
  if (coll === 'settings') return settingsOf(p);
  const idOf = (e: any) => (coll === 'transcripts' ? e.mediaId : e.id);
  return (p[coll] as any[]).find(e => idOf(e) === id);
}

export function clone<T>(v: T): T { return structuredClone(v); }

/** Returns the project with a step's changes reverted (or re-applied). Does not mutate the input. */
export function applyChanges(p: Project, changes: Change[], direction: 'revert' | 'apply'): Project {
  const next = clone(p);
  for (const c of changes) setEntity(next, c.coll, c.id, direction === 'revert' ? c.before : c.after);
  return next;
}

/**
 * A step can be undone only if nothing later changed the same entities,
 * otherwise undo would silently drop the later edit.
 */
export function conflicts(p: Project, changes: Change[], direction: 'revert' | 'apply'): string[] {
  const out: string[] = [];
  for (const c of changes) {
    const expected = direction === 'revert' ? c.after : c.before;
    if (key(getEntity(p, c.coll, c.id)) !== key(expected)) out.push(`${c.coll}/${c.id}`);
  }
  return out;
}

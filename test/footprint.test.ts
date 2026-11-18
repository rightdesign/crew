import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planFootprints, mustYieldTo, footprintOf, isIgnoredPath, declarations, pushes, pushedMetadata, footprintWaitNote,
  footprintDigestSection, footprintVerdictText, describeFiles, type Declaration, type PushInfo,
} from '../src/footprint.ts';
import { planSweep, sweepComment, blockerInfoMap } from '../src/blocked.ts';
import type { Ticket } from '../src/tracker.ts';

const T = (n: number, status: string, o: Partial<Ticket> = {}): Ticket =>
  ({ id: `id${n}`, issue_id: `ISSUE-${n}`, issue_tag: `CREW-${n}`, status, repo_id: 'r1', updated_at: '2026-11-15T00:00:00Z', ...o }) as Ticket;
const decl = (d: Record<number, string[]>, at = '2026-11-15T10:00:00Z'): Map<string, Declaration> =>
  new Map(Object.entries(d).map(([n, paths]) => [`id${n}`, { paths, at }]));
const push = (p: Record<number, string[] | undefined>): Map<string, PushInfo> =>
  new Map(Object.entries(p).map(([n, paths]) => [`id${n}`, { at: '2026-11-15T11:00:00Z', ...(paths ? { paths } : {}) }]));
const plan = (tickets: Ticket[], d: Record<number, string[]>, p: Record<number, string[] | undefined> = {}, extra: Partial<Parameters<typeof planFootprints>[0]> = {}) =>
  planFootprints({ tickets, declared: decl(d), pushed: push(p), ...extra });

test('three accepted tickets on one file: the first is built, the others wait naming ticket and file', () => {
  const ts = [T(1, 'in_progress'), T(2, 'accepted'), T(3, 'accepted')];
  const p = plan(ts, { 1: ['src/a.ts'], 2: ['src/a.ts'], 3: ['src/a.ts'] });
  assert.equal(p.waits.has('id1'), false);
  assert.deepEqual(p.waits.get('id2')?.waitingFor, ['CREW-1']);
  assert.deepEqual(p.waits.get('id2')?.files, ['src/a.ts']);
  assert.match(footprintWaitNote(p.waits.get('id2')!), /CREW-1.*`src\/a\.ts`/);
  assert.ok(p.waits.has('id3'));
});

test('when the first is released the oldest waiter starts and the next waits on it', () => {
  const p = plan([T(2, 'blocked'), T(3, 'blocked')], { 2: ['src/a.ts'], 3: ['src/a.ts'] });
  assert.equal(p.waits.has('id2'), false);
  assert.deepEqual(p.waits.get('id3')?.waitingFor, ['CREW-2']);
});

test('a ticket sharing no file with active work starts immediately', () => {
  const p = plan([T(1, 'in_progress'), T(2, 'accepted')], { 1: ['src/a.ts'], 2: ['src/b.ts'] });
  assert.equal(p.waits.size, 0);
});

test('only actively worked tickets hold files: needs_info, blocked, accepted-before-start do not', () => {
  const ts = [T(1, 'needs_info'), T(2, 'blocked'), T(3, 'accepted')];
  assert.equal(plan(ts, { 1: ['x'], 3: ['x'] }).waits.has('id3'), false);
  for (const status of ['in_progress', 'fixed', 'qa']) {
    assert.ok(plan([T(1, status), T(3, 'accepted')], { 3: ['x'] }, { 1: ['x'] }, { }).waits.has('id3'), status);
  }
  assert.ok(plan([T(1, 'verified'), T(3, 'accepted')], { 3: ['x'] }, { 1: ['x'] }).waits.has('id3'));
  assert.equal(plan([T(1, 'verified', { merged_at: '2026-11-15' }), T(3, 'accepted')], { 3: ['x'] }, { 1: ['x'] }).waits.has('id3'), false);
});

test('when the ticket waited for moves to needs_info the waiter is no longer in the answer', () => {
  const before = plan([T(1, 'in_progress'), T(2, 'blocked')], { 1: ['x'], 2: ['x'] });
  const after = plan([T(1, 'needs_info'), T(2, 'blocked')], { 1: ['x'], 2: ['x'] });
  assert.ok(before.waits.has('id2'));
  assert.equal(after.waits.has('id2'), false);
});

test('a ticket in flight whose push grows into another active footprint keeps running', () => {
  const ts = [T(1, 'in_progress'), T(2, 'in_progress')];
  const p = plan(ts, { 1: ['a'], 2: ['b'] }, { 2: ['b', 'a'] });
  assert.equal(p.waits.size, 0);
  assert.deepEqual(footprintOf(ts[1]!, decl({ 2: ['b'] }), push({ 2: ['a'] })).sort(), ['a', 'b']);
});

test('from fixed on only the pushed paths count', () => {
  const t = T(1, 'fixed');
  assert.deepEqual(footprintOf(t, decl({ 1: ['guess.ts'] }), push({ 1: ['real.ts'] })), ['real.ts']);
  assert.ok(plan([t, T(2, 'accepted')], { 1: ['guess.ts'], 2: ['guess.ts'] }, { 1: ['real.ts'] }).waits.size === 0);
  assert.ok(plan([t, T(2, 'accepted')], { 2: ['real.ts'] }, { 1: ['real.ts'] }).waits.has('id2'));
});

test('changelog, version files and lockfiles never cause a wait', () => {
  const ignore = new Map([['r1', new Set(['CHANGELOG.md', 'package.json'])]]);
  const shared = ['CHANGELOG.md', 'package.json', 'pnpm-lock.yaml', 'apps/x/package-lock.json', 'Cargo.lock'];
  assert.equal(plan([T(1, 'in_progress'), T(2, 'accepted')], { 1: shared, 2: shared }, {}, { ignoreByRepo: ignore }).waits.size, 0);
  assert.ok(isIgnoredPath('deep/dir/yarn.lock'));
  assert.equal(isIgnoredPath('src/lock.ts'), false);
});

test('overlap is an exact path: no globs, no directories', () => {
  assert.equal(plan([T(1, 'in_progress'), T(2, 'accepted')], { 1: ['src/'], 2: ['src/a.ts'] }).waits.size, 0);
  assert.equal(plan([T(1, 'in_progress'), T(2, 'accepted')], { 1: ['src/*.ts'], 2: ['src/a.ts'] }).waits.size, 0);
});

test('a ticket with no declaration, or an empty one, or in another repo, runs', () => {
  assert.equal(plan([T(1, 'in_progress'), T(2, 'accepted')], { 1: ['a'] }).waits.size, 0);
  assert.equal(plan([T(1, 'in_progress'), T(2, 'accepted')], { 1: ['a'], 2: [] }).waits.size, 0);
  assert.equal(plan([T(1, 'in_progress'), T(2, 'accepted', { repo_id: 'r2' })], { 1: ['a'], 2: ['a'] }).waits.size, 0);
});

test('a ticket parked by a dependency takes no place in line', () => {
  const p = plan([T(2, 'blocked'), T(3, 'accepted')], { 2: ['a'], 3: ['a'] }, {}, { dependencyBlocked: new Set(['id2']) });
  assert.equal(p.waits.size, 0);
});

test('two ships racing: exactly one of two overlapping new declarations yields, whichever evaluates it', () => {
  const ts = [T(1, 'in_progress'), T(2, 'in_progress')];
  const d = new Map<string, Declaration>([['id1', { paths: ['a'], at: '2026-11-15T10:00:02Z' }], ['id2', { paths: ['a'], at: '2026-11-15T10:00:01Z' }]]);
  const one = mustYieldTo(ts[0]!, { tickets: ts, declared: d, pushed: new Map() });
  const two = mustYieldTo(ts[1]!, { tickets: ts, declared: d, pushed: new Map() });
  assert.deepEqual(one?.waitingFor, ['CREW-2']);
  assert.equal(two, null);
});

test('an exact declaration tie goes to the lower ticket number', () => {
  const ts = [T(5, 'in_progress'), T(4, 'in_progress')];
  const d = new Map<string, Declaration>([['id5', { paths: ['a'], at: 'T' }], ['id4', { paths: ['a'], at: 'T' }]]);
  assert.ok(mustYieldTo(ts[0]!, { tickets: ts, declared: d, pushed: new Map() }));
  assert.equal(mustYieldTo(ts[1]!, { tickets: ts, declared: d, pushed: new Map() }), null);
});

test('an overlapping ticket that already pushed, or is past in_progress, always wins', () => {
  const d = new Map<string, Declaration>([['id1', { paths: ['a'], at: '2026-11-15T10:00:09Z' }], ['id2', { paths: ['a'], at: '2026-11-15T10:00:01Z' }]]);
  const ts = [T(1, 'in_progress'), T(2, 'in_progress')];
  assert.ok(mustYieldTo(ts[0]!, { tickets: ts, declared: d, pushed: push({ 2: ['a'] }) }));
  // Even an earlier declaration yields to a ticket at fixed.
  assert.ok(mustYieldTo(T(2, 'in_progress'), { tickets: [T(2, 'in_progress'), T(1, 'fixed')], declared: d, pushed: push({ 1: ['a'] }) }));
  assert.equal(mustYieldTo(T(1, 'in_progress'), { tickets: [T(1, 'in_progress')], declared: d, pushed: new Map() }), null);
});

test('events: newest declaration and push per ticket; pushed paths cover both sides of a rename', () => {
  const ev = [
    { record_id: 'id1', created_at: '2', metadata: { paths: ['new.ts', 'package-lock.json'] } },
    { record_id: 'id1', created_at: '1', metadata: { paths: ['old.ts'] } },
  ];
  assert.deepEqual(declarations(ev).get('id1')?.paths, ['new.ts']);
  assert.equal(pushes([{ record_id: 'id1', created_at: '1' }]).get('id1')?.paths, undefined);
  assert.deepEqual(pushedMetadata('src/old.ts\nsrc/new.ts\n\nsrc/old.ts')?.paths, ['src/old.ts', 'src/new.ts']);
  assert.equal(pushedMetadata(null), undefined);
});

test('a push from an older crew with no paths leaves the ticket fail-open once past in_progress', () => {
  const p = plan([T(1, 'fixed'), T(2, 'accepted')], { 1: ['a'], 2: ['a'] }, { 1: undefined });
  assert.equal(p.waits.size, 0);
});

test('the park comment names the ticket and the shared files, and restoring needs no area language', () => {
  const ts = [T(1, 'in_progress'), T(2, 'accepted')];
  const p = plan(ts, { 1: ['a', 'b', 'c', 'd', 'e'], 2: ['a', 'b', 'c', 'd', 'e'] });
  const steps = planSweep(ts, blockerInfoMap(ts, []), new Set(p.waits.keys()), undefined, p.waits);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.action, 'park');
  const text = sweepComment(steps[0]!);
  assert.match(text, /waiting for CREW-1/);
  assert.match(text, /and 2 more/);
  const back = planSweep([T(2, 'blocked')], blockerInfoMap([], []), new Set(), undefined, new Map());
  assert.equal(back[0]?.action, 'restore');
});

test('a ticket held by a dependency keeps naming the dependency', () => {
  const ts = [T(1, 'in_progress'), T(2, 'accepted', { blocked_by: ['id9'] })];
  const info = blockerInfoMap(ts, [T(9, 'accepted')]);
  const p = plan(ts, { 1: ['a'], 2: ['a'] });
  const steps = planSweep(ts, info, new Set(['id2']), undefined, p.waits);
  assert.equal(steps[0]!.footprint, undefined);
});

test('a blocker closed at an app-mapped resolved status does not hide the files note (CREW-3646)', () => {
  const ts = [T(1, 'in_progress'), T(2, 'accepted', { blocked_by: ['id9'] })];
  const info = blockerInfoMap(ts, [T(9, 'closed_obsolete')]);
  const p = plan(ts, { 1: ['a'], 2: ['a'] });
  const unmapped = planSweep(ts, info, new Set(['id2']), undefined, p.waits);
  assert.equal(unmapped[0]!.footprint, undefined); // default set: still a dependency
  const mapped = planSweep(ts, info, new Set(['id2']), undefined, p.waits, new Set(['closed_deployed', 'closed_obsolete']));
  assert.deepEqual(mapped[0]!.footprint?.waitingFor, ['CREW-1']);
});

test('the digest shows what is recorded so a resumed run does not declare again; status lists waits', () => {
  assert.match(footprintDigestSection([{ ticket: 'CREW-7', paths: ['a.ts'] }]), /CREW-7: `a\.ts`/);
  assert.match(footprintDigestSection([]), /none recorded yet/);
  assert.match(footprintVerdictText('CREW-2', { waitingFor: ['CREW-1'], files: ['a'] }), /^YIELD CREW-2/);
  assert.match(footprintVerdictText('CREW-2', null), /^PROCEED/);
  assert.equal(describeFiles(['a', 'b'], 3), '`a`, `b`');
});

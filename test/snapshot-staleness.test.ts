import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ResolvedIds } from '../src/config.ts';
import { compareSnapshot, isStale, liveReleaseSeat, snapshotAge, staleSnapshotMessage } from '../src/snapshot-staleness.ts';
import { planFix } from '../src/doctor-fix.ts';
import { routePeriscopeProblems } from '../src/periscopes.ts';

const base = (o: Partial<ResolvedIds> = {}): ResolvedIds => ({
  workspaceId: 'w', models: { issues: 'i', comments: 'c', crew: 'cr' }, seats: {}, holds: [], ...o,
} as ResolvedIds);

test('a table the workspace gained is reported as new', () => {
  const d = compareSnapshot(base({ shipsModelId: 's' }), { models: [{ id: 's', name: 'Ships' }, { id: 'p', name: 'Periscopes' }] });
  assert.deepEqual(d.added, ['Periscopes']);
  assert.deepEqual(d.removed, []);
  assert.ok(isStale(d));
  assert.match(staleSnapshotMessage('w/p', d)!, /Periscopes.*crew connect w\/p.*crew reload/);
});

test('a table the workspace lost is reported as removed', () => {
  const d = compareSnapshot(base({ periscopesModelId: 'p' }), { models: [] });
  assert.deepEqual(d.removed, ['Periscopes']);
  assert.ok(isStale(d));
});

test('an unchanged snapshot is not stale and says nothing', () => {
  const d = compareSnapshot(base({ shipsModelId: 's', releaseSeat: 'r' }), { models: [{ id: 's', name: 'ships' }], releaseSeat: 'r', shipRowHasMachineId: true });
  assert.equal(isStale(d), false);
  assert.equal(staleSnapshotMessage('w/p', d), undefined);
});

test('a new release seat and a Ships row without machine_id are part of the finding', () => {
  const d = compareSnapshot(base(), { models: [], releaseSeat: 'r', shipRowHasMachineId: false });
  assert.ok(d.releaseSeatNew && d.shipRowLacksMachineId);
  assert.match(staleSnapshotMessage('w/p', d)!, /Release seat.*machine_id/);
});

test("liveReleaseSeat finds this ship's Release row only", () => {
  const rows = [{ id: 'a', name: 'Release agent', ship_id: 'other' }, { id: 'b', name: 'Release agent', ship_id: { id: 'mine' } }];
  assert.equal(liveReleaseSeat(rows, 'mine'), 'b');
  assert.equal(liveReleaseSeat(rows, undefined), undefined);
});

test('snapshotAge', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  assert.equal(snapshotAge('2026-11-09T12:00:00Z', now), '3 days');
  assert.equal(snapshotAge('2026-11-12T10:00:00Z', now), '2 hours');
  assert.match(snapshotAge(undefined, now), /unknown/);
});

test('planFix offers a refresh for a stale route without a tracker, ahead of enabling', () => {
  const p = planFix({ host: 'macos', schedulerAbsent: false, routes: [{ route: 'a/b', enabled: false, hasRepos: true, problems: [], snapshotStale: true }] });
  assert.deepEqual(p.actions, [{ kind: 'refresh-snapshot', route: 'a/b' }, { kind: 'enable', route: 'a/b' }]);
  const fresh = planFix({ host: 'macos', schedulerAbsent: false, routes: [{ route: 'a/b', enabled: true, hasRepos: true, problems: [] }] });
  assert.deepEqual(fresh.actions, []);
});

test('periscopes blocker: suppressed when stale, kept (with who-can-fix) when confirmed absent, silent offline', () => {
  const o = { route: 'a/b', hosts: true, repos: [] };
  assert.deepEqual(routePeriscopeProblems({ ...o, tablePresent: false, snapshotStale: true }), []);
  const hard = routePeriscopeProblems({ ...o, tablePresent: false });
  assert.equal(hard[0]?.severity, 'blocker');
  assert.match(hard[0]!.message, /workspace admin/);
  assert.deepEqual(routePeriscopeProblems({ ...o, tablePresent: undefined }), []);
});

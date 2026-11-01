import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoTargetFor, resolvedPathFor, type Route } from '../src/config.ts';
import {
  applyRepoRows, refreshUnknownRepos, resetRepoRefreshCooldown, trackUnservable, UNSERVABLE_PASSES_BEFORE_ATTENTION,
} from '../src/repo-refresh.ts';

function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-refresh-'));
  const resolved = { workspaceId: 'w', reposModelId: 'repos', repoNames: { a: 'alpha' }, models: {}, seats: {} };
  const route = {
    route: 'ws/proj', repos: {}, dirIsCloneBase: true, dir: stateDir, reposBasePath: join(stateDir, 'repos'), resolved,
  } as unknown as Route; // a partial Route: only the fields the map logic reads
  const file = resolvedPathFor(stateDir, route.route);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...resolved, keep: 'me' }));
  return { stateDir, route, file };
}

test('an unknown repo id is learned from the tracker and written to the resolved file', async () => {
  resetRepoRefreshCooldown();
  const { stateDir, route, file } = fixture();
  assert.equal(repoTargetFor(route, 'b'), null);
  const added = await refreshUnknownRepos({
    route, stateDir, tickets: [{ repo_id: 'b' }],
    fetchRows: async () => [{ id: 'a', name: 'alpha' }, { id: 'b', name: 'beta', remote: 'o/beta' }],
  });
  assert.deepEqual(added, ['b']);
  assert.equal(repoTargetFor(route, 'b')?.name, 'beta');
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.repoNames.b, 'beta');
  assert.equal(onDisk.repoRemotes.b, 'o/beta');
  assert.equal(onDisk.keep, 'me');
});

test('known ids cost no fetch; a still-unknown id is not refetched inside the cooldown', async () => {
  resetRepoRefreshCooldown();
  const { stateDir, route } = fixture();
  let calls = 0;
  const fetchRows = async () => { calls++; return [{ id: 'a', name: 'alpha' }]; };
  await refreshUnknownRepos({ route, stateDir, tickets: [{ repo_id: 'a' }], fetchRows });
  assert.equal(calls, 0);
  await refreshUnknownRepos({ route, stateDir, tickets: [{ repo_id: 'zzz' }], fetchRows, now: 1_000 });
  await refreshUnknownRepos({ route, stateDir, tickets: [{ repo_id: 'zzz' }], fetchRows, now: 2_000 });
  assert.equal(calls, 1);
  assert.equal(repoTargetFor(route, 'zzz'), null);
});

test('a failed fetch leaves the map as it was', async () => {
  resetRepoRefreshCooldown();
  const { stateDir, route } = fixture();
  const added = await refreshUnknownRepos({ route, stateDir, tickets: [{ repo_id: 'b' }], fetchRows: async () => { throw new Error('down'); } });
  assert.deepEqual(added, []);
  assert.deepEqual(route.resolved?.repoNames, { a: 'alpha' });
});

test('applyRepoRows drops a remote the row no longer has', () => {
  const r: Parameters<typeof applyRepoRows>[0] = {
    ...(fixture().route.resolved!), repoNames: { a: 'alpha' }, repoRemotes: { a: 'o/a' },
  };
  applyRepoRows(r, [{ id: 'a', name: 'alpha', remote: null }]);
  assert.equal(r.repoRemotes, undefined);
});

test('a ticket becomes attention only after consecutive unservable passes, and recovers', () => {
  const streaks = new Map<string, number>();
  let out = { raise: [] as string[], recovered: [] as string[] };
  for (let i = 1; i < UNSERVABLE_PASSES_BEFORE_ATTENTION; i++) {
    out = trackUnservable(streaks, ['X-1']);
    assert.deepEqual(out.raise, []);
  }
  out = trackUnservable(streaks, ['X-1']);
  assert.deepEqual(out.raise, ['X-1']);
  out = trackUnservable(streaks, []);
  assert.deepEqual(out.recovered, ['X-1']);
});

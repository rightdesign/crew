import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  upsert, clear, transitions, staleRelease, openShipAttention, hookCommand,
  raiseShipAttention, clearShipAttention, baseAttention, baseUnsafeKey, RELEASE_STALE_AFTER_INTERVALS, type ShipAttentionItem,
} from '../src/ship-attention.ts';
import { Emitter, eventFileFor } from '../src/events.ts';
import { State } from '../src/state.ts';
import { INTERVAL_SECONDS } from '../src/install.ts';
import { readFileSync } from 'node:fs';

const item = (key: string, over: Partial<ShipAttentionItem> = {}): ShipAttentionItem => ({
  kind: 'role_parked', key, message: `m:${key}`, since: '2026-10-05T00:00:00.000Z', ...over,
});

test('upsert adds a new key and keeps the original `since` when the same key is raised again', () => {
  const a = upsert([], item('role_parked:qa'));
  assert.equal(a.length, 1);
  const b = upsert(a, item('role_parked:qa', { message: 'newer', since: '2026-10-06T00:00:00.000Z' }));
  assert.equal(b.length, 1);
  assert.equal(b[0]!.message, 'newer');
  assert.equal(b[0]!.since, '2026-10-05T00:00:00.000Z');
});

test('clear drops only the named key', () => {
  const items = [item('role_parked:qa'), item('role_parked:dev')];
  assert.deepEqual(clear(items, 'role_parked:qa').map((i) => i.key), ['role_parked:dev']);
  assert.equal(clear(items, 'nope').length, 2);
});

test('transitions: present now and absent before only; a cleared-then-returned item transitions again', () => {
  const prev = [item('a')];
  assert.deepEqual(transitions(prev, [item('a'), item('b')]).map((i) => i.key), ['b']);
  assert.deepEqual(transitions(prev, [item('a')]), []);
  assert.deepEqual(transitions([], [item('a')]).map((i) => i.key), ['a']);
});

test('staleRelease: never run is not stale; stale only past 3 intervals (fake clock)', () => {
  const now = 10_000_000;
  const limit = RELEASE_STALE_AFTER_INTERVALS * INTERVAL_SECONDS * 1000;
  assert.equal(staleRelease(null, now), null);
  assert.equal(staleRelease(now - limit, now), null, 'exactly at the limit is still fine');
  const s = staleRelease(now - limit - 60_000, now);
  assert.equal(s?.kind, 'release_stale');
  assert.equal(s?.key, 'release_stale');
  assert.match(s!.message, /has not run a release cycle/);
});

test('openShipAttention merges persisted items with a derived release_stale, which clears on the next heartbeat', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-shipatt-'));
  const state = new State(dir);
  state.shipAttention().persist([item('role_parked:qa')]);
  assert.deepEqual(openShipAttention(state).map((i) => i.key), ['role_parked:qa']);

  state.releaseHeartbeat().touch();
  const old = new Date(Date.now() - 3600_000);
  utimesSync(join(dir, '.release-last-run'), old, old);
  assert.deepEqual(openShipAttention(state).map((i) => i.key), ['role_parked:qa', 'release_stale']);

  state.releaseHeartbeat().touch();
  assert.deepEqual(openShipAttention(state).map((i) => i.key), ['role_parked:qa']);
});

test('raise announces once as a sweep event with attention ship:<kind> and no ticket; clear is silent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-shipatt-'));
  const state = new State(dir);
  const emit = new Emitter({ route: 'r', eventFile: eventFileFor(dir), console: () => {} });
  assert.equal(await raiseShipAttention({ state, emit }, item('role_parked:qa')), true);
  assert.equal(await raiseShipAttention({ state, emit }, item('role_parked:qa')), false);
  clearShipAttention(state, 'role_parked:qa');
  assert.deepEqual(state.shipAttention().previous(), []);
  const events = readFileSync(eventFileFor(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.length, 1);
  assert.equal(events[0].step, 'sweep');
  assert.equal(events[0].level, 'warn');
  assert.deepEqual(events[0].data.attention, ['ship:role_parked']);
  assert.equal(events[0].ticket, undefined);
  assert.equal(events[0].data.url, undefined);
});

test('hookCommand: first plain command word, skipping comments and assignments', () => {
  assert.equal(hookCommand('pnpm install --frozen-lockfile'), 'pnpm');
  assert.equal(hookCommand('# c\n\nFOO=1\nnpx tsc --noEmit'), 'npx');
  assert.equal(hookCommand('if true; then x; fi'), null);
  assert.equal(hookCommand('./scripts/go.sh'), null);
  assert.equal(hookCommand(''), null);
});

test('baseAttention (CREW-1388): an unsafe base raises a per-repo item naming the auto-resume; level or fast-forwarded clears it; the rest say nothing', () => {
  const diverged = { action: 'diverged', ahead: 1, behind: 2, detail: 'main has diverged' } as const;
  const r = baseAttention('crew', diverged, 'origin', 'main', '2026-10-06T00:00:00.000Z');
  assert.ok(r && 'raise' in r);
  assert.equal(r.raise.kind, 'base_unsafe');
  assert.equal(r.raise.key, baseUnsafeKey('crew'));
  assert.match(r.raise.message, /Resumes automatically once it is level with origin\/main/);
  assert.notEqual(baseUnsafeKey('crew'), baseUnsafeKey('tablation'));

  for (const action of ['level', 'fast-forwarded'] as const) {
    const c = baseAttention('crew', { action, behind: 0, detail: 'ok' } as never, 'origin', 'main');
    assert.deepEqual(c, { clear: 'base_unsafe:crew' });
  }
  for (const o of [
    { action: 'not-applicable', detail: 'x' }, { action: 'fetch-failed', detail: 'x' },
    { action: 'would-fast-forward', behind: 1, detail: 'x' },
  ] as const) assert.equal(baseAttention('crew', o, 'origin', 'main'), null);
});

test('base_unsafe survives a persist/clear round trip like any other ship-attention item', () => {
  const state = new State(mkdtempSync(join(tmpdir(), 'crew-shipatt-')));
  state.shipAttention().persist([item(baseUnsafeKey('crew'), { kind: 'base_unsafe' })]);
  assert.deepEqual(openShipAttention(state).map((i) => i.kind), ['base_unsafe']);
  clearShipAttention(state, baseUnsafeKey('crew'));
  assert.deepEqual(openShipAttention(state), []);
});

test('repoStopFor names the stopped repo for its tickets only (CREW-1403)', async () => {
  const { repoStopFor } = await import('../src/ship-attention.ts');
  const route = { route: 'w/p', dir: '/w/crew', repos: { crew: {}, other: {} }, resolved: { repoNames: { r1: 'crew', r2: 'other' } } } as any;
  const stop = repoStopFor([item(baseUnsafeKey('crew'), { kind: 'base_unsafe', message: 'diverged' })], route);
  assert.equal(stop({ repo_id: 'r1' }), 'diverged');
  assert.equal(stop({ repo_id: 'r2' }), null);
  assert.equal(repoStopFor([item('role_parked:qa')], route)({ repo_id: 'r1' }), null);
});

test('diskAttention raises below the threshold and clears at or above it (ISSUE-1406)', async () => {
  const { diskAttention, diskLowKey, LOW_DISK_BYTES } = await import('../src/ship-attention.ts');
  const low = diskAttention('crew', 100, LOW_DISK_BYTES);
  assert.ok('raise' in low);
  assert.equal(low.raise.kind, 'disk_low');
  assert.equal(low.raise.key, diskLowKey('crew'));
  assert.match(low.raise.message, /Resumes automatically/);
  assert.deepEqual(diskAttention('crew', LOW_DISK_BYTES, LOW_DISK_BYTES), { clear: 'disk_low:crew' });
});

test('checkRepoDisks raises per repo, clears once there is room, and skips an unreadable dir', async () => {
  const { checkRepoDisks } = await import('../src/ship-attention.ts');
  const dir = mkdtempSync(join(tmpdir(), 'crew-shipatt-'));
  const state = new State(dir);
  const emit = new Emitter({ route: 'r', eventFile: eventFileFor(dir), console: () => {} });
  const route = { route: 'w/p', dir: '/w/a', repos: { a: '/w/a', b: '/w/b', c: '/w/c' } } as any;
  const free: Record<string, number | null> = { '/w/a': 10, '/w/b': 1e12, '/w/c': null };
  await checkRepoDisks({ state, emit, route }, (d) => free[d]!, 1000);
  assert.deepEqual(openShipAttention(state).map((i) => i.key), ['disk_low:a']);
  free['/w/a'] = 1e12;
  await checkRepoDisks({ state, emit, route }, (d) => free[d]!, 1000);
  assert.deepEqual(openShipAttention(state), []);
});

test('repoStopFor also stops on a missing setup tool and low disk, but not a missing test/build/deploy tool', async () => {
  const { repoStopFor, diskLowKey } = await import('../src/ship-attention.ts');
  const route = { route: 'w/p', dir: '/w/crew', repos: { crew: {}, other: {} }, resolved: { repoNames: { r1: 'crew', r2: 'other' } } } as any;
  const stop = repoStopFor([
    item('hook_missing:w/p/crew/setup', { kind: 'hook_missing', message: 'no pnpm' }),
    item('hook_missing:w/p/other/test', { kind: 'hook_missing', message: 'no jest' }),
  ], route);
  assert.equal(stop({ repo_id: 'r1' }), 'no pnpm');
  assert.equal(stop({ repo_id: 'r2' }), null);
  const disk = repoStopFor([item(diskLowKey('other'), { kind: 'disk_low', message: 'full' })], route);
  assert.equal(disk({ repo_id: 'r2' }), 'full');
  assert.equal(repoStopFor([item('hook_missing:other/p/crew/setup', { kind: 'hook_missing' })], route)({ repo_id: 'r1' }), null);
});

test('recheckEnvironmentStops clears a hook_missing whose command now resolves and a docker_missing that is fixed', async () => {
  const { recheckEnvironmentStops } = await import('../src/ship-attention.ts');
  const { writeFileSync } = await import('node:fs');
  const repo = mkdtempSync(join(tmpdir(), 'crew-shipatt-repo-'));
  writeFileSync(join(repo, '.crew.yaml'), 'version: 1\nhooks:\n  setup: pnpm install\n  test: jest\n  deploy: ship-it\n');
  const state = new State(mkdtempSync(join(tmpdir(), 'crew-shipatt-')));
  state.shipAttention().persist([
    item('hook_missing:w/p/crew/setup', { kind: 'hook_missing' }),
    item('hook_missing:w/p/crew/test', { kind: 'hook_missing' }),
    item('hook_missing:w/p/gone/test', { kind: 'hook_missing' }),
    item('hook_missing:x/y/crew/setup', { kind: 'hook_missing' }),
    item('docker_missing', { kind: 'docker_missing' }),
    item('role_parked:qa'),
  ]);
  const route = { route: 'w/p', dir: repo, repos: { crew: repo } } as any;
  const ship = { extraPath: [] } as any;
  // pnpm is findable, jest is not; docker is still broken.
  let cleared = recheckEnvironmentStops(state, route, ship, {
    onPath: (bin) => (bin === 'pnpm' ? '/bin/pnpm' : undefined), dockerProblem: () => 'nope',
  });
  assert.deepEqual(cleared, ['crew/setup']);
  assert.deepEqual(openShipAttention(state).map((i) => i.key).sort(),
    ['docker_missing', 'hook_missing:w/p/crew/test', 'hook_missing:w/p/gone/test', 'hook_missing:x/y/crew/setup', 'role_parked:qa']);
  cleared = recheckEnvironmentStops(state, route, ship, { onPath: () => '/bin/jest', dockerProblem: () => undefined });
  assert.deepEqual(cleared.sort(), ['crew/test', 'docker']);
  assert.deepEqual(openShipAttention(state).map((i) => i.key).sort(),
    ['hook_missing:w/p/gone/test', 'hook_missing:x/y/crew/setup', 'role_parked:qa']);
});

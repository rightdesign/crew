import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  upsert, clear, transitions, staleRelease, openShipAttention, hookCommand,
  raiseShipAttention, clearShipAttention, RELEASE_STALE_AFTER_INTERVALS, type ShipAttentionItem,
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

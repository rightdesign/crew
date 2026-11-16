import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TablationApiError } from '@tablation/client';
import type { Route } from '../src/config.ts';
import {
  probeSeats, reconcileSeatAttention, mergeSeatAttention, seatMissingProblems, seatMissingKey, missingRoles, type SeatProbe,
} from '../src/seat-missing.ts';
import { attentionProblems } from '../src/doctor-problems.ts';
import type { ShipAttentionItem } from '../src/ship-attention.ts';

const route = {
  route: 'issues/crew',
  resolved: { seats: { dev: 'crew-dev', qa: 'crew-qa', pair: 'crew-pair' } },
} as unknown as Route;
const slug = 'issues-crew';

const reader = (answers: Record<string, 'ok' | 404 | 403 | 'net'>) => async (id: string) => {
  const a = answers[id] ?? 'ok';
  if (a === 'ok') return { id };
  if (a === 'net') throw new TypeError('fetch failed');
  throw new TablationApiError('nope', a, null);
};

test('only a definite 404 is missing; other failures are unknown', async () => {
  const probes = await probeSeats(route, reader({ 'crew-dev': 404, 'crew-qa': 403, 'crew-pair': 'net' }));
  assert.deepEqual(probes.map((p) => [p.role, p.state]), [['dev', 'missing'], ['qa', 'unknown'], ['pair', 'unknown']]);
  assert.deepEqual(missingRoles(probes), ['dev']);
});

test('raises one item for a missing seat, ignores unknown, and clears once it resolves', async () => {
  const open = new Map<string, ShipAttentionItem>();
  const io = { raise: async (i: ShipAttentionItem) => { open.set(i.key, i); }, clear: (k: string) => { open.delete(k); } };
  await reconcileSeatAttention(route, await probeSeats(route, reader({ 'crew-dev': 404, 'crew-qa': 403 })), io);
  assert.deepEqual([...open.keys()], [seatMissingKey(slug, 'dev')]);
  const item = open.get(seatMissingKey(slug, 'dev'))!;
  assert.equal(item.kind, 'seat_missing');
  assert.match(item.message, /dev seat/);
  assert.match(item.message, /crew connect/);
  // a read that cannot decide neither raises nor clears
  await reconcileSeatAttention(route, await probeSeats(route, reader({ 'crew-dev': 'net' })), io);
  assert.equal(open.size, 1);
  // after `crew connect` the seat reads again: gone with no manual dismissal
  await reconcileSeatAttention(route, await probeSeats(route, reader({})), io);
  assert.equal(open.size, 0);
});

test('status merge: live probe adds, clears and keeps `since`', async () => {
  const stored = [{ kind: 'seat_missing', key: seatMissingKey(slug, 'dev'), message: 'm', since: '2026-01-01T00:00:00Z' }] as ShipAttentionItem[];
  const missing = await probeSeats(route, reader({ 'crew-dev': 404 }));
  const kept = mergeSeatAttention(stored, route, missing);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.since, '2026-01-01T00:00:00Z');
  assert.equal(mergeSeatAttention([], route, missing).length, 1);
  assert.equal(mergeSeatAttention(stored, route, await probeSeats(route, reader({}))).length, 0);
  assert.equal(mergeSeatAttention(stored, route, await probeSeats(route, reader({ 'crew-dev': 'net' }))).length, 1);
});

test('doctor: a blocker per missing seat with the remedy; the attention item is not duplicated', async () => {
  const probes: SeatProbe[] = await probeSeats(route, reader({ 'crew-dev': 404, 'crew-qa': 404 }));
  const problems = seatMissingProblems(route, probes);
  assert.equal(problems.length, 2);
  assert.ok(problems.every((p) => p.severity === 'blocker' && p.kind === 'seat_missing' && /crew connect/.test(p.remedy ?? '')));
  const items = mergeSeatAttention([], route, probes);
  assert.deepEqual(attentionProblems(items, problems), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import {
  planStalled, applyStalled, stalledKey, STALLED_AFTER_MS, STALLED_MARKER, type StalledWriter,
} from '../src/stalled.ts';
import type { Ticket, Comment, ShipRow } from '../src/tracker.ts';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const OLD = STALLED_AFTER_MS + 60_000;
const silent = { emit: () => {}, warn: () => {} };

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 't1', issue_id: 'CREW-1', status: 'in_progress', updated_at: at(OLD), held_by_ship_id: 'ship-A', ...over,
});
const comment = (over: Partial<Comment> = {}): Comment => ({ id: 'c1', ticket_id: 't1', body: 'x', created_at: at(OLD), ...over });
const ships = (over: Partial<ShipRow> = {}): ShipRow[] => [{ id: 'ship-A', name: 'Studio', ...over }];

test('a silent in_progress ticket past the limit is stalled, not yet announced', () => {
  const [s] = planStalled([ticket()], [comment()], ships(), DEFAULT_CONTRACT, new Set(), NOW);
  assert.equal(s?.holderShipId, 'ship-A');
  assert.equal(s?.announced, false);
});

test('fixed and qa are watched, accepted and needs_info are not', () => {
  const ts = ['fixed', 'qa', 'accepted', 'needs_info'].map((status, i) => ticket({ id: `t${i}`, status }));
  const out = planStalled(ts, [], ships(), DEFAULT_CONTRACT, new Set(), NOW);
  assert.deepEqual(out.map((s) => s.ticket.status), ['fixed', 'qa']);
});

test('recent activity (a comment or the row itself) keeps a ticket out', () => {
  assert.equal(planStalled([ticket()], [comment({ created_at: at(1000) })], ships(), DEFAULT_CONTRACT, new Set(), NOW).length, 0);
  assert.equal(planStalled([ticket({ updated_at: at(1000) })], [], ships(), DEFAULT_CONTRACT, new Set(), NOW).length, 0);
});

test('a ship engaged on the ticket, and a ticket assigned to a hold, are never stalled', () => {
  assert.equal(planStalled([ticket()], [], ships({ engaged: true, engaged_ticket_id: 't1' }), DEFAULT_CONTRACT, new Set(), NOW).length, 0);
  assert.equal(planStalled([ticket({ assignee_id: 'brad' })], [], ships(), DEFAULT_CONTRACT, new Set(['brad']), NOW).length, 0);
});

test('a stalled event newer than the last activity marks it announced; new activity re-arms it', () => {
  const marker = comment({ id: 'c2', body: `${STALLED_MARKER} stalled`, created_at: at(OLD - 120_000) });
  const [s] = planStalled([ticket()], [comment(), marker], ships(), DEFAULT_CONTRACT, new Set(), NOW);
  assert.equal(s?.announced, true);
  const older = comment({ id: 'c0', body: `${STALLED_MARKER} earlier stall`, created_at: at(OLD * 2) });
  const later = comment({ id: 'c3', created_at: at(OLD) });
  const [again] = planStalled([ticket()], [older, later], ships(), DEFAULT_CONTRACT, new Set(), NOW);
  assert.equal(again?.announced, false);
});

function writer() {
  const patches: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  // A PATCH is not part of the writer's interface any more; the extra method records one if anything calls it.
  const w: StalledWriter & { updateTicket: (id: string, p: Record<string, unknown>) => Promise<unknown> } = {
    updateTicket: async (_id, p) => { patches.push(p); return {}; },
    postEvent: async (_id, body) => { notes.push(body); },
  };
  return { w, patches, notes };
}

test('a held stall posts one event, leaves the ticket alone, and raises attention only on the holder', async () => {
  const { w, patches, notes } = writer();
  const stalled = planStalled([ticket()], [], ships(), DEFAULT_CONTRACT, new Set(), NOW);
  const mine = await applyStalled(w, stalled, ships(), 'seat', 'ship-A', silent, false, NOW);
  assert.equal(patches.length, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /Studio/);
  assert.deepEqual(mine.attention.map((i) => i.key), [stalledKey('CREW-1')]);
  const other = await applyStalled(w, stalled, ships(), 'seat', 'ship-B', silent, false, NOW);
  assert.equal(other.attention.length, 0);
});

test('an unheld stall at any watched status is commented on and never PATCHed', async () => {
  for (const status of ['in_progress', 'fixed', 'qa']) {
    const { w, patches, notes } = writer();
    const stalled = planStalled([ticket({ status, held_by_ship_id: null })], [], ships(), DEFAULT_CONTRACT, new Set(), NOW);
    assert.equal(stalled.length, 1);
    const r = await applyStalled(w, stalled, ships(), 'seat', 'ship-A', silent, false, NOW);
    assert.deepEqual(patches, [], status);
    assert.equal(notes.length, 1, status);
    assert.equal(r.attention.length, 0, status);
  }
});

test('an announced stall writes nothing again, and a dry run writes nothing at all', async () => {
  const { w, patches, notes } = writer();
  const marker = comment({ id: 'c2', body: STALLED_MARKER, created_at: at(OLD - 120_000) });
  const done = planStalled([ticket({ held_by_ship_id: null })], [marker], ships(), DEFAULT_CONTRACT, new Set(), NOW);
  await applyStalled(w, done, ships(), 'seat', null, silent, false, NOW);
  const fresh = planStalled([ticket({ held_by_ship_id: null })], [], ships(), DEFAULT_CONTRACT, new Set(), NOW);
  await applyStalled(w, fresh, ships(), 'seat', null, silent, true, NOW);
  assert.equal(patches.length + notes.length, 0);
});

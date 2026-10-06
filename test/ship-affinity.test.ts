import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StaleWriteError } from '@tablation/client';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import { applyHoldReleases, heldByLiveOtherShip, heldByOtherShip, holdWarnings, noteReaccepted, noteTakeover, originBranchSha, planHoldReleases, shipIdByName, shipIsAlive, SHIP_DEAD_AFTER_CYCLES } from '../src/ship-affinity.ts';
import { resolveTopCandidate, type ClaimableTracker } from '../src/claim.ts';
import { roleHasWork, rankedCandidates, selectRole, withHoldCheck } from '../src/select.ts';
import type { SelectionInput } from '../src/select.ts';
import type { ShipRow, Ticket } from '../src/tracker.ts';

const NOW = Date.parse('2026-10-06T05:00:00.000Z');
const alive = new Date(NOW - 60_000).toISOString();
const dead = new Date(NOW - (SHIP_DEAD_AFTER_CYCLES * 120 + 60) * 1000).toISOString();
const ships = (aSeen = alive): ShipRow[] => [
  { id: 'ship-A', name: 'Brads-Mac-mini', last_seen: aSeen },
  { id: 'ship-B', name: 'Brads-Mac-Studio', last_seen: alive },
];
const T = (o: Partial<Ticket> & { id: string; issue_id: string; status: string }): Ticket =>
  ({ updated_at: '2026-10-06T00:00:00.000Z', ...o }) as Ticket;

/** The Studio (ship-B) looking at a board whose rows are held by the Mac mini (ship-A). */
const asStudio = (tickets: Ticket[], aSeen = alive): SelectionInput => ({
  tickets, comments: [], watermark: '2026-01-01T00:00:00Z',
  blocked: new Set(), holds: new Set(),
  seats: { dev: 'dev-B', design: 'design-B', qa: 'qa-B' },
  ships: { myShipId: 'ship-B', rows: ships(aSeen), now: NOW },
});

test('shipIsAlive: a recent heartbeat is alive; none, or an old one, is dead', () => {
  assert.equal(shipIsAlive({ id: 'x', last_seen: alive }, NOW), true);
  assert.equal(shipIsAlive({ id: 'x', last_seen: dead }, NOW), false);
  assert.equal(shipIsAlive({ id: 'x' }, NOW), false);
  assert.equal(shipIsAlive(undefined, NOW), false);
});

test('shipIdByName: exact match only; ambiguous or absent is null', () => {
  assert.equal(shipIdByName(ships(), 'Brads-Mac-mini'), 'ship-A');
  assert.equal(shipIdByName(ships(), 'nope'), null);
  assert.equal(shipIdByName([...ships(), { id: 'dup', name: 'Brads-Mac-mini' }], 'Brads-Mac-mini'), null);
});

test('another live ship holds a ticket once claimed (in_progress/needs_info)', () => {
  const a = { myShipId: 'ship-B', ships: ships(), contract: DEFAULT_CONTRACT, now: NOW };
  for (const status of ['in_progress', 'needs_info']) {
    assert.equal(heldByOtherShip(T({ id: 't', issue_id: 'I-1', status, held_by_ship_id: 'ship-A' }), a), true, status);
  }
});

test('not held: own ship, no ship_id, a dead ship, or a ticket waiting at fixed', () => {
  const a = { myShipId: 'ship-B', ships: ships(), contract: DEFAULT_CONTRACT, now: NOW };
  assert.equal(heldByOtherShip(T({ id: 't', issue_id: 'I-1', status: 'in_progress', held_by_ship_id: 'ship-B' }), a), false);
  assert.equal(heldByOtherShip(T({ id: 't', issue_id: 'I-1', status: 'in_progress' }), a), false);
  assert.equal(heldByOtherShip(T({ id: 't', issue_id: 'I-1', status: 'fixed', held_by_ship_id: 'ship-A' }), a), false);
  assert.equal(heldByOtherShip(T({ id: 't', issue_id: 'I-1', status: 'qa', held_by_ship_id: 'ship-B' }), a), false);
  assert.equal(heldByOtherShip(T({ id: 't', issue_id: 'I-1', status: 'in_progress', held_by_ship_id: 'ship-A' }),
    { ...a, ships: ships(dead) }), false);
  assert.equal(heldByOtherShip(T({ id: 't', issue_id: 'I-1', status: 'in_progress', held_by_ship_id: 'ship-A' }),
    { ...a, myShipId: null }), false);
});

test('CREW-1383 replay: a QA bounce (in_progress, no assignee, ship_id kept) does not wake or offer the ticket to the other ship', () => {
  const bounced = T({ id: 't', issue_id: 'CREW-1383', status: 'in_progress', assignee_id: null, held_by_ship_id: 'ship-A' });
  const i = asStudio([bounced]);
  assert.equal(roleHasWork('dev', i).hasWork, false);
  assert.deepEqual(rankedCandidates('dev', i), []);
  assert.equal(selectRole(i).selected, null);
});

test('a ticket merely FILED from another ship (ship_id, no hold) stays claimable by any ship', () => {
  const filed = T({ id: 't', issue_id: 'CREW-1400', status: 'accepted', ship_id: 'ship-A' });
  const i = asStudio([filed]);
  assert.equal(roleHasWork('dev', i).hasWork, true);
  assert.deepEqual(rankedCandidates('dev', i).map((t) => t.id), ['t']);
});

test('CREW-1383 replay: held by ship A, operator sets it back to accepted — ship B neither offers nor claims it', async () => {
  const held = T({ id: 't', issue_id: 'CREW-1383', status: 'accepted', assignee_id: null, held_by_ship_id: 'ship-A' });
  const i = asStudio([held]);
  assert.equal(roleHasWork('dev', i).hasWork, false);
  assert.deepEqual(rankedCandidates('dev', i), []);
  // Even handed the ticket directly, the claim itself refuses it.
  const { tracker, calls } = fakeTracker([held]);
  const affinity = withHoldCheck({ column: 'held_by_ship_id', shipId: 'ship-B' }, i);
  const r = await resolveTopCandidate(tracker, [held], 'dev-B', 'accepted', 'in_progress', undefined, affinity);
  assert.equal(r.ticket, null);
  assert.deepEqual(r.held, ['CREW-1383']);
  assert.equal(calls.length, 0);
});

test('re-accepted while held by THIS ship: the claim is a resume and flags reaccepted', async () => {
  const held = T({ id: 't', issue_id: 'CREW-1383', status: 'accepted', held_by_ship_id: 'ship-A' });
  const { tracker } = fakeTracker([held]);
  const r = await resolveTopCandidate(tracker, [held], 'dev-A', 'accepted', 'in_progress', undefined,
    { column: 'held_by_ship_id', shipId: 'ship-A' });
  assert.equal(r.claimed, true);
  assert.equal(r.reaccepted, true);
  const posted: string[] = [];
  await noteReaccepted({ postEvent: async (_t, body) => { posted.push(body); } }, r, 'dev-A', 'Brads-Mac-mini');
  assert.equal(posted.length, 1);
  assert.match(posted[0]!, /Re-accepted while held by Brads-Mac-mini/);
});

test('the owning ship still resumes its own held ticket, and a dead owner can be taken over', () => {
  const held = T({ id: 't', issue_id: 'CREW-1383', status: 'in_progress', assignee_id: null, held_by_ship_id: 'ship-A' });
  const asMini: SelectionInput = { ...asStudio([held]), seats: { dev: 'dev-A' }, ships: { myShipId: 'ship-A', rows: ships(), now: NOW } };
  assert.equal(roleHasWork('dev', asMini).hasWork, true);
  assert.deepEqual(rankedCandidates('dev', asStudio([held], dead)).map((t) => t.id), ['t']);
});

test('QA on any ship still sees a fixed ticket whichever ship built it', () => {
  const fixed = T({ id: 't', issue_id: 'I-1', status: 'fixed', held_by_ship_id: 'ship-A' });
  assert.equal(roleHasWork('qa', asStudio([fixed])).hasWork, true);
});

test('a held ticket does not wake the other ship on a new comment either', () => {
  const held = T({ id: 't', issue_id: 'I-1', status: 'needs_info', held_by_ship_id: 'ship-A' });
  const i = { ...asStudio([held]), watermark: '2026-10-06T00:00:00Z',
    comments: [{ id: 'c', ticket_id: 't', team_member_id: 'someone', created_at: '2026-10-06T04:00:00Z' }] };
  assert.equal(roleHasWork('dev', i).hasWork, false);
});

test('resumption stamp loses the race to another live ship: the ticket is skipped, never returned to build', async () => {
  const bare = T({ id: 'a', issue_id: 'I-1', status: 'in_progress', assignee_id: 'dev-B' });
  const i = asStudio([bare]);
  const affinity = withHoldCheck({ column: 'held_by_ship_id', shipId: 'ship-B' }, i);
  const calls: string[] = [];
  const tracker: ClaimableTracker = {
    async updateTicket() { calls.push('update'); throw new StaleWriteError({ conflict: true }); },
    // the other ship's stamp landed between our read and our write
    async ticket() { return { ...bare, updated_at: '2026-10-06T00:00:05.000Z', held_by_ship_id: 'ship-A' } as Ticket; },
  };
  const r = await resolveTopCandidate(tracker, [bare], 'dev-B', 'accepted', 'in_progress', undefined, affinity);
  assert.equal(r.ticket, null);
  assert.deepEqual(r.held, ['I-1']);
  assert.equal(calls.length, 1);
});

test('resumption stamp: a lost race with no verdict available is contended, not claimable', async () => {
  const bare = T({ id: 'a', issue_id: 'I-1', status: 'in_progress', assignee_id: 'dev-B' });
  const tracker: ClaimableTracker = { async updateTicket() { throw new StaleWriteError({ conflict: true }); } };
  const r = await resolveTopCandidate(tracker, [bare], 'dev-B', 'accepted', 'in_progress', undefined,
    { column: 'held_by_ship_id', shipId: 'ship-B' });
  assert.equal(r.ticket, null);
  assert.deepEqual(r.contended, ['I-1']);
});

test('resumption stamp: the row moved for an unrelated reason, so one retry against the fresh row stamps it', async () => {
  const bare = T({ id: 'a', issue_id: 'I-1', status: 'in_progress', assignee_id: 'dev-B' });
  let n = 0;
  const tracker: ClaimableTracker = {
    async updateTicket(id, patch, expected) {
      if (n++ === 0) throw new StaleWriteError({ conflict: true });
      assert.equal(expected, '2026-10-06T00:00:09.000Z');
      return { ...bare, ...patch } as Ticket;
    },
    async ticket() { return { ...bare, updated_at: '2026-10-06T00:00:09.000Z' } as Ticket; },
  };
  const r = await resolveTopCandidate(tracker, [bare], 'dev-B', 'accepted', 'in_progress', undefined,
    { column: 'held_by_ship_id', shipId: 'ship-B' });
  assert.equal(r.ticket?.held_by_ship_id, 'ship-B');
});

test('dead holder: the resuming ship re-stamps the hold to itself and gets the ticket', async () => {
  const held = T({ id: 'a', issue_id: 'I-1', status: 'in_progress', held_by_ship_id: 'ship-A' });
  const i = asStudio([held], dead);
  const affinity = withHoldCheck({ column: 'held_by_ship_id', shipId: 'ship-B' }, i);
  const { tracker, calls } = fakeTracker([held]);
  const r = await resolveTopCandidate(tracker, [held], 'dev-B', 'accepted', 'in_progress', undefined, affinity);
  assert.equal(r.ticket?.held_by_ship_id, 'ship-B');
  assert.equal(r.claimed, false);
  assert.deepEqual(calls.map((c) => c.patch), [{ held_by_ship_id: 'ship-B' }]);
});

test('dead holder, lost race: the retry takes it over too instead of skipping it', async () => {
  const held = T({ id: 'a', issue_id: 'I-1', status: 'in_progress', held_by_ship_id: 'ship-A' });
  const i = asStudio([held], dead);
  const affinity = withHoldCheck({ column: 'held_by_ship_id', shipId: 'ship-B' }, i);
  let n = 0;
  const tracker: ClaimableTracker = {
    async updateTicket(id, patch, expected) {
      if (n++ === 0) throw new StaleWriteError({ conflict: true });
      assert.equal(expected, '2026-10-06T00:00:09.000Z');
      return { ...held, ...patch } as Ticket;
    },
    async ticket() { return { ...held, updated_at: '2026-10-06T00:00:09.000Z' } as Ticket; },
  };
  const r = await resolveTopCandidate(tracker, [held], 'dev-B', 'accepted', 'in_progress', undefined, affinity);
  assert.equal(r.ticket?.held_by_ship_id, 'ship-B');
  assert.equal(n, 2);
});

test('hold release: fixed and verified tickets lose their hold in a runner write; in_progress ones keep it', async () => {
  const mk = (id: string, status: string) => T({ id, issue_id: id, status, held_by_ship_id: 'ship-A' });
  const tickets = [mk('f', 'fixed'), mk('v', 'verified'), mk('p', 'in_progress'), mk('q', 'qa'),
    T({ id: 'n', issue_id: 'n', status: 'fixed' })];
  const plan = planHoldReleases(tickets, DEFAULT_CONTRACT);
  assert.deepEqual(plan.map((t) => t.id), ['f', 'v']);
  const writes: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const log = { emit: () => undefined, warn: () => undefined };
  const n = await applyHoldReleases({ async updateTicket(id, patch) { writes.push({ id, patch }); } }, plan, DEFAULT_CONTRACT, log);
  assert.equal(n, 2);
  assert.deepEqual(writes.map((w) => w.patch), [{ held_by_ship_id: null }, { held_by_ship_id: null }]);
});

function fakeTracker(fixtures: Ticket[]) {
  const rows = fixtures.map((t) => ({ ...t }));
  const calls: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const tracker: ClaimableTracker = {
    async updateTicket(id, patch, expected) {
      const row = rows.find((r) => r.id === id)!;
      if (expected !== undefined && expected !== row.updated_at) throw new StaleWriteError({ conflict: true });
      calls.push({ id, patch });
      Object.assign(row, patch);
      row.updated_at = new Date(Date.parse(row.updated_at) + 1).toISOString();
      return { ...row };
    },
  };
  return { tracker, calls };
}

test('claim stamps held_by_ship_id in the same conditional write as status/assignee', async () => {
  const a = T({ id: 'a', issue_id: 'I-1', status: 'accepted' });
  const { tracker, calls } = fakeTracker([a]);
  const r = await resolveTopCandidate(tracker, [a], 'dev-B', 'accepted', 'in_progress', undefined,
    { column: 'held_by_ship_id', shipId: 'ship-B' });
  assert.equal(r.claimed, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.patch, { status: 'in_progress', assignee_id: 'dev-B', held_by_ship_id: 'ship-B' });
  assert.equal(r.ticket?.held_by_ship_id, 'ship-B');
});

test('claim without affinity writes exactly what it always did', async () => {
  const a = T({ id: 'a', issue_id: 'I-1', status: 'accepted' });
  const { tracker, calls } = fakeTracker([a]);
  await resolveTopCandidate(tracker, [a], 'dev-B', 'accepted', 'in_progress');
  assert.deepEqual(calls[0]!.patch, { status: 'in_progress', assignee_id: 'dev-B' });
});

test('resuming an in_progress ticket with no held_by_ship_id stamps it; one that has it is left alone', async () => {
  const bare = T({ id: 'a', issue_id: 'I-1', status: 'in_progress', assignee_id: 'dev-B' });
  const owned = T({ id: 'b', issue_id: 'I-2', status: 'in_progress', assignee_id: 'dev-B', held_by_ship_id: 'ship-B' });
  const affinity = { column: 'held_by_ship_id', shipId: 'ship-B' };
  const s1 = fakeTracker([bare]);
  const r1 = await resolveTopCandidate(s1.tracker, [bare], 'dev-B', 'accepted', 'in_progress', undefined, affinity);
  assert.equal(r1.claimed, false);
  assert.equal(r1.ticket?.held_by_ship_id, 'ship-B');
  assert.deepEqual(s1.calls[0]!.patch, { held_by_ship_id: 'ship-B' });
  const s2 = fakeTracker([owned]);
  await resolveTopCandidate(s2.tracker, [owned], 'dev-B', 'accepted', 'in_progress', undefined, affinity);
  assert.equal(s2.calls.length, 0);
});

// ---- CREW-1389 ----

test('a qa ticket another live ship is verifying is held; a dead verifier\'s is not', () => {
  const a = { myShipId: 'ship-B', ships: ships(), contract: DEFAULT_CONTRACT, now: NOW };
  const qa = T({ id: 't', issue_id: 'I-1', status: 'qa', held_by_ship_id: 'ship-A' });
  assert.equal(heldByOtherShip(qa, a), true);
  assert.equal(heldByOtherShip(qa, { ...a, ships: ships(dead) }), false);
});

test('QA selection skips a qa ticket another live ship holds, but not a fixed one', () => {
  const held = T({ id: 'q', issue_id: 'I-1', status: 'qa', held_by_ship_id: 'ship-A' });
  const fixed = T({ id: 'f', issue_id: 'I-2', status: 'fixed' });
  assert.deepEqual(rankedCandidates('qa', asStudio([held])).map((t) => t.id), []);
  assert.equal(roleHasWork('qa', asStudio([held])).hasWork, false);
  assert.deepEqual(rankedCandidates('qa', asStudio([held, fixed])).map((t) => t.id), ['f']);
  // once the verifier is dead, the Studio's QA may take it over
  assert.deepEqual(rankedCandidates('qa', asStudio([held], dead)).map((t) => t.id), ['q']);
});

test('QA claim: fixed -> qa stamps the seat and this ship in one conditional write; the loser walks on', async () => {
  const calls: Record<string, unknown>[] = [];
  const tracker: ClaimableTracker = {
    async updateTicket(id, patch, expected) {
      calls.push({ id, patch, expected });
      throw new StaleWriteError('stale');
    },
  };
  const f = T({ id: 'f', issue_id: 'I-2', status: 'fixed', updated_at: 'u1' });
  const lost = await resolveTopCandidate(tracker, [f], 'qa-B', 'fixed', 'qa', undefined, { column: 'held_by_ship_id', shipId: 'ship-B' });
  assert.equal(lost.ticket, null);
  assert.deepEqual(lost.contended, ['I-2']);
  assert.deepEqual(calls[0], { id: 'f', patch: { status: 'qa', assignee_id: 'qa-B', held_by_ship_id: 'ship-B' }, expected: 'u1' });
});

test('takeover: claiming a dead ship\'s ticket reports who it came from; our own or an unheld one does not', async () => {
  const tracker: ClaimableTracker = { async updateTicket(id, patch) { return T({ id, issue_id: 'I-3', status: 'in_progress', ...patch } as never); } };
  const aff = { column: 'held_by_ship_id', shipId: 'ship-B' };
  const fromDead = await resolveTopCandidate(tracker, [T({ id: 'x', issue_id: 'I-3', status: 'in_progress', held_by_ship_id: 'ship-A' })], 'dev-B', 'accepted', 'in_progress', undefined, aff);
  assert.equal(fromDead.tookOverFrom, 'ship-A');
  const own = await resolveTopCandidate(tracker, [T({ id: 'x', issue_id: 'I-3', status: 'in_progress', held_by_ship_id: 'ship-B' })], 'dev-B', 'accepted', 'in_progress', undefined, aff);
  assert.equal(own.tookOverFrom, null);
  const fresh = await resolveTopCandidate(tracker, [T({ id: 'x', issue_id: 'I-3', status: 'accepted' })], 'dev-B', 'accepted', 'in_progress', undefined, aff);
  assert.equal(fresh.tookOverFrom, null);
});

test('noteTakeover posts one event naming both ships and the commit; silent when there was no takeover', async () => {
  const posted: string[] = [];
  const tr = { async postEvent(_id: string, body: string) { posted.push(body); } };
  const t = T({ id: 'x', issue_id: 'I-3', status: 'in_progress', issue_tag: 'CREW-3' });
  await noteTakeover(tr, { ticket: t, tookOverFrom: null }, 'dev-B', ships(), 'Brads-Mac-Studio', () => 'abc1234');
  assert.equal(posted.length, 0);
  await noteTakeover(tr, { ticket: t, tookOverFrom: 'ship-A' }, 'dev-B', ships(), 'Brads-Mac-Studio', () => 'abc1234');
  assert.equal(posted.length, 1);
  assert.match(posted[0]!, /Brads-Mac-mini/);
  assert.match(posted[0]!, /Brads-Mac-Studio/);
  assert.match(posted[0]!, /abc1234/);
  assert.doesNotMatch(posted[0]!, /ship-A/);
  await noteTakeover(tr, { ticket: t, tookOverFrom: 'ship-A' }, 'dev-B', ships(), 'Brads-Mac-Studio', () => null);
  assert.match(posted[1]!, /no branch commit/);
});

test('originBranchSha tries the tag branch then issue-N and shortens the sha', () => {
  const seen: string[] = [];
  const rev = (_d: string, ref: string) => { seen.push(ref); return ref === 'origin/issue-3' ? 'abcdef0123456' : null; };
  assert.equal(originBranchSha('/d', { issue_id: 'ISSUE-3', issue_tag: 'CREW-3' }, rev), 'abcdef0');
  assert.deepEqual(seen, ['origin/crew-3', 'origin/issue-3']);
  assert.equal(originBranchSha('/d', { issue_id: 'ISSUE-9' }, () => null), null);
});

test('holdWarnings: unheld or dead-held in_progress/qa tickets are named; fixed, live-held and human-held are not', () => {
  const ts = [
    T({ id: '1', issue_id: 'I-1', status: 'in_progress' }),
    T({ id: '2', issue_id: 'I-2', status: 'qa', held_by_ship_id: 'ship-A' }),
    T({ id: '3', issue_id: 'I-3', status: 'in_progress', held_by_ship_id: 'ship-B' }),
    T({ id: '4', issue_id: 'I-4', status: 'fixed' }),
    T({ id: '5', issue_id: 'I-5', status: 'in_progress', assignee_id: 'brad' }),
  ];
  const w = holdWarnings(ts, ships(dead), DEFAULT_CONTRACT, new Set(['brad']), NOW);
  assert.equal(w.length, 2);
  assert.match(w[0]!, /I-1.*no held_by_ship_id/);
  assert.match(w[1]!, /I-2.*Brads-Mac-mini/);
  assert.deepEqual(holdWarnings(ts.slice(2, 4), ships(), DEFAULT_CONTRACT, new Set(), NOW), []);
});

test('CREW-1394: a QA resume of a qa/fixed ticket a LIVE ship holds writes nothing and hands the ticket back', async () => {
  const a = { myShipId: 'ship-B', ships: ships(), contract: DEFAULT_CONTRACT, now: NOW };
  const affinity = {
    column: 'held_by_ship_id',
    shipId: 'ship-B',
    isHeldElsewhere: (t: Ticket) => heldByOtherShip(t, a),
    isLiveHoldElsewhere: (t: Ticket) => heldByLiveOtherShip(t, a),
  };
  for (const status of ['qa', 'fixed']) {
    const held = T({ id: 't', issue_id: 'CREW-1386', status, assignee_id: 'qa-A', held_by_ship_id: 'ship-A' });
    const { tracker, calls } = fakeTracker([held]);
    const r = await resolveTopCandidate(tracker, [held], 'qa-B', 'accepted', 'in_progress', undefined, affinity);
    assert.equal(calls.length, 0, status);
    assert.equal(r.claimed, false, status);
    if (status === 'qa') {
      // CREW-1389: a qa hold is the verifier's, so it is skipped outright.
      assert.equal(r.ticket, null);
      assert.deepEqual(r.held, ['CREW-1386']);
    } else {
      // `fixed` stays exempt (any QA may claim it); a resumption is handed back unstamped.
      assert.equal(r.ticket?.id, 't');
      assert.equal(r.ticket?.held_by_ship_id, 'ship-A');
    }
  }
});

test('CREW-1394: a qa ticket whose hold names a DEAD ship is still stamped by the resuming ship', async () => {
  const a = { myShipId: 'ship-B', ships: ships(dead), contract: DEFAULT_CONTRACT, now: NOW };
  const affinity = {
    column: 'held_by_ship_id',
    shipId: 'ship-B',
    isHeldElsewhere: (t: Ticket) => heldByOtherShip(t, a),
    isLiveHoldElsewhere: (t: Ticket) => heldByLiveOtherShip(t, a),
  };
  const held = T({ id: 't', issue_id: 'CREW-1386', status: 'qa', assignee_id: 'qa-A', held_by_ship_id: 'ship-A' });
  const { tracker, calls } = fakeTracker([held]);
  const r = await resolveTopCandidate(tracker, [held], 'qa-B', 'accepted', 'in_progress', undefined, affinity);
  assert.deepEqual(calls[0]!.patch, { held_by_ship_id: 'ship-B' });
  assert.equal(r.ticket?.held_by_ship_id, 'ship-B');
});

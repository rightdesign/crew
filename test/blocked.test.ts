import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockerInfoMap, missingBlockerIds, computeBlockedIds, sweepDiagnostics,
  planSweep, strandedNeedsInfo, rollUpParents, applySweep, sweepComment,
} from '../src/blocked.ts';
import type { Ticket } from '../src/tracker.ts';

const T = (o: Partial<Ticket> & { id: string; issue_id: string; status: string }): Ticket =>
  ({ updated_at: '2026-08-23T00:00:00.000Z', ...o }) as Ticket;

test('a blocker only stops counting at a terminal, shipped status', () => {
  const t = T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted', blocked_by: ['b'] });
  for (const [status, blocked] of [
    ['accepted', true], ['in_progress', true], ['needs_info', true],
    ['fixed', true],            // an unmerged branch awaiting QA is NOT resolved
    ['verified', false], ['closed_deployed', false],
    ['closed_wont_fix', false], ['closed_duplicate', false],
  ] as const) {
    const b = T({ id: 'b', issue_id: 'ISSUE-2', status });
    const info = blockerInfoMap([t, b]);
    assert.equal(computeBlockedIds([t, b], info).has('a'), blocked, `blocker at ${status}`);
  }
});

test('a dangling reference does not block — better than parking forever', () => {
  const t = T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted', blocked_by: ['gone'] });
  const info = blockerInfoMap([t]);
  assert.equal(computeBlockedIds([t], info).has('a'), false);
  assert.deepEqual(sweepDiagnostics([t], info).dangling, ['ISSUE-1 -> gone']);
});

test('a self-block parks permanently and is reported once', () => {
  const t = T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted', blocked_by: ['a', 'a'] });
  const info = blockerInfoMap([t]);
  assert.ok(computeBlockedIds([t], info).has('a'));
  assert.deepEqual(sweepDiagnostics([t], info).selfBlocked, ['ISSUE-1']);
});

test('transitivity comes free through iteration, without walking the chain', () => {
  const a = T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted', blocked_by: ['b'] });
  const b = T({ id: 'b', issue_id: 'ISSUE-2', status: 'accepted', blocked_by: ['c'] });
  const c = T({ id: 'c', issue_id: 'ISSUE-3', status: 'accepted' });
  const blocked = computeBlockedIds([a, b, c], blockerInfoMap([a, b, c]));
  assert.ok(blocked.has('a'));   // depth-1 on b, which is itself unresolved
  assert.ok(blocked.has('b'));
  assert.ok(!blocked.has('c'));
});

test('only accepted<->blocked is ever produced', () => {
  const info = (ts: Ticket[]) => blockerInfoMap(ts);
  const blocker = T({ id: 'x', issue_id: 'ISSUE-9', status: 'accepted' });
  const tickets = [
    blocker,
    T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted', blocked_by: ['x'] }),   // park
    T({ id: 'b', issue_id: 'ISSUE-2', status: 'blocked' }),                        // restore
    T({ id: 'c', issue_id: 'ISSUE-3', status: 'in_progress', blocked_by: ['x'] }), // untouched
    T({ id: 'd', issue_id: 'ISSUE-4', status: 'new', blocked_by: ['x'] }),         // untouched
    T({ id: 'e', issue_id: 'ISSUE-5', status: 'needs_info', blocked_by: ['x'] }),  // untouched
    T({ id: 'f', issue_id: 'ISSUE-6', status: 'blocked', blocked_by: ['x'] }),     // still blocked
  ];
  const i = info(tickets);
  const steps = planSweep(tickets, i, computeBlockedIds(tickets, i));
  assert.deepEqual(steps.map((s) => [s.ticket.issue_id, s.action, s.to]), [
    ['ISSUE-1', 'park', 'blocked'],
    ['ISSUE-2', 'restore', 'accepted'],
  ]);
  assert.match(steps[0]!.blockers, /ISSUE-9 \(accepted\)/);
});

test('needs_info with every blocker resolved is surfaced, never moved', () => {
  const done = T({ id: 'x', issue_id: 'ISSUE-9', status: 'closed_deployed' });
  const t = T({ id: 'a', issue_id: 'ISSUE-1', status: 'needs_info', blocked_by: ['x'] });
  const i = blockerInfoMap([t, done]);
  const blocked = computeBlockedIds([t, done], i);
  assert.deepEqual(strandedNeedsInfo([t, done], blocked).map((x) => x.issue_id), ['ISSUE-1']);
  assert.deepEqual(planSweep([t, done], i, blocked), []); // surfaced, not swept
});

test('blockers outside the open set are identified for a bounded extra fetch', () => {
  const t = T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted', blocked_by: ['closed-1', 'a'] });
  assert.deepEqual(missingBlockerIds([t]), ['closed-1']);
  const closed = T({ id: 'closed-1', issue_id: 'ISSUE-0', status: 'closed_deployed' });
  assert.equal(computeBlockedIds([t], blockerInfoMap([t], [closed])).has('a'), true); // self-block
});

test('a coordinating parent rolls up from its children', () => {
  const parent = T({ id: 'p', issue_id: 'ISSUE-1', status: 'accepted' });            // no repo_id
  const kid1 = { ...T({ id: 'k1', issue_id: 'ISSUE-2', status: 'closed_deployed' }), parent_id: 'p', repo_id: 'r1' };
  const kid2 = { ...T({ id: 'k2', issue_id: 'ISSUE-3', status: 'in_progress' }), parent_id: 'p', repo_id: 'r2' };
  const partial = rollUpParents([parent, kid1 as Ticket, kid2 as Ticket]);
  assert.equal(partial.length, 1);
  assert.equal(partial[0]!.complete, false);
  assert.deepEqual(partial[0]!.outstanding.map((t) => t.issue_id), ['ISSUE-3']);

  const kid2done = { ...kid2, status: 'verified' };
  const full = rollUpParents([parent, kid1 as Ticket, kid2done as Ticket]);
  assert.equal(full[0]!.complete, true);
});

test('a parent with no children is not complete — vacuous truth would close it at birth', () => {
  const lonely = T({ id: 'p', issue_id: 'ISSUE-1', status: 'accepted' });
  assert.deepEqual(rollUpParents([lonely]), []);
});

test('a ticket with a repo is actionable, so it never rolls up even with children', () => {
  const withRepo = { ...T({ id: 'p', issue_id: 'ISSUE-1', status: 'accepted' }), repo_id: 'r1' };
  const kid = { ...T({ id: 'k', issue_id: 'ISSUE-2', status: 'verified' }), parent_id: 'p' };
  assert.deepEqual(rollUpParents([withRepo as Ticket, kid as Ticket]), []);
});

test('a stranded ticket assigned to a human is NOT reported — the ball is in their court', () => {
  const done = T({ id: 'x', issue_id: 'ISSUE-9', status: 'closed_deployed' });
  const held = T({ id: 'a', issue_id: 'ISSUE-1', status: 'needs_info', blocked_by: ['x'], assignee_id: 'op-1' });
  const orphan = T({ id: 'b', issue_id: 'ISSUE-2', status: 'needs_info', blocked_by: ['x'] });
  const tickets = [done, held, orphan];
  const info = blockerInfoMap(tickets);
  const blocked = computeBlockedIds(tickets, info);
  const holds = new Set(['op-1']);

  assert.deepEqual(strandedNeedsInfo(tickets, blocked, holds).map((t) => t.issue_id), ['ISSUE-2']);
  // without the holds set, both look identical — which is why it is passed in
  assert.equal(strandedNeedsInfo(tickets, blocked).length, 2);
});

test('a ticket assigned to a SEAT is still reported — a seat is not a person', () => {
  const done = T({ id: 'x', issue_id: 'ISSUE-9', status: 'verified' });
  const t = T({ id: 'a', issue_id: 'ISSUE-1', status: 'needs_info', blocked_by: ['x'], assignee_id: 'dev-1' });
  const tickets = [done, t];
  const blocked = computeBlockedIds(tickets, blockerInfoMap(tickets));
  assert.equal(strandedNeedsInfo(tickets, blocked, new Set(['op-1'])).length, 1);
});

test('the sweep is APPLIED, not merely announced', async () => {
  // The bug this pins: planSweep was computed and logged, and nothing ever
  // wrote it — so a parked ticket stayed in the pool and a ready one stayed
  // invisible, on every cycle, silently.
  const writes: Array<[string, unknown]> = [];
  const events: string[] = [];
  const writer = {
    updateTicket: async (id: string, patch: Record<string, unknown>) => { writes.push([id, patch]); return {}; },
    postEvent: async (id: string, body: string) => { events.push(`${id}:${body.slice(0, 20)}`); },
  };
  const log = { emit: () => {}, warn: () => {} };
  const steps = [
    { action: 'park' as const, ticket: T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted' }), blockers: 'ISSUE-9 (accepted)', to: 'blocked' as const },
    { action: 'restore' as const, ticket: T({ id: 'b', issue_id: 'ISSUE-2', status: 'blocked' }), blockers: 'ISSUE-8 (verified)', to: 'accepted' as const },
  ];
  const r = await applySweep(writer, steps, 'seat-1', log);
  assert.deepEqual(r, { parked: 1, restored: 1, failed: 0 });
  assert.deepEqual(writes, [['a', { status: 'blocked' }], ['b', { status: 'accepted' }]]);
  assert.equal(events.length, 2);
});

test('a failed status write is reported and does not stop the rest', async () => {
  const writes: string[] = [];
  const writer = {
    updateTicket: async (id: string) => {
      writes.push(id);
      if (id === 'a') throw new Error('409 conflict');
      return {};
    },
    postEvent: async () => {},
  };
  const warned: string[] = [];
  const r = await applySweep(writer, [
    { action: 'park' as const, ticket: T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted' }), blockers: 'x', to: 'blocked' as const },
    { action: 'park' as const, ticket: T({ id: 'b', issue_id: 'ISSUE-2', status: 'accepted' }), blockers: 'x', to: 'blocked' as const },
  ], 's', { emit: () => {}, warn: (m: string) => warned.push(m) });
  assert.deepEqual(writes, ['a', 'b']);
  assert.deepEqual(r, { parked: 1, restored: 0, failed: 1 });
  assert.ok(warned.some((w) => /could not park/.test(w)));
});

test('a comment that fails to post does not undo the status change', async () => {
  const writer = {
    updateTicket: async () => ({}),
    postEvent: async () => { throw new Error('comment endpoint down'); },
  };
  const warned: string[] = [];
  const r = await applySweep(writer, [
    { action: 'park' as const, ticket: T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted' }), blockers: 'x', to: 'blocked' as const },
  ], 's', { emit: () => {}, warn: (m: string) => warned.push(m) });
  assert.equal(r.parked, 1);            // the ticket IS parked
  assert.ok(warned.some((w) => /note failed to post/.test(w)));
});

test('the park and restore notes explain themselves', () => {
  const park = sweepComment({ action: 'park', ticket: T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted' }), blockers: 'ISSUE-9 (accepted)', to: 'blocked' });
  assert.match(park, /automatic and reversible/);
  assert.match(park, /not at `fixed`/);
  const restore = sweepComment({ action: 'restore', ticket: T({ id: 'b', issue_id: 'ISSUE-2', status: 'blocked' }), blockers: 'ISSUE-8 (verified)', to: 'accepted' });
  assert.match(restore, /Restored to \*\*Approved\*\*/);
  assert.match(restore, /a call for a human, not the crew/);
});

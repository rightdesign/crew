import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockerInfoMap, missingBlockerIds, computeBlockedIds, sweepDiagnostics,
  planSweep, strandedNeedsInfo, rollUpParents,
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

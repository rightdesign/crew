import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StaleWriteError } from '@tablation/client';
import { resolveTopCandidate, type ClaimableTracker } from '../src/claim.ts';
import type { Ticket } from '../src/tracker.ts';

const T = (o: Partial<Ticket> & { id: string; issue_id: string; status: string }): Ticket =>
  ({ updated_at: '2026-08-25T00:00:00.000Z', ...o }) as Ticket;

/**
 * A tiny in-memory ticket store, CAS-checked the way the real API does.
 *
 * `rows` is cloned from the fixtures passed in, deliberately NOT the same
 * objects a test hands to `resolveTopCandidate` — a candidate list is a
 * point-in-time read, and a test simulating "another ship wrote first" needs
 * to move the store out from under it without also mutating the read the
 * candidate list already made.
 */
function fakeTracker(fixtures: Ticket[]) {
  const calls: Array<{ id: string; patch: Record<string, unknown>; expectedUpdatedAt?: string }> = [];
  const rows = fixtures.map((t) => ({ ...t }));
  let writeCounter = 0;
  const tracker: ClaimableTracker = {
    async updateTicket(id, patch, expectedUpdatedAt) {
      calls.push({ id, patch, expectedUpdatedAt });
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error('no such ticket');
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== row.updated_at) {
        throw new StaleWriteError({ conflict: true });
      }
      Object.assign(row, patch);
      row.updated_at = new Date(Date.parse(row.updated_at) + (++writeCounter)).toISOString();
      return { ...row };
    },
  };
  return { tracker, calls, rows };
}

test('the top accepted candidate is claimed with a conditional write', async () => {
  const a = T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted' });
  const { tracker, calls } = fakeTracker([a]);
  const result = await resolveTopCandidate(tracker, [a], 'dev-1', 'accepted', 'in_progress');
  assert.equal(result.claimed, true);
  assert.deepEqual(result.contended, []);
  assert.equal(result.ticket?.status, 'in_progress');
  assert.equal(result.ticket?.assignee_id, 'dev-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.expectedUpdatedAt, a.updated_at);
});

test('a resumption ticket (already in_progress) is handed back with no write attempted', async () => {
  const a = T({ id: 'a', issue_id: 'ISSUE-1', status: 'in_progress', assignee_id: 'dev-1' });
  const { tracker, calls } = fakeTracker([a]);
  const result = await resolveTopCandidate(tracker, [a], 'dev-1', 'accepted', 'in_progress');
  assert.equal(result.claimed, false);
  assert.equal(result.ticket?.id, 'a');
  assert.equal(calls.length, 0);
});

test('a contended top candidate is skipped in favour of the next one', async () => {
  const a = T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted' });
  const b = T({ id: 'b', issue_id: 'ISSUE-2', status: 'accepted' });
  const { tracker } = fakeTracker([a, b]);
  // Another ship claims `a` between this ship reading it and writing it —
  // simulated by writing to the store's row directly, out from under the
  // stale `a` this test still holds.
  await tracker.updateTicket('a', { status: 'in_progress', assignee_id: 'someone-else' });
  const result = await resolveTopCandidate(tracker, [a, b], 'dev-1', 'accepted', 'in_progress');
  assert.deepEqual(result.contended, ['ISSUE-1']);
  assert.equal(result.claimed, true);
  assert.equal(result.ticket?.id, 'b');
});

test('every accepted candidate contended — this role has nothing this cycle', async () => {
  const a = T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted' });
  const { tracker } = fakeTracker([a]);
  await tracker.updateTicket('a', { status: 'in_progress', assignee_id: 'someone-else' });
  const result = await resolveTopCandidate(tracker, [a], 'dev-1', 'accepted', 'in_progress');
  assert.equal(result.ticket, null);
  assert.equal(result.claimed, false);
  assert.deepEqual(result.contended, ['ISSUE-1']);
});

test('an unrelated error is not swallowed as a contended claim', async () => {
  const a = T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted' });
  const tracker: ClaimableTracker = {
    updateTicket: async () => { throw new Error('network blip'); },
  };
  await assert.rejects(
    resolveTopCandidate(tracker, [a], 'dev-1', 'accepted', 'in_progress'),
    /network blip/,
  );
});

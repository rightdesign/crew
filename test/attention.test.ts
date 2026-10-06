import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attentionReasons, attentionTransitions } from '../src/attention.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import type { Ticket } from '../src/tracker.ts';

const ticket = (patch: Partial<Ticket> = {}): Ticket => ({
  id: 't1', issue_id: 'ISSUE-1', status: 'accepted', updated_at: '2026-09-19T00:00:00Z', ...patch,
});

test('attentionReasons: none of the three gates set -> empty', () => {
  assert.deepEqual(attentionReasons(ticket(), DEFAULT_CONTRACT), []);
});

test('attentionReasons: needs_info comes from the contract\'s own needsHuman status', () => {
  assert.deepEqual(attentionReasons(ticket({ status: 'needs_info' }), DEFAULT_CONTRACT), ['needs_info']);
});

test('attentionReasons: needs_planning and needs_review are independent booleans', () => {
  assert.deepEqual(
    attentionReasons(ticket({ needs_planning: true }), DEFAULT_CONTRACT),
    ['needs_planning'],
  );
  assert.deepEqual(
    attentionReasons(ticket({ needs_review: true }), DEFAULT_CONTRACT),
    ['needs_review'],
  );
});

test('attentionReasons: all three can be true at once, in a fixed order', () => {
  assert.deepEqual(
    attentionReasons(ticket({ status: 'needs_info', needs_planning: true, needs_review: true }), DEFAULT_CONTRACT),
    ['needs_info', 'needs_planning', 'needs_review'],
  );
});

test('attentionReasons: a plain in_progress ticket with the gates false/null is not attention-worthy', () => {
  assert.deepEqual(
    attentionReasons(ticket({ status: 'in_progress', needs_planning: false, needs_review: null }), DEFAULT_CONTRACT),
    [],
  );
});

test('attentionTransitions: a reason present now and absent before is a transition', () => {
  const out = attentionTransitions({}, { t1: ['needs_info'] });
  assert.deepEqual(out, [{ ticketId: 't1', reasons: ['needs_info'] }]);
});

test('attentionTransitions: present both cycles emits nothing', () => {
  const out = attentionTransitions({ t1: ['needs_info'] }, { t1: ['needs_info'] });
  assert.deepEqual(out, []);
});

test('attentionTransitions: only the NEW reason is reported when a ticket already had one', () => {
  const out = attentionTransitions({ t1: ['needs_info'] }, { t1: ['needs_info', 'needs_planning'] });
  assert.deepEqual(out, [{ ticketId: 't1', reasons: ['needs_planning'] }]);
});

test('attentionTransitions: a ticket absent from `current` (closed, or gates cleared) reports nothing', () => {
  const out = attentionTransitions({ t1: ['needs_info'] }, {});
  assert.deepEqual(out, []);
});

test('attentionTransitions: a reason that dropped out and came back fires again', () => {
  // Cycle 2: the reason cleared (not in `current`); cycle 3: it's back.
  const afterClear = attentionTransitions({ t1: ['needs_info'] }, {});
  assert.deepEqual(afterClear, []);
  const afterReturn = attentionTransitions({}, { t1: ['needs_info'] });
  assert.deepEqual(afterReturn, [{ ticketId: 't1', reasons: ['needs_info'] }]);
});

test('attentionTransitions: a brand new open ticket with no prior state emits everything it carries', () => {
  const out = attentionTransitions({}, { t1: ['needs_info', 'needs_review'] });
  assert.deepEqual(out, [{ ticketId: 't1', reasons: ['needs_info', 'needs_review'] }]);
});

test('attentionTransitions: several tickets are diffed independently', () => {
  const out = attentionTransitions(
    { t1: ['needs_info'] },
    { t1: ['needs_info'], t2: ['needs_planning'] },
  );
  assert.deepEqual(out, [{ ticketId: 't2', reasons: ['needs_planning'] }]);
});

test('operatorTodo: needs_info counts only when assigned to the operator', async () => {
  const { operatorTodo } = await import('../src/attention.ts');
  const mine = ticket({ id: 'a', status: 'needs_info', assignee_id: 'op' });
  const theirs = ticket({ id: 'b', status: 'needs_info', assignee_id: 'someone' });
  const unassigned = ticket({ id: 'c', status: 'needs_info' });
  assert.deepEqual(
    operatorTodo([mine, theirs, unassigned], DEFAULT_CONTRACT, 'op').map((i) => i.ticket.id),
    ['a'],
  );
});

test('operatorTodo: needs_planning counts whoever holds the ticket, and merges reasons per ticket', async () => {
  const { operatorTodo } = await import('../src/attention.ts');
  const both = ticket({ id: 'a', status: 'needs_info', assignee_id: 'op', needs_planning: true });
  const planning = ticket({ id: 'b', status: 'accepted', assignee_id: 'agent', needs_planning: true });
  const review = ticket({ id: 'c', status: 'in_progress', needs_review: true });
  const items = operatorTodo([both, planning, review], DEFAULT_CONTRACT, 'op');
  assert.deepEqual(items.map((i) => [i.ticket.id, i.reasons]), [
    ['a', ['needs_info', 'needs_planning']],
    ['b', ['needs_planning']],
  ]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, changed, nextRoles } from '../src/fleet.ts';
import type { CycleDecision } from '../src/poll.ts';

const T = (id: string, status: string, updated_at = 't0', assignee_id: string | null = null) =>
  ({ id, status, updated_at, assignee_id });

test('a run that moved a ticket is detected', () => {
  const before = snapshot([T('a', 'accepted'), T('b', 'accepted')]);
  assert.equal(changed(before, snapshot([T('a', 'in_progress'), T('b', 'accepted')])), true);
});

test('a run that changed nothing is detected', () => {
  const before = snapshot([T('a', 'accepted'), T('b', 'accepted')]);
  assert.equal(changed(before, snapshot([T('a', 'accepted'), T('b', 'accepted')])), false);
});

test('an assignee change counts — claiming a ticket IS doing something', () => {
  const before = snapshot([T('a', 'accepted')]);
  assert.equal(changed(before, snapshot([T('a', 'accepted', 't0', 'dev-1')])), true);
});

test('a comment (which bumps updated_at) counts', () => {
  const before = snapshot([T('a', 'needs_info', 't0')]);
  assert.equal(changed(before, snapshot([T('a', 'needs_info', 't1')])), true);
});

test('a ticket appearing or leaving the open set counts', () => {
  const before = snapshot([T('a', 'accepted')]);
  assert.equal(changed(before, snapshot([T('a', 'accepted'), T('b', 'new')])), true);
  assert.equal(changed(snapshot([T('a', 'accepted'), T('b', 'new')]), before), true);
});

test('the runner-up roles come back in rank order, excluding what already ran', () => {
  const d = {
    selection: { pending: ['qa', 'dev', 'design'], ranks: { qa: -1, dev: 2020000339, design: 2020000319 } },
  } as unknown as CycleDecision;
  assert.deepEqual(nextRoles(d, ['qa']), ['design', 'dev']);   // design outranks dev
  assert.deepEqual(nextRoles(d, ['qa', 'design']), ['dev']);
  assert.deepEqual(nextRoles(d, ['qa', 'design', 'dev']), []);
});

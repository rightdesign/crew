import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StaleWriteError } from '@tablation/client';
import {
  planEpicSync, epicsNeedingClosedCheck, applyEpicSync, type EpicRow,
} from '../src/epics.ts';
import { DEFAULT_CONTRACT, resolveContract, validateContract } from '../src/contract.ts';
import type { Ticket } from '../src/tracker.ts';

const C = DEFAULT_CONTRACT;
const E = (id: string, status: string): EpicRow =>
  ({ id, status, epic_id: `EPIC-${id}`, updated_at: '2026-09-30T00:00:00.000Z' });
let n = 0;
const T = (epic: string, status: string): Ticket =>
  ({ id: `t${++n}`, issue_id: `ISSUE-${n}`, status, epic_id: epic, updated_at: '2026-09-30T00:00:00.000Z' }) as Ticket;

const plan = (epics: EpicRow[], tickets: Ticket[], c = C) => {
  const closedSet = new Set(c.statuses.resolved.filter((s) => s !== c.statuses.verified));
  const outstanding = tickets.filter((t) => !closedSet.has(t.status));
  const wanted = new Set(epicsNeedingClosedCheck(epics, outstanding, c));
  const closed = tickets.filter((t) => closedSet.has(t.status) && wanted.has(String(t.epic_id)));
  return planEpicSync(epics, outstanding, closed, c).map((s) => `${s.epic.id}:${s.action}:${s.to}`);
};

test('an epic whose every ticket is closed becomes done, at any closed status', () => {
  assert.deepEqual(
    plan([E('a', 'in_progress'), E('b', 'planned')], [
      T('a', 'closed_deployed'), T('a', 'closed_wont_fix'), T('a', 'closed_duplicate'),
      T('b', 'closed_completed'), T('b', 'closed_cant_reproduce'),
    ]),
    ['a:complete:done', 'b:complete:done'],
  );
});

test('one ticket still open keeps the epic from being done', () => {
  for (const status of ['new', 'accepted', 'blocked', 'needs_info', 'draft']) {
    assert.deepEqual(plan([E('a', 'in_progress')], [T('a', 'closed_deployed'), T('a', status)]), [], status);
  }
});

test('verified is not closed — it has not shipped yet', () => {
  assert.deepEqual(plan([E('a', 'in_progress')], [T('a', 'closed_deployed'), T('a', 'verified')]), []);
});

test('a done epic with a ticket being worked goes back to in progress', () => {
  for (const status of ['in_progress', 'fixed', 'qa', 'verified']) {
    assert.deepEqual(
      plan([E('a', 'done')], [T('a', 'closed_deployed'), T('a', status)]), ['a:reopen:in_progress'], status,
    );
  }
});

test('a done epic that merely gains an untouched ticket stays done', () => {
  for (const status of ['new', 'accepted', 'blocked', 'needs_info', 'draft']) {
    assert.deepEqual(plan([E('a', 'done')], [T('a', 'closed_deployed'), T('a', status)]), [], status);
  }
});

test('a planned epic starts when its first ticket is worked', () => {
  assert.deepEqual(plan([E('a', 'planned')], [T('a', 'accepted'), T('a', 'in_progress')]), ['a:start:in_progress']);
});

test('an epic with no tickets is never marked done', () => {
  assert.deepEqual(plan([E('a', 'planned'), E('b', 'in_progress')], []), []);
});

test('a cancelled epic, or one at a status nobody named, is left alone', () => {
  assert.deepEqual(
    plan([E('a', 'cancelled'), E('b', 'on_hold'), E('c', 'cancelled')], [
      T('a', 'closed_deployed'), T('b', 'closed_deployed'), T('c', 'in_progress'),
    ]),
    [],
  );
});

test('an epic already saying the right thing plans nothing', () => {
  assert.deepEqual(
    plan([E('a', 'done'), E('b', 'in_progress')], [T('a', 'closed_deployed'), T('b', 'in_progress')]), [],
  );
});

test('closed tickets are only asked for where an epic could be completing', () => {
  const epics = [E('a', 'in_progress'), E('b', 'in_progress'), E('c', 'done'), E('d', 'cancelled')];
  assert.deepEqual(epicsNeedingClosedCheck(epics, [T('a', 'accepted')], C), ['b']);
});

test('a workspace that renames its epic statuses is followed', () => {
  const c = resolveContract({
    epics: { statuses: { building: 'active', done: 'shipped' } },
  } as Parameters<typeof resolveContract>[0]);
  assert.deepEqual(validateContract(c), []);
  assert.deepEqual(plan([E('a', 'active')], [T('a', 'closed_deployed')], c), ['a:complete:shipped']);
  assert.deepEqual(plan([E('a', 'shipped')], [T('a', 'in_progress')], c), ['a:reopen:active']);
});

test('applying writes conditionally, and losing the race is not a failure', async () => {
  const steps = planEpicSync(
    [E('a', 'in_progress'), E('b', 'done')], [T('b', 'in_progress')], [T('a', 'closed_deployed')], C,
  );
  const sent: unknown[] = [];
  const warned: string[] = [];
  const r = await applyEpicSync(
    {
      async updateEpic(id, patch, expected) {
        if (id === 'b') throw new StaleWriteError('stale');
        sent.push([id, patch, expected]);
      },
    },
    steps, C, { emit() {}, warn(m) { warned.push(m); } },
  );
  assert.deepEqual(sent, [['a', { status: 'done' }, '2026-09-30T00:00:00.000Z']]);
  assert.deepEqual(r, { updated: 1, contended: 1, failed: 0 });
  assert.deepEqual(warned, []);
});

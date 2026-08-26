import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFailureAlert, findOpenFailureAlert, FAILURE_ALERT_MARKER,
  type FailureAlertWriter, type FailureAlertLog,
} from '../src/failure-alert.ts';
import type { Ticket } from '../src/tracker.ts';
import type { Notification } from '../src/notify.ts';

const silent: FailureAlertLog = { emit: () => {}, warn: () => {} };

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'row-1', issue_id: 'ISSUE-999', title: 'proj: build FAILED', status: 'accepted',
  updated_at: '2026-01-01T00:00:00Z', ...over,
});

const n: Notification = { level: 'fail', headline: 'proj: build FAILED', detail: 'tsc failed' };

function writer() {
  const filed: Array<Record<string, unknown>> = [];
  const notes: Array<{ id: string; body: string }> = [];
  const w: FailureAlertWriter = {
    fileTicket: async (fields) => { filed.push(fields); return ticket({ id: 'new-row', issue_id: 'ISSUE-1000' }); },
    postEvent: async (id, body) => { notes.push({ id, body }); },
  };
  return { w, filed, notes };
}

test('no matching open ticket: files a new one', async () => {
  const { w, filed } = writer();
  const out = await applyFailureAlert(w, n, 'proj', [], 'seat', silent, false);

  assert.equal(out.kind, 'filed');
  assert.equal(out.issueId, 'ISSUE-1000');
  assert.equal(filed.length, 1);
  assert.equal(filed[0]!.title, 'proj: build FAILED');
  assert.match(filed[0]!.description as string, new RegExp(FAILURE_ALERT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(filed[0]!.severity, 's2');
});

test('a ticket already open with the same headline gets a comment instead of a duplicate', async () => {
  const { w, filed, notes } = writer();
  const existing = ticket();
  const out = await applyFailureAlert(w, n, 'proj', [existing], 'seat', silent, false);

  assert.equal(out.kind, 'commented');
  assert.equal(out.issueId, 'ISSUE-999');
  assert.equal(filed.length, 0, 'must not file a second ticket for a recurring failure');
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.id, 'row-1');
  assert.match(notes[0]!.body, /Still failing/);
});

test('findOpenFailureAlert matches on the exact headline only', () => {
  const t = ticket({ title: 'other: build FAILED' });
  assert.equal(findOpenFailureAlert([t], 'proj: build FAILED'), undefined);
  assert.deepEqual(findOpenFailureAlert([t, ticket()], 'proj: build FAILED'), ticket());
});

test('a dry run neither files nor comments', async () => {
  const { w, filed, notes } = writer();
  const out = await applyFailureAlert(w, n, 'proj', [], 'seat', silent, true);
  assert.equal(out.kind, 'filed');
  assert.equal(filed.length, 0);
  assert.equal(notes.length, 0);
});

test('a tracker write failure is reported, not thrown', async () => {
  const w: FailureAlertWriter = {
    fileTicket: async () => { throw new Error('boom'); },
    postEvent: async () => {},
  };
  const out = await applyFailureAlert(w, n, 'proj', [], 'seat', silent, false);
  assert.equal(out.kind, 'failed');
  assert.match((out as { why: string }).why, /boom/);
});

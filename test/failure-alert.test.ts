import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFailureAlert, applyFailureRecovery, findOpenFailureAlert, FAILURE_ALERT_MARKER,
  type FailureAlertWriter, type FailureAlertLog,
} from '../src/failure-alert.ts';
import type { Ticket } from '../src/tracker.ts';
import { recoveredFailureHeadlines, type Notification } from '../src/notify.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';

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

test('the filed ticket is attributed to the seat that filed it (CREW-1371 filed_by_id)', async () => {
  const filedBy: string[] = [];
  const w: FailureAlertWriter = {
    fileTicket: async (_fields, memberId) => { filedBy.push(memberId); return ticket({ id: 'new-row', issue_id: 'ISSUE-1000' }); },
    postEvent: async () => {},
  };
  await applyFailureAlert(w, n, 'proj', [], 'seat-dev', silent, false);

  assert.deepEqual(filedBy, ['seat-dev']);
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

test('placement: files with the repo and project ids when supplied', async () => {
  const { w, filed } = writer();
  await applyFailureAlert(w, n, 'proj', [], 'seat', silent, false, { repo_id: 'repo-1', project_id: 'proj-1' });
  assert.equal(filed[0]!.repo_id, 'repo-1');
  assert.equal(filed[0]!.project_id, 'proj-1');
});

test('placement: omitted, the ticket is filed without repo or project', async () => {
  const { w, filed } = writer();
  await applyFailureAlert(w, n, 'proj', [], 'seat', silent, false);
  assert.ok(!('repo_id' in filed[0]!));
  assert.ok(!('project_id' in filed[0]!));
});

function recoveryWriter() {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const notes: Array<{ id: string; body: string }> = [];
  return {
    updates, notes,
    w: {
      updateTicket: async (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }); },
      postEvent: async (id: string, body: string) => { notes.push({ id, body }); },
    },
  };
}

const testsFailed = 'proj: release blocked — tests failed';

test('recovery closes an unclaimed alert with a note, clearing assignee and hold', async () => {
  for (const status of ['new', 'accepted', 'needs_info']) {
    const { w, updates, notes } = recoveryWriter();
    const alert = ticket({ id: `a-${status}`, title: testsFailed, status });
    const out = await applyFailureRecovery(w, [testsFailed], [alert], DEFAULT_CONTRACT, 'seat', 'proj released v1.2.3', silent, false);
    assert.deepEqual(out.closed, ['ISSUE-999']);
    assert.equal(notes.length, 1);
    assert.match(notes[0]!.body, /Passed: proj released v1\.2\.3/);
    assert.deepEqual(updates[0]!.patch, {
      status: 'closed_completed', resolution_note: 'Resolved automatically: proj released v1.2.3.',
      assignee_id: null, held_by_ship_id: null,
    });
  }
});

test('recovery leaves an in_progress alert open and only posts the event', async () => {
  const { w, updates, notes } = recoveryWriter();
  const alert = ticket({ title: testsFailed, status: 'in_progress' });
  const out = await applyFailureRecovery(w, [testsFailed], [alert], DEFAULT_CONTRACT, 'seat', 'passed', silent, false);
  assert.deepEqual(out.noted, ['ISSUE-999']);
  assert.equal(updates.length, 0);
  assert.equal(notes.length, 1);
});

test('recovery of one headline does not touch another kind on the same route', async () => {
  const { w, updates, notes } = recoveryWriter();
  const deploy = ticket({ id: 'd', title: 'proj: deploy FAILED' });
  const headlines = recoveredFailureHeadlines({ stopped: 'build failed' }, 'proj');
  await applyFailureRecovery(w, headlines, [deploy], DEFAULT_CONTRACT, 'seat', 'passed', silent, false);
  assert.equal(updates.length, 0);
  assert.equal(notes.length, 0);
});

test('recovery dry run writes nothing', async () => {
  const { w, updates, notes } = recoveryWriter();
  await applyFailureRecovery(w, [testsFailed], [ticket({ title: testsFailed })], DEFAULT_CONTRACT, 'seat', 'passed', silent, true);
  assert.equal(updates.length + notes.length, 0);
});

test('recoveredFailureHeadlines follows the stages a release got past', () => {
  assert.deepEqual(recoveredFailureHeadlines({ stopped: 'tests failed' }, 'proj'), []);
  assert.equal(recoveredFailureHeadlines({ stopped: 'deploy failed' }, 'proj').includes('proj: deploy FAILED'), false);
  assert.equal(recoveredFailureHeadlines({ stopped: 'deploy failed' }, 'proj').includes('proj: build FAILED'), true);
  assert.equal(recoveredFailureHeadlines({ deployed: true }, 'proj').includes('proj: deploy FAILED'), true);
  assert.equal(recoveredFailureHeadlines({ integrated: true }, 'proj').includes(testsFailed), true);
});

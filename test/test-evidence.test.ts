import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureSummary, describeComposition, headLine } from '../src/test-evidence.ts';
import { describeRelease } from '../src/notify.ts';
import { applyFailureAlert, type FailureAlertWriter } from '../src/failure-alert.ts';
import type { RunnerEvent, Ticket } from '../src/tracker.ts';

const comp = {
  head: 'abcdef1234567890', base: '1111111122222222',
  branches: [{ key: 'TABL-2199', branch: 'tabl-2199', tip: 'deadbeef00000000' }],
};

test('failureSummary prefers failing test names and the first error over a raw tail', () => {
  const out = [
    ...Array.from({ length: 40 }, (_, i) => `noise ${i}`),
    ' FAIL  src/a.test.ts > does a thing',
    'ReferenceError: foo is not defined',
    '    at bar (src/a.ts:1:1)',
    ...Array.from({ length: 30 }, (_, i) => `tail ${i}`),
  ].join('\n');
  const s = failureSummary(out);
  assert.match(s, /FAIL {2}src\/a\.test\.ts > does a thing/);
  assert.match(s, /ReferenceError: foo is not defined/);
  assert.doesNotMatch(s, /noise 3/);
});

test('failureSummary falls back to the tail when nothing identifies a failure', () => {
  const out = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const s = failureSummary(out, 5);
  assert.equal(s, 'line 25\nline 26\nline 27\nline 28\nline 29');
});

test('the tests-failed alert carries evidence, shas and branches', () => {
  const n = describeRelease({
    deployed: false, merged: [], stopped: 'tests failed', composition: comp,
    hookFailure: { hook: 'test', label: 'pnpm test', tail: ' FAIL  x' },
  }, 'proj')!;
  assert.equal(n.headline, 'proj: release blocked — tests failed');
  assert.match(n.detail!, /FAIL {2}x/);
  assert.match(n.detail!, /abcdef12/);
  assert.match(n.detail!, /11111111/);
  assert.match(n.detail!, /TABL-2199 `tabl-2199` @ `deadbeef`/);
  assert.match(n.detail!, /base plus every verified branch/);
  assert.match(n.detail!, /belongs on one of those branches/);
  assert.equal(n.head, comp.head);
});

test('setup/build/deploy alerts carry no head', () => {
  assert.equal(describeRelease({ deployed: false, merged: [], stopped: 'build failed' }, 'p')!.head, undefined);
});

const ticket: Ticket = { id: 'r1', issue_id: 'ISSUE-1', title: 'proj: release blocked — tests failed', status: 'accepted', updated_at: '' };

function writer(events: RunnerEvent[]) {
  const notes: string[] = [];
  const w: FailureAlertWriter = {
    fileTicket: async () => ticket,
    postEvent: async (_id, body) => { notes.push(body); },
    events: async () => events,
  };
  return { w, notes };
}
const log = { emit: () => {}, warn: () => {} };

test('a recurrence on a new head repeats the full evidence; on the same head it is short', async () => {
  const n = describeRelease({ deployed: false, merged: [], stopped: 'tests failed', composition: comp,
    hookFailure: { hook: 'test', label: 't', tail: 'FAIL  y' } }, 'proj')!;
  const seen: RunnerEvent = { record_id: 'r1', event_type: 'failure_alert', message: describeComposition(comp) };

  const fresh = writer([{ ...seen, message: headLine('0000000000') }]);
  await applyFailureAlert(fresh.w, n, 'proj', [ticket], 'seat', log, false);
  assert.match(fresh.notes[0]!, /FAIL {2}y/);

  const same = writer([seen]);
  await applyFailureAlert(same.w, n, 'proj', [ticket], 'seat', log, false);
  assert.doesNotMatch(same.notes[0]!, /FAIL {2}y/);
  assert.match(same.notes[0]!, /Still failing/);
});

test('filing leaves an event naming the head so the first recurrence is short', async () => {
  const n = describeRelease({ deployed: false, merged: [], stopped: 'tests failed', composition: comp }, 'proj')!;
  const { w, notes } = writer([]);
  await applyFailureAlert(w, n, 'proj', [], 'seat', log, false);
  assert.match(notes[0]!, /abcdef12/);
});

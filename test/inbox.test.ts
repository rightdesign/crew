import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchMembers, renderInbox } from '../src/inbox.ts';
import type { InboxItem } from '../src/inbox.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import type { Ticket } from '../src/tracker.ts';

const item = (o: Partial<Ticket> & { issue_id: string }, connection = 'a', rank = 1): InboxItem => ({
  connection,
  ticket: { id: o.issue_id, status: 'needs_info', updated_at: '', ...o } as Ticket,
  assignee: 'Brad C.', rank, effective: 2, contract: DEFAULT_CONTRACT,
});

test('a member is matched by partial, case-insensitive name', () => {
  const rows = [
    { id: '1', name: 'Brad C.' }, { id: '2', name: 'QA agent' }, { id: '3', name: null },
  ];
  assert.deepEqual(matchMembers(rows, 'brad').map((m) => m.id), ['1']);
  assert.deepEqual(matchMembers(rows, 'AGENT').map((m) => m.id), ['2']);
  assert.deepEqual(matchMembers(rows, 'nobody'), []);
});

test('an empty queue names WHOSE queue it is', () => {
  // "nothing assigned to you" while covering for a colleague is the exact
  // misreading this view exists to avoid.
  assert.equal(renderInbox([], false), 'nothing assigned to you\n');
  assert.equal(renderInbox([], false, 'Dana R.'), 'nothing assigned to Dana R.\n');
});

test('items group by status by default and by connection on request', () => {
  const items = [
    item({ issue_id: 'ISSUE-1', status: 'needs_info', title: 'one' }, 'alpha'),
    item({ issue_id: 'ISSUE-2', status: 'accepted', title: 'two' }, 'beta'),
  ];
  const byStatus = renderInbox(items);
  assert.ok(byStatus.indexOf('needs_info') < byStatus.indexOf('accepted'));
  assert.match(byStatus, /ISSUE-1.*alpha/s);

  const byConn = renderInbox(items, true);
  assert.ok(byConn.indexOf('alpha') < byConn.indexOf('beta'));
});

test('ranks from different workspaces sort into one list', () => {
  // The contract makes each board's priority an INDEX, so they are comparable
  // even when the boards name their priorities differently.
  const items = [
    item({ issue_id: 'ISSUE-9', title: 'later' }, 'alpha', 2020000009),
    item({ issue_id: 'ISSUE-1', title: 'urgent' }, 'beta', 1000000001),
  ].sort((a, b) => a.rank - b.rank);
  const out = renderInbox(items);
  assert.ok(out.indexOf('ISSUE-1') < out.indexOf('ISSUE-9'));
});

test('an email matches exactly; a name matches loosely — and they are told apart', () => {
  const rows = [
    { id: '1', name: 'Brad C.', email: 'brad@rightdesign.com' },
    { id: '2', name: 'Bradley Smith', email: 'bsmith@example.com' },
  ];
  const byEmail = matchMembers(rows, 'brad@rightdesign.com');
  assert.deepEqual(byEmail.map((m) => m.id), ['1']);
  assert.equal(byEmail[0]!.by, 'email');

  // a name is a label: "brad" catches both people
  const byName = matchMembers(rows, 'brad');
  assert.deepEqual(byName.map((m) => m.id), ['1', '2']);
  assert.equal(byName[0]!.by, 'name');

  // an email that matches nobody matches nobody — no substring fallback
  assert.deepEqual(matchMembers(rows, 'brad@elsewhere.com'), []);
});

test('a name is matched per workspace, which is why it can disagree', () => {
  // Same query, different people — the failure an email lookup cannot produce.
  const alpha = [{ id: 'a1', name: 'Chris Alvarez', email: 'calvarez@a.com' }];
  const beta = [{ id: 'b1', name: 'Chris Bennett', email: 'cbennett@b.com' }];
  assert.equal(matchMembers(alpha, 'chris')[0]!.name, 'Chris Alvarez');
  assert.equal(matchMembers(beta, 'chris')[0]!.name, 'Chris Bennett');
  // ...and the same email would simply match one of them, or neither
  assert.deepEqual(matchMembers(beta, 'calvarez@a.com'), []);
});

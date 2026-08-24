import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildingDigest, qaDigest, type DigestInput } from '../src/digest.ts';
import { buildRoster } from '../src/roster.ts';

const MEMBERS = [
  { id: 'dev-1', role: 'Dev', kind: 'seat' as const },
  { id: 'qa-1', role: 'QA', kind: 'seat' as const },
  { id: 'op-1', role: 'Operator', kind: 'hold' as const },
  { id: 'pair-1', role: 'live session', kind: 'hold' as const },
];
const ROWS = [
  { id: 'dev-1', name: 'Developer agent' }, { id: 'qa-1', name: 'QA agent' },
  { id: 'op-1', name: 'Brad C.' }, { id: 'pair-1', name: 'Pair agent' },
];
const roster = buildRoster(MEMBERS, ROWS);


function input(over: Partial<DigestInput> = {}): DigestInput {
  return {
    tickets: [], comments: [], me: 'dev-1', roster,
    watermark: '1970-01-01T00:00:00Z', branches: [],
    blocked: new Set(), blockerInfo: {}, ...over,
  };
}

const T = (o: Partial<DigestInput['tickets'][number]> & { id: string; issue_id: string; status: string }) =>
  ({ updated_at: '2026-08-23T12:00:00.000Z', ...o }) as DigestInput['tickets'][number];

test('an empty queue says so in each section', () => {
  const out = buildingDigest(input());
  assert.match(out, /### Step 1 — open tickets/);
  assert.match(out, /### Step 2 — accepted tickets/);
  assert.match(out, /### Blocked/);
  assert.equal((out.match(/_None\._/g) ?? []).length, 3);
});

test('every column renders, including holds and blockers', () => {
  const i = input({
    dirFor: (t) => (t.repo_id === 'r-api' ? '/w/api' : null),
    branchFor: (t) => `feature/${t.issue_id}`,
    tickets: [
      T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted', severity: 's1', repo_id: 'r-api' }),
      T({ id: 'b', issue_id: 'ISSUE-2', status: 'in_progress', assignee_id: 'dev-1', severity: 's3', priority: 'p0' }),
      T({ id: 'c', issue_id: 'ISSUE-3', status: 'needs_info', assignee_id: 'op-1' }),
      T({ id: 'g', issue_id: 'ISSUE-7', status: 'blocked', blocked_by: ['a', 'zz'] }),
    ],
    comments: [
      { ticket_id: 'a', team_member_id: 'op-1', created_at: '2026-08-23T11:00:00.000Z' },
    ],
    blocked: new Set(['g']),
    blockerInfo: { a: { issue_id: 'ISSUE-1', status: 'accepted' } },
  });
  const out = buildingDigest(i);
  assert.match(out, /\| ISSUE-1 \| \/w\/api \| feature\/ISSUE-1 \|/); // checkout, then branch
  assert.match(out, /\*\*Brad C\. \(Operator\) — HOLD\*\*/);   // a hold is marked
  assert.match(out, /\*\*1 new\*\*/);                            // comment since the watermark
  assert.match(out, /ISSUE-1 \(accepted\), \? \(unknown\)/);     // blockers, dangling included
  assert.match(out, /Use the `branch` column verbatim/);
  // A ticket whose repo this ship has no clone of must be marked, not left
  // blank: blank reads as "work it here", which would be the wrong checkout.
  assert.match(out, /\| ISSUE-2 \| \*\*NO CHECKOUT\*\* \|/);
});

test('the QA digest renders as it always has, branches and built-by included', () => {
  const i = input({
    me: 'qa-1',
    tickets: [
      T({ id: 'a', issue_id: 'ISSUE-10', status: 'fixed', needs_design: true, severity: 's2' }),
      T({ id: 'b', issue_id: 'ISSUE-11', status: 'qa', assignee_id: 'qa-1' }),
      T({ id: 'c', issue_id: 'ISSUE-12', status: 'fixed', assignee_id: 'op-1', severity: 's1' }),
    ],
    branches: ['issue-10', 'issue-0011'],
    comments: [{ ticket_id: 'a', team_member_id: 'dev-1', created_at: '2026-08-23T10:00:00.000Z' }],
  });
  // Golden captured from lib/queue-digest-qa.jq before it was deleted. The QA
  // digest is prose an agent reads and acts on, so a diff here is a change to
  // instructions, not just to formatting — it should be looked at, not blessed.
  assert.equal(qaDigest(i), readFileSync(join(import.meta.dirname, 'fixtures/qa-digest.md'), 'utf8'));
});

test('the watermark decides what counts as new', () => {
  const base = {
    tickets: [T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted' })],
    comments: [{ ticket_id: 'a', team_member_id: 'op-1', created_at: '2026-08-23T10:00:00.000Z' }],
  };
  const before = input({ ...base, watermark: '2026-08-23T09:00:00Z' });
  const after = input({ ...base, watermark: '2026-08-23T11:00:00Z' });
  assert.match(buildingDigest(before), /\*\*1 new\*\*/);
  assert.doesNotMatch(buildingDigest(after), /\*\*1 new\*\*/);
});


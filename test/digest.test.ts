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
    watermark: '1970-01-01T00:00:00Z',
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
    worktreeFor: (t) => `api-feature-${t.issue_id}`,
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
  assert.match(out, /\| ISSUE-1 \| \/w\/api \| feature\/ISSUE-1 \| api-feature-ISSUE-1 \|/); // checkout, branch, worktree
  assert.match(out, /\*\*Brad C\. \(Operator\) — HOLD\*\*/);   // a hold is marked
  assert.match(out, /\*\*1 new\*\*/);                            // comment since the watermark
  assert.match(out, /ISSUE-1 \(accepted\), \? \(unknown\)/);     // blockers, dangling included
  assert.match(out, /Use the `branch` and `worktree` columns verbatim/);
  // A ticket whose repo this ship has no clone of must be marked, not left
  // blank: blank reads as "work it here", which would be the wrong checkout.
  assert.match(out, /\| ISSUE-2 \| \*\*NO CHECKOUT\*\* \|/);
});

test('a ticket carrying an Issue Tag displays it in place of the bare issue_id (ISSUE-969)', () => {
  const i = input({
    tickets: [
      T({ id: 'a', issue_id: 'ISSUE-969', issue_tag: 'CREW-969', status: 'accepted' }),
      T({ id: 'g', issue_id: 'ISSUE-7', status: 'blocked', blocked_by: ['a'] }),
    ],
    blocked: new Set(['g']),
    blockerInfo: { a: { issue_id: 'ISSUE-969', issue_tag: 'CREW-969', status: 'accepted' } },
  });
  const out = buildingDigest(i);
  assert.match(out, /\| CREW-969 \|/);
  assert.doesNotMatch(out, /ISSUE-969/);
  assert.match(out, /CREW-969 \(accepted\)/); // blockers use the tag too
});

test('the QA digest renders as it always has, branches and built-by included', () => {
  const found: Record<string, string> = { a: 'issue-10', b: 'issue-0011' };
  const i = input({
    me: 'qa-1',
    tickets: [
      T({ id: 'a', issue_id: 'ISSUE-10', status: 'fixed', needs_design: true, severity: 's2' }),
      T({ id: 'b', issue_id: 'ISSUE-11', status: 'qa', assignee_id: 'qa-1' }),
      T({ id: 'c', issue_id: 'ISSUE-12', status: 'fixed', assignee_id: 'op-1', severity: 's1' }),
    ],
    dirFor: () => '/w/api',
    existingBranchFor: (t) => found[t.id] ?? null,
    worktreeFor: (t) => `api-${t.issue_id.toLowerCase()}`,
    comments: [{ ticket_id: 'a', team_member_id: 'dev-1', created_at: '2026-08-23T10:00:00.000Z' }],
  });
  // Golden captured from lib/queue-digest-qa.jq before it was deleted. The QA
  // digest is prose an agent reads and acts on, so a diff here is a change to
  // instructions, not just to formatting — it should be looked at, not blessed.
  assert.equal(qaDigest(i), readFileSync(join(import.meta.dirname, 'fixtures/qa-digest.md'), 'utf8'));
});

// ISSUE-349. QA was handed one flat list of the route directory's
// branches and no checkout column at all, so a ticket in the area's second
// repo rendered as "no worktree to test" and QA routed it to a human. Both
// halves are per-ticket now, which is the only way either can be right when
// an area spans several repos.
test('the QA digest places a ticket in its own repo, and finds its branch there', () => {
  const dirs: Record<string, string | null> = {
    'r-api': '/w/api', 'r-cli': '/w/cli', 'r-far': null,
  };
  const i = input({
    me: 'qa-1',
    tickets: [
      T({ id: 'a', issue_id: 'ISSUE-20', status: 'fixed', repo_id: 'r-api' }),
      T({ id: 'b', issue_id: 'ISSUE-21', status: 'fixed', repo_id: 'r-cli' }),
      T({ id: 'c', issue_id: 'ISSUE-22', status: 'fixed', repo_id: 'r-cli' }),
      T({ id: 'd', issue_id: 'ISSUE-23', status: 'fixed', repo_id: 'r-far' }),
    ],
    dirFor: (t) => dirs[t.repo_id ?? ''] ?? null,
    // Only the CLI repo has ISSUE-21's branch; the route's own directory
    // never sees it. The pre-ISSUE-349 lookup answered from one repo and so
    // reported this as MISSING.
    existingBranchFor: (t) => (t.id === 'b' ? 'bc/issue-21-add-widget' : null),
  });
  const out = qaDigest(i);
  assert.match(out, /\| ISSUE-20 \| \/w\/api \| fixed \|/);
  assert.match(out, /\| ISSUE-21 \| \/w\/cli \| fixed \|/);
  // The branch is reported as the repo actually names it, not re-derived.
  assert.match(out, /\| bc\/issue-21-add-widget \|/);
  // Same repo, no branch left: there is genuinely nothing to verify.
  assert.match(out, /\| ISSUE-22 \|[^\n]*\| \*\*MISSING\*\* \|/);
  // No checkout here means the branch could not be looked for at all, which
  // is not the same claim as "the branch is gone".
  assert.match(out, /\| ISSUE-23 \| \*\*NO CHECKOUT\*\* \|/);
  assert.match(out, /\| ISSUE-23 \|[^\n]*\| — \|/);
  assert.match(out, /the worktree you verify in sits beside THAT/);
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


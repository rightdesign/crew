import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

/** The roster as lib/roster.jq wants it: {id: {name, role, kind:"agent"|"hold"}}. */
const rosterJson = Object.fromEntries(
  [...roster.values()].map((m) => [m.id, { name: m.name, role: m.role, kind: m.kind === 'hold' ? 'hold' : 'agent' }]),
);

/** The roster as lib/roster.jq wants it, for whichever roster a test uses. */
function toJqRoster(r: DigestInput['roster']) {
  return Object.fromEntries(
    [...r.values()].map((m) => [m.id, { name: m.name, role: m.role, kind: m.kind === 'hold' ? 'hold' : 'agent' }]),
  );
}

function jqDigest(program: string, i: DigestInput): string {
  return execFileSync('jq', [
    '-L', 'lib', '-r',
    '--argjson', 'comments', JSON.stringify(i.comments),
    '--arg', 'me', i.me,
    '--argjson', 'roster', JSON.stringify(toJqRoster(i.roster)),
    '--arg', 'watermark', i.watermark,
    '--arg', 'branches', i.branches.join('\n'),
    '--argjson', 'blocked', JSON.stringify([...i.blocked]),
    '--argjson', 'blockerinfo', JSON.stringify(i.blockerInfo),
    '--from-file', program,
  ], { input: JSON.stringify(i.tickets), encoding: 'utf8' });
}

function input(over: Partial<DigestInput> = {}): DigestInput {
  return {
    tickets: [], comments: [], me: 'dev-1', roster,
    watermark: '1970-01-01T00:00:00Z', branches: [],
    blocked: new Set(), blockerInfo: {}, ...over,
  };
}

const T = (o: Partial<DigestInput['tickets'][number]> & { id: string; issue_id: string; status: string }) =>
  ({ updated_at: '2026-08-23T12:00:00.000Z', ...o }) as DigestInput['tickets'][number];

test('building digest matches queue-digest.jq on an empty queue', () => {
  const i = input();
  assert.equal(buildingDigest(i), jqDigest('lib/queue-digest.jq', i));
});

test('building digest matches on a queue exercising every column', () => {
  const i = input({
    tickets: [
      T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted', severity: 's1' }),
      T({ id: 'b', issue_id: 'ISSUE-2', status: 'in_progress', assignee_id: 'dev-1', severity: 's3', priority: 'p0' }),
      T({ id: 'c', issue_id: 'ISSUE-3', status: 'needs_info', assignee_id: 'op-1' }),
      T({ id: 'd', issue_id: 'ISSUE-4', status: 'in_progress', assignee_id: null, severity: 's2' }),
      T({ id: 'e', issue_id: 'ISSUE-5', status: 'accepted', assignee_id: 'pair-1' }),
      T({ id: 'f', issue_id: 'ISSUE-6', status: 'accepted', assignee_id: 'someone-else' }),
      T({ id: 'g', issue_id: 'ISSUE-7', status: 'blocked', blocked_by: ['a', 'zz'] }),
    ],
    comments: [
      { ticket_id: 'a', team_member_id: 'dev-1', created_at: '2026-08-23T10:00:00.000Z' },
      { ticket_id: 'a', team_member_id: 'op-1', created_at: '2026-08-23T11:00:00.000Z' },
      { ticket_id: 'b', team_member_id: null, reporter_name: 'Someone', created_at: '2026-08-23T09:00:00.000Z' },
      { ticket_id: 'c', team_member_id: 'op-1', kind: 'event', created_at: '2026-08-23T11:30:00.000Z' },
    ],
    blocked: new Set(['g']),
    blockerInfo: { a: { issue_id: 'ISSUE-1', status: 'accepted' } },
  });
  assert.equal(buildingDigest(i), jqDigest('lib/queue-digest.jq', i));
});

test('QA digest matches queue-digest-qa.jq, branches and built-by included', () => {
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
  assert.equal(qaDigest(i), jqDigest('lib/queue-digest-qa.jq', i));
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
  assert.equal(buildingDigest(before), jqDigest('lib/queue-digest.jq', before));
  assert.equal(buildingDigest(after), jqDigest('lib/queue-digest.jq', after));
});

test('matches the jq on the live queue, with the live roster', () => {
  const raw = process.env.CREW_TEST_DIGEST;
  if (!raw) return;
  const { tickets, comments, members, rows, seats } =
    JSON.parse(raw) as { tickets: any[]; comments: any[]; members: any[]; rows: any[]; seats: string[] };
  // The real roster, so `who` and `author` resolve real assignees and authors
  // rather than falling through to "someone off this ship" on every row.
  const live = buildRoster(members, rows);
  for (const me of seats) {
    const i = input({ tickets, comments, me, roster: live, watermark: '2026-08-20T00:00:00Z' });
    assert.equal(buildingDigest(i), jqDigest('lib/queue-digest.jq', i), `building digest, me=${me}`);
    assert.equal(qaDigest(i), jqDigest('lib/queue-digest-qa.jq', i), `qa digest, me=${me}`);
  }
});

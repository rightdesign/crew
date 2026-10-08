import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectRole, roleHasWork, roleTopRank, sliceFor, qaSlice, buildingSlice, actionableSummary, rankedCandidates,
} from '../src/select.ts';
import type { SelectionInput } from '../src/select.ts';
import type { Ticket } from '../src/tracker.ts';

const T = (o: Partial<Ticket> & { id: string; issue_id: string; status: string }): Ticket =>
  ({ updated_at: '2026-08-23T00:00:00.000Z', ...o }) as Ticket;

const input = (over: Partial<SelectionInput> = {}): SelectionInput => ({
  tickets: [], comments: [], watermark: '2026-01-01T00:00:00Z',
  blocked: new Set(), holds: new Set(['hold-1']),
  seats: { dev: 'dev-1', design: 'design-1', qa: 'qa-1' }, ...over,
});

test('the slices partition by status first, then needs_design', () => {
  const ts = [
    T({ id: 'a', issue_id: 'ISSUE-1', status: 'fixed', needs_design: true }),
    T({ id: 'b', issue_id: 'ISSUE-2', status: 'accepted', needs_design: true }),
    T({ id: 'c', issue_id: 'ISSUE-3', status: 'accepted' }),
    T({ id: 'd', issue_id: 'ISSUE-4', status: 'accepted', needs_design: null }),
  ];
  assert.deepEqual(qaSlice(ts).map((t) => t.id), ['a']);
  assert.deepEqual(buildingSlice(ts, 'design').map((t) => t.id), ['a', 'b']);
  // null needs_design reads as false — dev's, same as the prompt tells agents
  assert.deepEqual(buildingSlice(ts, 'dev').map((t) => t.id), ['c', 'd']);
});

test('QA wins any cycle it has work — a tie falls to verifying, not building', () => {
  const sel = selectRole(input({
    tickets: [
      T({ id: 'q', issue_id: 'ISSUE-1', status: 'fixed' }),
      T({ id: 'd', issue_id: 'ISSUE-2', status: 'accepted', severity: 's1' }),  // most urgent possible
    ],
  }));
  assert.deepEqual(sel.pending, ['qa', 'dev']);
  assert.equal(sel.selected, 'qa');
  assert.equal(sel.ranks.qa, -2);
});

test('between building roles, the most urgent ticket wins', () => {
  const sel = selectRole(input({
    tickets: [
      T({ id: 'a', issue_id: 'ISSUE-9', status: 'accepted', severity: 's3' }),
      T({ id: 'b', issue_id: 'ISSUE-8', status: 'accepted', severity: 's1', needs_design: true }),
    ],
  }));
  assert.equal(sel.selected, 'design');
  assert.ok(sel.ranks.design! < sel.ranks.dev!);
});

test('a held ticket cannot be the sole reason a cycle wakes', () => {
  const held = input({ tickets: [T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted', assignee_id: 'hold-1' })] });
  assert.equal(roleHasWork('dev', held).hasWork, false);
  assert.equal(roleTopRank('dev', held), 999_999_999_999);
  const free = input({ tickets: [T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted' })] });
  assert.equal(roleHasWork('dev', free).hasWork, true);
});

test('a dependency-blocked ticket cannot either — membership decides, not status', () => {
  const t = T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted' });
  assert.equal(roleHasWork('dev', input({ tickets: [t], blocked: new Set(['a']) })).hasWork, false);
  // a ticket still LABELLED blocked whose blockers cleared is startable again
  const stale = T({ id: 'b', issue_id: 'ISSUE-2', status: 'blocked' });
  assert.equal(roleHasWork('dev', input({ tickets: [stale] })).hasWork, true);
});

test('fixed never wakes a building role — it is QA\'s', () => {
  const i = input({ tickets: [T({ id: 'a', issue_id: 'ISSUE-1', status: 'fixed' })] });
  assert.equal(roleHasWork('dev', i).hasWork, false);
  assert.equal(roleHasWork('qa', i).hasWork, true);
});

// Status is needs_info, not in_progress, in these two: a self-assigned
// in_progress ticket is now always resumable (ISSUE-756) regardless of
// comments, which would swallow the very thing being isolated here — the
// pure comment-wake logic. needs_info is unaffected by that new path, so
// it stays a clean way to test newComments alone.
test('a new comment from someone else wakes a role; our own does not', () => {
  const t = T({ id: 'a', issue_id: 'ISSUE-1', status: 'needs_info', assignee_id: 'dev-1' });
  const at = '2026-06-01T00:00:00Z';
  const mine = input({ tickets: [t], comments: [{ ticket_id: 'a', team_member_id: 'dev-1', created_at: at }] as any });
  assert.equal(roleHasWork('dev', mine).hasWork, false);
  const theirs = input({ tickets: [t], comments: [{ ticket_id: 'a', team_member_id: 'qa-1', created_at: at }] as any });
  assert.equal(roleHasWork('dev', theirs).hasWork, true);
  // an `event` comment is the loop's own audit trail and must not wake anyone
  const ev = input({ tickets: [t], comments: [{ ticket_id: 'a', team_member_id: 'qa-1', kind: 'event', created_at: at }] as any });
  assert.equal(roleHasWork('dev', ev).hasWork, false);
});

test('a comment older than the watermark does not wake anyone', () => {
  const t = T({ id: 'a', issue_id: 'ISSUE-1', status: 'needs_info', assignee_id: 'dev-1' });
  const c = [{ ticket_id: 'a', team_member_id: 'qa-1', created_at: '2025-01-01T00:00:00Z' }] as any;
  assert.equal(roleHasWork('dev', input({ tickets: [t], comments: c })).hasWork, false);
});

test('an unassigned in_progress ticket is back up for grabs', () => {
  const t = T({ id: 'a', issue_id: 'ISSUE-1', status: 'in_progress', assignee_id: null });
  assert.equal(roleHasWork('dev', input({ tickets: [t] })).hasWork, true);
});

test('a self-assigned in_progress ticket is resumable with no new comment (ISSUE-756)', () => {
  const t = T({ id: 'a', issue_id: 'ISSUE-1', status: 'in_progress', assignee_id: 'dev-1' });
  const r = roleHasWork('dev', input({ tickets: [t] }));
  assert.equal(r.hasWork, true);
  assert.match(r.reason, /resumable in_progress/);
});

test('a held self-assigned in_progress ticket is still not resumable — a person is driving it', () => {
  const t = T({ id: 'a', issue_id: 'ISSUE-1', status: 'in_progress', assignee_id: 'hold-1' });
  assert.equal(roleHasWork('dev', input({ tickets: [t] })).hasWork, false);
});

test('needs_planning/needs_review gate a self-assigned in_progress ticket out of auto-resume', () => {
  const planning = T({ id: 'a', issue_id: 'ISSUE-1', status: 'in_progress', assignee_id: 'dev-1', needs_planning: true });
  assert.equal(roleHasWork('dev', input({ tickets: [planning] })).hasWork, false);
  const review = T({ id: 'b', issue_id: 'ISSUE-2', status: 'in_progress', assignee_id: 'dev-1', needs_review: true });
  assert.equal(roleHasWork('dev', input({ tickets: [review] })).hasWork, false);

  // but a new comment from someone else still wakes it, same as any other gate
  const at = '2026-06-01T00:00:00Z';
  const withComment = input({
    tickets: [planning],
    comments: [{ ticket_id: 'a', team_member_id: 'qa-1', created_at: at }] as any,
  });
  assert.equal(roleHasWork('dev', withComment).hasWork, true);
});

test('a paused role is not selected, whatever its queue', () => {
  const i = input({
    tickets: [T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted', severity: 's1' })],
    paused: new Set(['dev' as const]),
  });
  assert.equal(roleHasWork('dev', i).hasWork, false);
  assert.equal(roleHasWork('dev', i).reason, 'paused');
  assert.equal(selectRole(i).selected, null);
});

test('a role this ship does not crew is never selected', () => {
  const i = input({ seats: { dev: 'dev-1' }, tickets: [T({ id: 'a', issue_id: 'ISSUE-1', status: 'fixed' })] });
  assert.equal(roleHasWork('qa', i).hasWork, false);
  assert.match(roleHasWork('qa', i).reason, /does not crew/);
});

test('every pending role stays pending — only one runs', () => {
  const sel = selectRole(input({
    tickets: [
      T({ id: 'q', issue_id: 'ISSUE-1', status: 'fixed' }),
      T({ id: 'd', issue_id: 'ISSUE-2', status: 'accepted' }),
      T({ id: 's', issue_id: 'ISSUE-3', status: 'accepted', needs_design: true }),
    ],
  }));
  assert.deepEqual(sel.pending, ['qa', 'dev', 'design']);
  assert.equal(sel.selected, 'qa');   // the other two are still pending next cycle
});

test('nothing to do is expressed as nothing, not as a default role', () => {
  const sel = selectRole(input());
  assert.deepEqual(sel.pending, []);
  assert.equal(sel.selected, null);
});

test('triage is a role, not a separate timer — one process, not two', () => {
  const i = input({
    seats: { dev: 'dev-1', qa: 'qa-1', triage: 'triage-1' },
    tickets: [T({ id: 'n', issue_id: 'ISSUE-1', status: 'new', assignee_id: 'triage-1' })],
  });
  const r = roleHasWork('triage', i);
  assert.equal(r.hasWork, true);
  assert.match(r.reason, /1 report\(s\) assigned to triage/);
  assert.equal(selectRole(i).selected, 'triage');
});

test('an unclassified report outranks building, but not verification', () => {
  const i = input({
    seats: { dev: 'dev-1', qa: 'qa-1', triage: 'triage-1' },
    tickets: [
      T({ id: 'n', issue_id: 'ISSUE-1', status: 'new', assignee_id: 'triage-1' }),
      T({ id: 'd', issue_id: 'ISSUE-2', status: 'accepted', severity: 's1' }),
    ],
  });
  // nothing to build can start until it is classified
  assert.equal(selectRole(i).selected, 'triage');

  const withQa = input({
    seats: { dev: 'dev-1', qa: 'qa-1', triage: 'triage-1' },
    tickets: [
      T({ id: 'n', issue_id: 'ISSUE-1', status: 'new', assignee_id: 'triage-1' }),
      T({ id: 'q', issue_id: 'ISSUE-3', status: 'fixed' }),
    ],
  });
  // ...but verifying finished work still comes first
  assert.equal(selectRole(withQa).selected, 'qa');
});

test('triage costs nothing on the cycles when nothing is new', () => {
  const i = input({ seats: { dev: 'dev-1', triage: 'triage-1' }, tickets: [] });
  assert.equal(roleHasWork('triage', i).hasWork, false);
  assert.match(roleHasWork('triage', i).reason, /nothing assigned to triage/);
});

test('a ship that does not crew triage is unaffected', () => {
  const i = input({ seats: { dev: 'dev-1' }, tickets: [T({ id: 'n', issue_id: 'ISSUE-1', status: 'new', assignee_id: 'triage-1' })] });
  assert.equal(roleHasWork('triage', i).hasWork, false);
  assert.match(roleHasWork('triage', i).reason, /does not crew/);
});

test('an unassigned report is NOT triage\'s — clearing the assignee is how it says done', () => {
  const seats = { dev: 'dev-1', qa: 'qa-1', triage: 'triage-1' };
  const assigned = input({ seats, tickets: [T({ id: 'n', issue_id: 'ISSUE-1', status: 'new', assignee_id: 'triage-1' })] });
  assert.equal(roleHasWork('triage', assigned).hasWork, true);

  // triage processed it: status moved, assignee cleared
  const done = input({ seats, tickets: [T({ id: 'n', issue_id: 'ISSUE-1', status: 'accepted' })] });
  assert.equal(roleHasWork('triage', done).hasWork, false);
});

test('a report triage could not classify is still not reassessed', () => {
  // The case a status check cannot survive: left at `new`, but unassigned.
  const seats = { dev: 'dev-1', triage: 'triage-1' };
  const i = input({ seats, tickets: [T({ id: 'n', issue_id: 'ISSUE-1', status: 'new' })] });
  assert.equal(roleHasWork('triage', i).hasWork, false);
});

test('reassigning to triage is how a human asks for another look', () => {
  const seats = { dev: 'dev-1', triage: 'triage-1' };
  const i = input({ seats, tickets: [T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted', assignee_id: 'triage-1' })] });
  assert.equal(roleHasWork('triage', i).hasWork, true);   // whatever its status
});

// ---------------------------------------------------------------------------
// actionableSummary (ISSUE-382)
// ---------------------------------------------------------------------------

test('actionableSummary pools candidates across every pending role and picks the most urgent', () => {
  const i = input({
    tickets: [
      T({ id: 'a', issue_id: 'ISSUE-9', status: 'accepted', severity: 's3' }),
      T({ id: 'b', issue_id: 'ISSUE-8', status: 'accepted', severity: 's1', needs_design: true }),
    ],
  });
  const summary = actionableSummary(i, ['dev', 'design']);
  assert.equal(summary.count, 2);
  assert.equal(summary.top?.id, 'b');   // s1 outranks s3
});

test('actionableSummary counts nothing for a role that is not pending', () => {
  const i = input({
    tickets: [T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted' })],
  });
  assert.deepEqual(actionableSummary(i, ['design']), { count: 0 });
});

test('actionableSummary excludes held and blocked tickets, same as roleTopRank', () => {
  const i = input({
    tickets: [
      T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted', assignee_id: 'hold-1' }),
      T({ id: 'b', issue_id: 'ISSUE-2', status: 'accepted' }),
    ],
    blocked: new Set(['b']),
  });
  assert.deepEqual(actionableSummary(i, ['dev']), { count: 0 });
});

// ---------------------------------------------------------------------------
// rankedCandidates (ISSUE-395)
// ---------------------------------------------------------------------------

test('rankedCandidates is roleCandidates in the same most-urgent-first order roleTopRank uses', () => {
  const i = input({
    tickets: [
      T({ id: 'a', issue_id: 'ISSUE-3', status: 'accepted', severity: 's3' }),
      T({ id: 'b', issue_id: 'ISSUE-1', status: 'accepted', severity: 's1' }),
      T({ id: 'c', issue_id: 'ISSUE-2', status: 'accepted', severity: 's2' }),
    ],
  });
  assert.deepEqual(rankedCandidates('dev', i).map((t) => t.id), ['b', 'c', 'a']);
});

test('rankedCandidates excludes held and blocked tickets, same as roleCandidates', () => {
  const i = input({
    tickets: [
      T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted', assignee_id: 'hold-1' }),
      T({ id: 'b', issue_id: 'ISSUE-2', status: 'accepted' }),
    ],
    blocked: new Set(['b']),
  });
  assert.deepEqual(rankedCandidates('dev', i), []);
});

test('a ticket in a stopped repo is invisible to the building roles but not to QA (CREW-1403)', () => {
  const ts = [
    T({ id: 'a', issue_id: 'ISSUE-1', status: 'accepted', repo_id: 'r-stopped' }),
    T({ id: 'q', issue_id: 'ISSUE-2', status: 'fixed', repo_id: 'r-stopped' }),
  ];
  const repoStop = (t: Ticket) => (t.repo_id === 'r-stopped' ? 'diverged' : null);
  assert.equal(roleHasWork('dev', input({ tickets: ts })).hasWork, true);
  assert.equal(roleHasWork('dev', input({ tickets: ts, repoStop })).hasWork, false);
  assert.deepEqual(rankedCandidates('dev', input({ tickets: ts, repoStop })), []);
  assert.equal(roleHasWork('qa', input({ tickets: ts, repoStop })).hasWork, true);
});

// CREW-1445: manual work mode
test('a manual project yields a building lane only tickets assigned to that lane', () => {
  const manual = new Set(['pm']);
  const ts = [
    T({ id: 'u', issue_id: 'ISSUE-1', status: 'accepted', project_id: 'pm' }),
    T({ id: 'o', issue_id: 'ISSUE-2', status: 'accepted', project_id: 'pm', assignee_id: 'someone-else' }),
  ];
  const none = input({ tickets: ts, manualProjects: manual });
  assert.equal(roleHasWork('dev', none).hasWork, false);
  assert.deepEqual(rankedCandidates('dev', none), []);
  assert.equal(selectRole(none).selected, null);

  const assigned = input({
    tickets: [...ts, T({ id: 'm', issue_id: 'ISSUE-3', status: 'accepted', project_id: 'pm', assignee_id: 'dev-1' })],
    manualProjects: manual,
  });
  assert.equal(selectRole(assigned).selected, 'dev');
  assert.deepEqual(rankedCandidates('dev', assigned).map((t) => t.id), ['m']);
});

test('an automatic project, and a manual set that is empty, behave as before', () => {
  const ts = [T({ id: 'u', issue_id: 'ISSUE-1', status: 'accepted', project_id: 'pa' })];
  assert.equal(selectRole(input({ tickets: ts, manualProjects: new Set(['pm']) })).selected, 'dev');
  assert.equal(selectRole(input({ tickets: ts, manualProjects: new Set() })).selected, 'dev');
});

test('QA still sees a fixed ticket in a manual project', () => {
  const sel = selectRole(input({
    tickets: [T({ id: 'f', issue_id: 'ISSUE-1', status: 'fixed', project_id: 'pm' })],
    manualProjects: new Set(['pm']),
  }));
  assert.equal(sel.selected, 'qa');
});

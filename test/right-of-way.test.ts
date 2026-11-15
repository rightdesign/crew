import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import {
  handBacks, planRightOfWay, branchPaths, deferralReported, deferralComment, deferredFromLog, DEFERRED_EVENT,
  type RightOfWayCandidate,
} from '../src/right-of-way.ts';
import { applyConflictBounce, planConflictBounce, type ConflictWriter, type ConflictLog } from '../src/conflict.ts';
import { renderStatus, type StatusView } from '../src/status-render.ts';
import type { Ticket, RunnerEvent } from '../src/tracker.ts';

const S = DEFAULT_CONTRACT.statuses;
const T0 = Date.parse('2026-11-15T10:00:00Z');
const min = (n: number) => T0 + n * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const t = (n: number, status: string): Ticket => ({
  id: `row-${n}`, issue_id: `ISSUE-${n}`, status, updated_at: '2026-11-15T00:00:00Z',
});
const handBack = (n: number, at: number, paths: string[] = ['src/a.ts']): RunnerEvent => ({
  record_id: `row-${n}`, event_type: 'conflict_handed_back', occurred_at: iso(at), metadata: { paths },
});
const cand = (ticket: Ticket, paths: string[]): RightOfWayCandidate => ({ ticket, paths });
const plan = (cands: RightOfWayCandidate[], tickets: Ticket[], events: RunnerEvent[], now: number, ttl = 60) =>
  planRightOfWay(cands, tickets, events, DEFAULT_CONTRACT, now, ttl);

test('a branch touching a hand-back\'s path waits for it; one touching other files does not', () => {
  const owner = t(2, S.building);
  const a = t(1, S.verified);
  const other = t(3, S.verified);
  const p = plan(
    [cand(a, ['src/a.ts', 'README.md']), cand(other, ['docs/x.md'])], [owner, a, other], [handBack(2, min(0))], min(5),
  );
  assert.deepEqual(p.deferrals.map((d) => [d.ticket.issue_id, d.waitingFor.issue_id, d.paths]), [['ISSUE-1', 'ISSUE-2', ['src/a.ts']]]);
  assert.deepEqual(p.lapsed, []);
});

test('the hand-back owner itself is never deferred by its own hand-back', () => {
  const owner = t(2, S.verified);
  const p = plan([cand(owner, ['src/a.ts'])], [owner], [handBack(2, min(0))], min(5));
  assert.deepEqual(p.deferrals, []);
});

test('three branches on one file: the older hand-back goes first, the newer waits', () => {
  const b = t(2, S.verified);
  const c = t(3, S.verified);
  const events = [handBack(2, min(0)), handBack(3, min(1))];
  const p = plan([cand(b, ['src/a.ts']), cand(c, ['src/a.ts'])], [b, c], events, min(10));
  assert.deepEqual(p.deferrals.map((d) => [d.ticket.issue_id, d.waitingFor.issue_id]), [['ISSUE-3', 'ISSUE-2']]);
  // Once B is released it is no longer in the open tickets; C goes.
  const after = plan([cand(c, ['src/a.ts'])], [c], events, min(11));
  assert.deepEqual(after.deferrals, []);
});

test('a hand-back tie breaks on the ticket key, so two ships agree', () => {
  const a = t(2, S.verified);
  const b = t(3, S.verified);
  const events = [handBack(3, min(0)), handBack(2, min(0))];
  const p = plan([cand(a, ['src/a.ts']), cand(b, ['src/a.ts'])], [a, b], events, min(1));
  assert.deepEqual(p.deferrals.map((d) => d.ticket.issue_id), ['ISSUE-3']);
});

test('the right of way lapses after the time limit and the plan says so', () => {
  const owner = t(2, S.building);
  const a = t(1, S.verified);
  const events = [handBack(2, min(0))];
  assert.equal(plan([cand(a, ['src/a.ts'])], [owner, a], events, min(59)).deferrals.length, 1);
  const late = plan([cand(a, ['src/a.ts'])], [owner, a], events, min(60));
  assert.deepEqual(late.deferrals, []);
  assert.deepEqual(late.lapsed.map((h) => h.ticket.issue_id), ['ISSUE-2']);
  // A lapse that blocks nobody is not worth a log line.
  assert.deepEqual(plan([cand(a, ['other.ts'])], [owner, a], events, min(60)).lapsed, []);
});

test('the time limit is configurable and 0 turns the right of way off', () => {
  const owner = t(2, S.building);
  const a = t(1, S.verified);
  const events = [handBack(2, min(0))];
  assert.equal(plan([cand(a, ['src/a.ts'])], [owner, a], events, min(20), 10).deferrals.length, 0);
  assert.equal(plan([cand(a, ['src/a.ts'])], [owner, a], events, min(20), 120).deferrals.length, 1);
  assert.equal(plan([cand(a, ['src/a.ts'])], [owner, a], events, min(1), 0).deferrals.length, 0);
});

test('a hand-back ends when its ticket is released, closed or escalated', () => {
  const a = t(1, S.verified);
  const events = [handBack(2, min(0))];
  for (const status of [S.deployed, S.needsHuman, 'closed_wont_fix']) {
    assert.deepEqual(plan([cand(a, ['src/a.ts'])], [t(2, status), a], events, min(1)).deferrals, [], status);
  }
  // Not on the board at all (closed tickets are not fetched).
  assert.deepEqual(plan([cand(a, ['src/a.ts'])], [a], events, min(1)).deferrals, []);
  const escalated: RunnerEvent = { record_id: 'row-2', event_type: 'conflict_escalated', occurred_at: iso(min(2)) };
  assert.deepEqual(plan([cand(a, ['src/a.ts'])], [t(2, S.building), a], [...events, escalated], min(3)).deferrals, []);
});

test('only a ticket\'s newest hand-back counts, and one without paths grants nothing', () => {
  const owner = t(2, S.building);
  const events = [handBack(2, min(0), ['old.ts']), handBack(2, min(5), ['new.ts']),
    { record_id: 'row-2', event_type: 'conflict_handed_back', occurred_at: iso(min(9)) } as RunnerEvent];
  const { open } = handBacks([owner], events, DEFAULT_CONTRACT, min(10), 60);
  assert.deepEqual(open.map((h) => h.paths), [['new.ts']]);
});

test('a deferral is reported once per hand-back it waits for', () => {
  const owner = t(2, S.building);
  const a = t(1, S.verified);
  const [d] = plan([cand(a, ['src/a.ts'])], [owner, a], [handBack(2, min(0))], min(5)).deferrals;
  assert.ok(d);
  assert.equal(deferralReported(d, []), false);
  const posted: RunnerEvent = {
    record_id: 'row-1', event_type: DEFERRED_EVENT, occurred_at: iso(min(5)), metadata: { waiting_for: 'row-2' },
  };
  assert.equal(deferralReported(d, [posted]), true);
  // A later hand-back of the same ticket is a new reason to wait.
  const [later] = plan([cand(a, ['src/a.ts'])], [owner, a], [handBack(2, min(30))], min(31)).deferrals;
  assert.equal(deferralReported(later!, [posted]), false);
  assert.match(deferralComment(d, 'main', 60), /ISSUE-2 was handed back for a merge conflict in `src\/a\.ts`/);
});

test('crew status lists a verified ticket whose deferral is still waiting on an open hand-back', () => {
  const owner = t(2, S.building);
  const a = t(1, S.verified);
  const log: RunnerEvent[] = [handBack(2, min(0)), {
    record_id: 'row-1', event_type: DEFERRED_EVENT, occurred_at: iso(min(5)), metadata: { waiting_for: 'row-2' },
  }];
  const got = deferredFromLog([owner, a], log, DEFAULT_CONTRACT, min(10), 60);
  assert.deepEqual(got.map((x) => [x.ticket.issue_id, x.waitingFor.issue_id]), [['ISSUE-1', 'ISSUE-2']]);
  assert.deepEqual(deferredFromLog([t(2, S.deployed), a], log, DEFAULT_CONTRACT, min(10), 60), []);
  assert.deepEqual(deferredFromLog([owner, a], log, DEFAULT_CONTRACT, min(70), 60), []);
});

test('renderStatus shows deferred branches under needs attention', () => {
  const view = {
    ship: { name: 'S', platform: 'darwin' }, route: { name: 'r', dir: '/x', enabled: true }, crewPaused: false,
    releasePaused: false, pausedRoles: [], periscopes: { summary: '', live: [] }, watermark: '0', projects: [],
    reloadRequestedSecondsAgo: null, runs: [], lastRuns: [], attention: [], waiting: [], repos: [], heldReleases: [],
    deferredReleases: ['ISSUE-1 waits for ISSUE-2, handed back for a merge conflict'], ships: [],
  } as StatusView;
  const lines = renderStatus(view, { verbose: false });
  assert.ok(lines.includes('  deferred: ISSUE-1 waits for ISSUE-2, handed back for a merge conflict'));
});

test('branchPaths lists what a branch changes against the base', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'row-')));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'n');
  writeFileSync(join(dir, 'a.txt'), '1\n'); g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-q', '-b', 'feat');
  writeFileSync(join(dir, 'b.txt'), '2\n'); g('add', '.'); g('commit', '-qm', 'feat');
  g('checkout', '-q', 'main');
  writeFileSync(join(dir, 'c.txt'), '3\n'); g('add', '.'); g('commit', '-qm', 'moved');
  assert.deepEqual(branchPaths(dir, 'main', 'feat'), ['b.txt']);
});

test('the conflict hand-back records the conflicting paths on the event', async () => {
  const log: ConflictLog = { emit: () => {}, warn: () => {} };
  const extras: Array<Record<string, unknown> | undefined> = [];
  const w: ConflictWriter = {
    updateTicket: async () => ({}),
    postEvent: async (_id, _body, _m, _type, extra) => { extras.push(extra); },
  };
  const b = planConflictBounce(tmpdir(), t(2, S.verified), 'issue-2', 'main', ['src/a.ts'], []);
  b.baseSha = 'abc1234';
  b.worktree = null;
  await applyConflictBounce(w, b, DEFAULT_CONTRACT, 'seat', log, false);
  assert.deepEqual(extras, [{ base_sha: 'abc1234', paths: ['src/a.ts'] }]);
});

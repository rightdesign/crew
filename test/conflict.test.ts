import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StaleWriteError } from '@tablation/client';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import {
  planConflictBounce, applyConflictBounce, refreshBranch, worktreeForBranch,
  priorBounces, baseShaOf, BOUNCE_MARKER, conflictCrowd, absorbedLimit, settleConflicts,
  MAX_ABSORBED_HANDBACKS, MAX_CROWD_ABSORBED_HANDBACKS, type ConflictWriter, type ConflictLog,
} from '../src/conflict.ts';
import { DEFERRED_EVENT } from '../src/right-of-way.ts';
import type { Ticket, RunnerEvent } from '../src/tracker.ts';

const silent: ConflictLog = { emit: () => {}, warn: () => {} };

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'row-1', issue_id: 'ISSUE-9', status: 'verified',
  updated_at: '2026-01-01T00:00:00Z', ...over,
});

/** A writer that records what it was asked to do rather than doing it. */
function writer() {
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const notes: string[] = [];
  const w: ConflictWriter = {
    updateTicket: async (id, patch) => { patches.push({ id, patch }); return {}; },
    postEvent: async (_id, body) => { notes.push(body); },
  };
  return { w, patches, notes };
}

/**
 * A writer whose `updateTicket` refuses every write with `StaleWriteError`,
 * as the real one does when the ticket moved on the board since this run
 * read it — used to prove a conflict bounce never clobbers a status change
 * (e.g. this ticket's own release just stamping it `deployed`) that landed
 * between the board fetch and the bounce write (ISSUE-821).
 */
function staleWriter() {
  const notes: string[] = [];
  const w: ConflictWriter = {
    updateTicket: async () => { throw new StaleWriteError({}); },
    postEvent: async (_id, body) => { notes.push(body); },
  };
  return { w, notes };
}

/**
 * A repo whose branch and base both changed the same line — the ISSUE-346
 * shape exactly: two branches cut from one commit, one merged first.
 */
function conflictingRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'crew-conflict-')));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  writeFileSync(join(dir, 'f.txt'), 'original\n');
  g('add', '.'); g('commit', '-qm', 'base');

  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'crew-conflict-wt-')));
  const wt = join(parent, 'issue-9');
  g('worktree', 'add', '-q', '-b', 'issue-9', wt);
  writeFileSync(join(wt, 'f.txt'), 'the branch version\n');
  execFileSync('git', ['commit', '-qam', 'branch change'], { cwd: wt, stdio: 'pipe' });

  return { dir, wt, g };
}

/** The same, except the branch and the base touched different files. */
function staleRepo() {
  const { dir, wt, g } = conflictingRepo();
  // Undo the conflicting change: touch a file main will not.
  execFileSync('git', ['checkout', '-q', 'HEAD~1', '--', 'f.txt'], { cwd: wt, stdio: 'pipe' });
  writeFileSync(join(wt, 'other.txt'), 'branch only\n');
  execFileSync('git', ['add', '.'], { cwd: wt, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qam', 'branch change elsewhere'], { cwd: wt, stdio: 'pipe' });
  return { dir, wt, g };
}

/** What ISSUE-350 did to main while the branch sat verified. */
const moveBase = (g: (...a: string[]) => Buffer, dir: string) => {
  writeFileSync(join(dir, 'f.txt'), 'the base version\n');
  g('commit', '-qam', 'base moved');
};

test('a stale branch is merged with the base and nothing is written to the board', async () => {
  const { dir, wt, g } = staleRepo();
  moveBase(g, dir);
  const { w, patches, notes } = writer();

  const b = planConflictBounce(dir, ticket(), 'issue-9', 'main', ['f.txt'], []);
  const out = await applyConflictBounce(w, b, DEFAULT_CONTRACT, 'seat', silent, false);

  assert.equal(out.kind, 'refreshed');
  assert.deepEqual(patches, [], 'a branch that was merely stale must not wake a lane');
  assert.deepEqual(notes, []);
  // The branch really did take the base's commit.
  const log = execFileSync('git', ['log', '--format=%s'], { cwd: wt, stdio: 'pipe' }).toString();
  assert.match(log, /base moved/);
});

test('a real conflict hands the ticket back and leaves the conflict in the worktree', async () => {
  const { dir, wt, g } = conflictingRepo();
  moveBase(g, dir);
  const { w, patches, notes } = writer();

  const b = planConflictBounce(dir, ticket(), 'issue-9', 'main', ['f.txt'], []);
  const out = await applyConflictBounce(w, b, DEFAULT_CONTRACT, 'seat', silent, false);

  assert.equal(out.kind, 'handed-back');
  assert.equal(patches[0]!.patch.status, DEFAULT_CONTRACT.statuses.building);
  assert.equal(patches[0]!.patch.assignee_id, null, 'cleared, so any ship may take it');
  assert.match(notes[0]!, /no longer merges/);
  assert.match(notes[0]!, /f\.txt/);

  // Left mid-merge on purpose: git status in that worktree is the whole story.
  const st = execFileSync('git', ['status', '--porcelain'], { cwd: wt, stdio: 'pipe' }).toString();
  assert.match(st, /^UU /m);
  assert.match(readFileSync(join(wt, 'f.txt'), 'utf8'), /<<<<<<</);
});

test('a branch built on another ship is handed back without touching git', async () => {
  const { dir, g } = conflictingRepo();
  moveBase(g, dir);
  const { w, patches, notes } = writer();

  // No worktree for this branch here — the shape when another ship built it.
  const b = planConflictBounce(dir, ticket(), 'issue-elsewhere', 'main', ['f.txt'], []);
  assert.equal(b.worktree, null);

  const out = await applyConflictBounce(w, b, DEFAULT_CONTRACT, 'seat', silent, false);
  assert.equal(out.kind, 'handed-back');
  assert.equal(patches[0]!.patch.status, DEFAULT_CONTRACT.statuses.building);
  assert.match(notes[0]!, /no worktree/i);
});

test('a hand-back never clobbers a ticket the board already moved since this run read it', async () => {
  const { dir, wt, g } = conflictingRepo();
  moveBase(g, dir);
  const { w, notes } = staleWriter();

  const b = planConflictBounce(dir, ticket(), 'issue-9', 'main', ['f.txt'], []);
  const out = await applyConflictBounce(w, b, DEFAULT_CONTRACT, 'seat', silent, false);

  assert.equal(out.kind, 'stale');
  assert.deepEqual(notes, [], 'no hand-back note either — nothing was actually handed back');
  // The merge conflict was still real and stays in the worktree either way.
  const st = execFileSync('git', ['status', '--porcelain'], { cwd: wt, stdio: 'pipe' }).toString();
  assert.match(st, /^UU /m);
});

test('conflicting a second time escalates instead of looping through the lanes', async () => {
  const { dir, g } = conflictingRepo();
  moveBase(g, dir);
  const { w, patches, notes } = writer();

  const already: RunnerEvent[] = [
    { record_id: 'row-1', event_type: 'conflict_handed_back', message: `${BOUNCE_MARKER}\nhanded back earlier`, occurred_at: '2026-01-01T00:00:00Z' },
    { record_id: 'row-1', event_type: 'pushed', occurred_at: '2026-01-02T00:00:00Z' },
  ];
  const b = planConflictBounce(dir, ticket(), 'issue-9', 'main', ['f.txt'], already);
  assert.equal(b.priorBounces, 1);

  const out = await applyConflictBounce(w, b, DEFAULT_CONTRACT, 'seat', silent, false);
  assert.equal(out.kind, 'escalated');
  assert.equal(patches[0]!.patch.status, DEFAULT_CONTRACT.statuses.needsHuman);
  assert.match(notes[0]!, /second time/);
});

test('an escalation never clobbers a ticket the board already moved since this run read it', async () => {
  const { dir, g } = conflictingRepo();
  moveBase(g, dir);
  const { w, notes } = staleWriter();

  const already: RunnerEvent[] = [
    { record_id: 'row-1', event_type: 'conflict_handed_back', message: `${BOUNCE_MARKER}\nhanded back earlier`, occurred_at: '2026-01-01T00:00:00Z' },
  ];
  const b = planConflictBounce(dir, ticket(), 'issue-9', 'main', ['f.txt'], already);

  const out = await applyConflictBounce(w, b, DEFAULT_CONTRACT, 'seat', silent, false);
  assert.equal(out.kind, 'stale');
  assert.deepEqual(notes, []);
});

test('a dirty worktree is handed back rather than merged into', async () => {
  const { dir, wt, g } = conflictingRepo();
  moveBase(g, dir);
  writeFileSync(join(wt, 'f.txt'), 'uncommitted work nobody has seen\n');
  const { w, patches } = writer();

  const b = planConflictBounce(dir, ticket(), 'issue-9', 'main', ['f.txt'], []);
  const out = await applyConflictBounce(w, b, DEFAULT_CONTRACT, 'seat', silent, false);

  assert.equal(out.kind, 'handed-back');
  assert.equal(patches[0]!.patch.status, DEFAULT_CONTRACT.statuses.building);
  assert.match(
    readFileSync(join(wt, 'f.txt'), 'utf8'), /uncommitted work/,
    'the uncommitted change must survive untouched',
  );
});

test('a dry run reports the hand-back and writes nothing, anywhere', async () => {
  const { dir, wt, g } = conflictingRepo();
  moveBase(g, dir);
  const { w, patches, notes } = writer();

  const b = planConflictBounce(dir, ticket(), 'issue-9', 'main', ['f.txt'], []);
  await applyConflictBounce(w, b, DEFAULT_CONTRACT, 'seat', silent, true);

  assert.deepEqual(patches, []);
  assert.deepEqual(notes, []);
  const st = execFileSync('git', ['status', '--porcelain'], { cwd: wt, stdio: 'pipe' }).toString();
  assert.equal(st.trim(), '', 'the worktree must be untouched by a dry run');
});

test('worktreeForBranch finds by branch, not by directory name', () => {
  const { dir, wt } = conflictingRepo();
  assert.equal(worktreeForBranch(dir, 'issue-9'), wt);
  assert.equal(worktreeForBranch(dir, 'issue-404'), null);
});

test('priorBounces counts only this ticket, and only conflict hand-back events', () => {
  const t = ticket();
  const events: RunnerEvent[] = [
    { record_id: 'row-1', event_type: 'conflict_handed_back', message: `${BOUNCE_MARKER}\nx` },
    { record_id: 'row-2', event_type: 'conflict_handed_back', message: `${BOUNCE_MARKER}\ny` },
    { record_id: 'row-1', event_type: 'stalled', message: 'a different runner event' },
    { record_id: 'row-1', event_type: 'pushed', occurred_at: '2026-01-02T00:00:00Z' },
    { record_id: 'row-2', event_type: 'pushed', occurred_at: '2026-01-02T00:00:00Z' },
  ];
  events[0]!.occurred_at = '2026-01-01T00:00:00Z';
  events[1]!.occurred_at = '2026-01-01T00:00:00Z';
  assert.equal(priorBounces(t, events), 1);
  // a hand-back no push has answered is not a failed fix
  assert.equal(priorBounces(t, events.slice(0, 1)), 0);
});

test('refreshBranch reports the paths the branch itself disagrees about', () => {
  const { dir, wt, g } = conflictingRepo();
  moveBase(g, dir);
  const r = refreshBranch(wt, 'main');
  assert.equal(r.clean, false);
  assert.deepEqual(r.paths, ['f.txt']);
});

test('refreshBranch refuses a branch that is behind its remote instead of calling it a conflict (CREW-1636)', () => {
  const { dir, wt, g } = conflictingRepo();
  // The "remote": a ref ahead of the worktree's branch, as a resolved push would be.
  g('branch', 'issue-9-up', 'issue-9');
  g('checkout', '-q', 'issue-9-up');
  g('commit', '--allow-empty', '-qm', 'resolved upstream');
  g('checkout', '-q', 'main');
  g('branch', '--set-upstream-to=issue-9-up', 'issue-9');
  moveBase(g, dir);
  const r = refreshBranch(wt, 'main');
  assert.equal(r.clean, false);
  assert.equal(r.behind, true);
  assert.deepEqual(r.paths, []);
});

/** A hand-back answered by a push, written against base tip `sha` (or none, for old events). */
const answered = (sha: string | null, n = 1): RunnerEvent[] =>
  Array.from({ length: n }, (_, i) => [
    { record_id: 'row-1', event_type: 'conflict_handed_back', message: `${BOUNCE_MARKER}\nearlier`, occurred_at: `2026-01-0${i * 2 + 1}T00:00:00Z`, ...(sha ? { metadata: { base_sha: sha } } : {}) },
    { record_id: 'row-1', event_type: 'pushed', occurred_at: `2026-01-0${i * 2 + 2}T00:00:00Z` },
  ]).flat();

/** The branch merged the base at `sha`, then the base moved again and conflicts (the TABL-2334 shape). */
function overtakenRepo() {
  const { dir, wt, g } = conflictingRepo();
  const sha = g('rev-parse', 'main').toString().trim();
  execFileSync('git', ['merge', '-q', '--no-edit', 'main'], { cwd: wt, stdio: 'pipe' });
  moveBase(g, dir);
  return { dir, wt, g, sha };
}

test('a second conflict after the lane absorbed the handed-back base is handed back again', async () => {
  const { dir, g, sha } = overtakenRepo();
  const { w, patches, notes } = writer();
  const metas: unknown[] = [];
  w.postEvent = async (_id, body, _m, _t, extra) => { notes.push(body); metas.push(extra); };

  const b = planConflictBounce(dir, ticket(), 'issue-9', 'main', ['f.txt'], answered(sha));
  assert.equal(b.priorBounces, 1);
  const out = await applyConflictBounce(w, b, DEFAULT_CONTRACT, 'seat', silent, false);

  assert.equal(out.kind, 'handed-back');
  assert.equal(patches[0]!.patch.status, DEFAULT_CONTRACT.statuses.building);
  const tip = g('rev-parse', 'main').toString().trim();
  assert.notEqual(tip, sha);
  assert.deepEqual(metas[0], { base_sha: tip, paths: ['f.txt'] });
  assert.match(notes[0]!, new RegExp(`Base tip: \`${tip}\``));
  // The merge is waiting in the worktree for the lane.
  const st = execFileSync('git', ['status', '--porcelain'], { cwd: b.worktree!, stdio: 'pipe' }).toString();
  assert.match(st, /^UU /m);
});

test('a hand-back whose base the branch never absorbed still escalates', async () => {
  const { dir, g } = conflictingRepo();
  g('commit', '-q', '--allow-empty', '-m', 'base advanced past the branch');
  const sha = g('rev-parse', 'main').toString().trim();
  moveBase(g, dir);
  const { w, patches } = writer();
  const b = planConflictBounce(dir, ticket(), 'issue-9', 'main', ['f.txt'], answered(sha));
  const out = await applyConflictBounce(w, b, DEFAULT_CONTRACT, 'seat', silent, false);
  assert.equal(out.kind, 'escalated');
  assert.equal(patches[0]!.patch.status, DEFAULT_CONTRACT.statuses.needsHuman);
});

test('a hand-back with no recorded base sha keeps the old escalation', async () => {
  const { dir } = overtakenRepo();
  const { w } = writer();
  const b = planConflictBounce(dir, ticket(), 'issue-9', 'main', ['f.txt'], answered(null));
  assert.equal(b.priorBaseSha, null);
  assert.equal((await applyConflictBounce(w, b, DEFAULT_CONTRACT, 'seat', silent, false)).kind, 'escalated');
});

test('the base sha is also read from the note when the event row carries no metadata', () => {
  const sha = 'a'.repeat(40);
  const [h] = answered(null);
  assert.equal(baseShaOf({ ...h!, message: `x\n\nBase tip: \`${sha}\`\n\ny` }), sha);
});

test('the third consecutive overtaken conflict escalates', async () => {
  const { dir, sha } = overtakenRepo();
  const { w, notes } = writer();
  const b = planConflictBounce(dir, ticket(), 'issue-9', 'main', ['f.txt'], answered(sha, 2));
  assert.equal(b.priorBounces, 2);
  const out = await applyConflictBounce(w, b, DEFAULT_CONTRACT, 'seat', silent, false);
  assert.equal(out.kind, 'escalated');
  assert.match(notes[0]!, /2 times/);
  assert.match(notes[0]!, /moved underneath/);
});

/** Another ticket handed back for a conflict in `paths`. */
const otherHandBack = (n: number, at: string, paths: string[]): RunnerEvent => ({
  record_id: `row-${n}`, event_type: 'conflict_handed_back', occurred_at: at, metadata: { paths },
});

test('a ticket in a conflict queue is handed back again past the usual limit, once per other ticket in it', async () => {
  const { dir, sha } = overtakenRepo();
  const { w, patches } = writer();
  // Two answered hand-backs already: alone, the third conflict escalates (the test above).
  const events = [...answered(sha, 2), otherHandBack(2, '2026-01-01T00:00:05Z', ['f.txt'])];
  const b = planConflictBounce(dir, ticket(), 'issue-9', 'main', ['f.txt'], events);
  assert.equal(b.priorBounces, 2);
  assert.equal(b.crowd, 1);
  const out = await applyConflictBounce(w, b, DEFAULT_CONTRACT, 'seat', silent, false);
  assert.equal(out.kind, 'handed-back');
  assert.equal(patches[0]!.patch.status, DEFAULT_CONTRACT.statuses.building);
});

test('the queue only absorbs as many extra hand-backs as it has other tickets', async () => {
  const { dir, sha } = overtakenRepo();
  const { w, notes } = writer();
  const events = [...answered(sha, 3), otherHandBack(2, '2026-01-01T00:00:05Z', ['f.txt'])];
  const b = planConflictBounce(dir, ticket(), 'issue-9', 'main', ['f.txt'], events);
  assert.equal(b.priorBounces, 3);
  const out = await applyConflictBounce(w, b, DEFAULT_CONTRACT, 'seat', silent, false);
  assert.equal(out.kind, 'escalated');
  assert.match(notes[0]!, /moved underneath/);
});

test('conflictCrowd counts other tickets handed back over a shared path around this ticket\'s own hand-backs', () => {
  const mine = answered('a'.repeat(40), 2);   // handed back 2026-01-01 and 2026-01-03
  const count = (others: RunnerEvent[], paths = ['f.txt']) => conflictCrowd(ticket(), paths, [...mine, ...others]);
  assert.equal(count([]), 0);
  // Same cycle (seconds earlier), and later: both are in the queue. Two events of one ticket count once.
  assert.equal(count([
    otherHandBack(2, '2025-12-31T23:59:58Z', ['f.txt']),
    otherHandBack(3, '2026-01-02T00:00:00Z', ['g.txt', 'f.txt']),
    otherHandBack(3, '2026-01-04T00:00:00Z', ['f.txt']),
  ]), 2);
  // Another file, or long before this ticket was first handed back: not this queue.
  assert.equal(count([otherHandBack(2, '2026-01-02T00:00:00Z', ['g.txt'])]), 0);
  assert.equal(count([otherHandBack(2, '2025-12-31T22:00:00Z', ['f.txt'])]), 0);
  // A hand-back that recorded no paths, a conflict that names none, a ticket never handed back.
  assert.equal(count([{ record_id: 'row-2', event_type: 'conflict_handed_back', occurred_at: '2026-01-02T00:00:00Z' }]), 0);
  assert.equal(count([otherHandBack(2, '2026-01-02T00:00:00Z', ['f.txt'])], []), 0);
  assert.equal(conflictCrowd(ticket(), ['f.txt'], [otherHandBack(2, '2026-01-02T00:00:00Z', ['f.txt'])]), 0);
});

test('the absorbed limit grows with the crowd up to a ceiling', () => {
  assert.equal(absorbedLimit({}), MAX_ABSORBED_HANDBACKS);
  assert.equal(absorbedLimit({ crowd: 3 }), MAX_ABSORBED_HANDBACKS + 3);
  assert.equal(absorbedLimit({ crowd: 500 }), MAX_CROWD_ABSORBED_HANDBACKS);
});

/** A writer that also records which event type each note was posted as, and its metadata. */
function queueWriter() {
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const events: Array<{ id: string; type?: string; body: string; extra?: Record<string, unknown> }> = [];
  const w: ConflictWriter = {
    updateTicket: async (id, patch) => { patches.push({ id, patch }); return {}; },
    postEvent: async (id, body, _m, type, extra) => { events.push({ id, type, body, extra }); },
  };
  return { w, patches, events };
}

const queueTicket = (n: number): Ticket => ticket({ id: `row-${n}`, issue_id: `ISSUE-${n}` });

/** Three conflicts in one cycle, on branches with no worktree here: 1 and 2 share a file, 3 is elsewhere. */
const threeConflicts = () => [
  { ticket: queueTicket(1), branch: 'issue-1', paths: ['app.js', 'test.js'] },
  { ticket: queueTicket(2), branch: 'issue-2', paths: ['test.js', 'page.html'] },
  { ticket: queueTicket(3), branch: 'issue-3', paths: ['other.js'] },
];

const settle = (w: ConflictWriter, over: Partial<Parameters<typeof settleConflicts>[0]> = {}) => settleConflicts({
  cwd: tmpdir(), base: 'main', conflicts: threeConflicts(), merged: [], events: [], writer: w,
  contract: DEFAULT_CONTRACT, memberId: 'seat', log: silent, dryRun: false, queueMinutes: 60, ...over,
});

test('conflicts in one cycle over the same file: the first is handed back, the rest queue behind it', async () => {
  const { w, patches, events } = queueWriter();
  const out = await settle(w);

  assert.deepEqual(out.map((s) => s.outcome.kind), ['handed-back', 'queued', 'handed-back']);
  // Only the heads moved on the board; the queued ticket stays verified.
  assert.deepEqual(patches.map((p) => p.id), ['row-1', 'row-3']);
  assert.ok(patches.every((p) => p.patch.status === DEFAULT_CONTRACT.statuses.building));
  // The queued ticket gets a waiting note naming the head and the shared file, not a hand-back.
  const mine = events.filter((e) => e.id === 'row-2');
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.type, DEFERRED_EVENT);
  assert.deepEqual(mine[0]!.extra, { waiting_for: 'row-1', paths: ['test.js'], queued: true });
  assert.match(mine[0]!.body, /ISSUE-1 conflicted in the same file in the same release and was handed back first/);
  assert.doesNotMatch(mine[0]!.body, new RegExp(BOUNCE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(events.filter((e) => e.type === 'conflict_handed_back').map((e) => e.id), ['row-1', 'row-3']);
});

test('a queued conflict is not counted as a hand-back, so it cannot push the ticket toward escalation', async () => {
  const { w, events } = queueWriter();
  await settle(w);
  const log: RunnerEvent[] = events.map((e) => ({ record_id: e.id, event_type: e.type ?? '', occurred_at: '2026-01-01T00:00:00Z' }));
  log.push({ record_id: 'row-2', event_type: 'pushed', occurred_at: '2026-01-02T00:00:00Z' });
  assert.equal(priorBounces(queueTicket(2), log), 0);
});

test('with the right of way turned off every conflict is handed back as before', async () => {
  const { w, patches } = queueWriter();
  const out = await settle(w, { queueMinutes: 0 });
  assert.deepEqual(out.map((s) => s.outcome.kind), ['handed-back', 'handed-back', 'handed-back']);
  assert.equal(patches.length, 3);
});

test('an escalated conflict heads no queue: the next branch on that file is handed back', async () => {
  const { w, patches } = queueWriter();
  // Ticket 1 was handed back before and answered, with no recorded base: it escalates.
  const events: RunnerEvent[] = [
    { record_id: 'row-1', event_type: 'conflict_handed_back', occurred_at: '2026-01-01T00:00:00Z' },
    { record_id: 'row-1', event_type: 'pushed', occurred_at: '2026-01-02T00:00:00Z' },
  ];
  const out = await settle(w, { events });
  assert.deepEqual(out.map((s) => s.outcome.kind), ['escalated', 'handed-back', 'handed-back']);
  assert.equal(patches[0]!.patch.status, DEFAULT_CONTRACT.statuses.needsHuman);
});

test('a dry run reports the queue and writes nothing', async () => {
  const { w, patches, events } = queueWriter();
  const lines: string[] = [];
  const out = await settle(w, { dryRun: true, log: { emit: (m) => { lines.push(m); }, warn: () => {} } });
  assert.deepEqual(out.map((s) => s.outcome.kind), ['handed-back', 'queued', 'handed-back']);
  assert.deepEqual([patches, events], [[], []]);
  assert.ok(lines.some((l) => /would leave ISSUE-2 at verified, not handed back/.test(l)));
});

test('one ticket failing to settle does not stop the rest', async () => {
  const { w, patches } = queueWriter();
  let first = true;
  const update = w.updateTicket;
  w.updateTicket = async (id, patch, stamp) => { if (first) { first = false; throw new Error('tracker down'); } return update(id, patch, stamp); };
  const out = await settle(w);
  assert.deepEqual(out.map((s) => s.outcome.kind), ['failed', 'handed-back', 'handed-back']);
  assert.deepEqual(patches.map((p) => p.id), ['row-2', 'row-3']);
});

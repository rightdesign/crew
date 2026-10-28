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
  priorBounces, baseShaOf, BOUNCE_MARKER, type ConflictWriter, type ConflictLog,
} from '../src/conflict.ts';
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
  assert.equal(notes.length, 1, 'the merge is recorded as an event');
  assert.match(notes[0]!, /^merged main at [0-9a-f]{8}/);
  assert.match(notes[0]!, /earlier verification still stands/, 'no file overlap with the ticket');
  assert.deepEqual(out.kind === 'refreshed' && out.merge?.overlap, []);
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
  assert.deepEqual(metas[0], { base_sha: tip });
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

test('a clean merge is pushed, and a non-overlapping one advances verified_sha', async () => {
  const { dir, wt, g } = staleRepo();
  const remote = realpathSync(mkdtempSync(join(tmpdir(), 'crew-conflict-remote-')));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: remote, stdio: 'pipe' });
  g('remote', 'add', 'origin', remote);
  execFileSync('git', ['push', '-q', '-u', 'origin', 'issue-9'], { cwd: wt, stdio: 'pipe' });
  moveBase(g, dir);
  const { w, patches, notes } = writer();
  const t = ticket({ verified_sha: 'old' } as Partial<Ticket>);

  const b = { ...planConflictBounce(dir, t, 'issue-9', 'main', [], []), remote: 'origin' };
  const out = await applyConflictBounce(w, b, DEFAULT_CONTRACT, 'seat', silent, false);

  assert.equal(out.kind, 'refreshed');
  const tip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, stdio: 'pipe' }).toString().trim();
  const remoteTip = execFileSync('git', ['rev-parse', 'issue-9'], { cwd: remote, stdio: 'pipe' }).toString().trim();
  assert.equal(remoteTip, tip, 'pushed as a plain fast-forward');
  assert.equal(patches.length, 1);
  assert.equal(patches[0]!.patch[DEFAULT_CONTRACT.columns.verifiedSha], tip);
  assert.match(notes[0]!, /pushed to origin\/issue-9/);
});

test('a clean merge that touches the ticket\'s own file leaves verified_sha alone and names the file', async () => {
  const { dir, wt, g } = staleRepo();
  const remote = realpathSync(mkdtempSync(join(tmpdir(), 'crew-conflict-remote-')));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: remote, stdio: 'pipe' });
  g('remote', 'add', 'origin', remote);
  // Branch edits the tail of a long file, main edits the head: textually clean, same path.
  const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);
  writeFileSync(join(dir, 'long.txt'), lines.join('\n') + '\n');
  g('add', '.'); g('commit', '-qm', 'add long');
  execFileSync('git', ['merge', '-q', 'main'], { cwd: wt, stdio: 'pipe' });
  writeFileSync(join(wt, 'long.txt'), lines.slice(0, 29).concat('branch tail').join('\n') + '\n');
  execFileSync('git', ['commit', '-qam', 'branch edits tail'], { cwd: wt, stdio: 'pipe' });
  execFileSync('git', ['push', '-q', '-u', 'origin', 'issue-9'], { cwd: wt, stdio: 'pipe' });
  writeFileSync(join(dir, 'long.txt'), ['main head'].concat(lines.slice(1)).join('\n') + '\n');
  g('commit', '-qam', 'main edits head');
  const { w, patches, notes } = writer();
  const t = ticket({ verified_sha: 'old' } as Partial<Ticket>);

  const b = { ...planConflictBounce(dir, t, 'issue-9', 'main', [], []), remote: 'origin' };
  const out = await applyConflictBounce(w, b, DEFAULT_CONTRACT, 'seat', silent, false);

  assert.equal(out.kind, 'refreshed');
  assert.deepEqual(patches, []);
  assert.match(notes[0]!, /`long\.txt`/);
  assert.match(notes[0]!, /QA re-verifies/);
});

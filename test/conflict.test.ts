import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import {
  planConflictBounce, applyConflictBounce, refreshBranch, worktreeForBranch,
  priorBounces, BOUNCE_MARKER, type ConflictWriter, type ConflictLog,
} from '../src/conflict.ts';
import type { Ticket, Comment } from '../src/tracker.ts';

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

test('conflicting a second time escalates instead of looping through the lanes', async () => {
  const { dir, g } = conflictingRepo();
  moveBase(g, dir);
  const { w, patches, notes } = writer();

  const already: Comment[] = [
    { id: 'c1', ticket_id: 'row-1', body: `${BOUNCE_MARKER}\nhanded back earlier`, created_at: '2026-01-01T00:00:00Z' } as Comment,
  ];
  const b = planConflictBounce(dir, ticket(), 'issue-9', 'main', ['f.txt'], already);
  assert.equal(b.priorBounces, 1);

  const out = await applyConflictBounce(w, b, DEFAULT_CONTRACT, 'seat', silent, false);
  assert.equal(out.kind, 'escalated');
  assert.equal(patches[0]!.patch.status, DEFAULT_CONTRACT.statuses.needsHuman);
  assert.match(notes[0]!, /second time/);
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

test('priorBounces counts only this ticket, and only crew hand-back notes', () => {
  const t = ticket();
  const comments = [
    { id: 'a', ticket_id: 'row-1', body: `${BOUNCE_MARKER}\nx`, created_at: '' },
    { id: 'b', ticket_id: 'row-2', body: `${BOUNCE_MARKER}\ny`, created_at: '' },
    { id: 'c', ticket_id: 'row-1', body: 'a person talking about a merge conflict', created_at: '' },
  ] as Comment[];
  assert.equal(priorBounces(t, comments), 1);
});

test('refreshBranch reports the paths the branch itself disagrees about', () => {
  const { dir, wt, g } = conflictingRepo();
  moveBase(g, dir);
  const r = refreshBranch(wt, 'main');
  assert.equal(r.clean, false);
  assert.deepEqual(r.paths, ['f.txt']);
});

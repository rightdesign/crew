import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import { planWorktreeSweep, applyWorktreeSweep, type SweepLog } from '../src/worktree-sweep.ts';
import type { Ticket } from '../src/tracker.ts';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-sweep-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  writeFileSync(join(dir, 'README.md'), 'x');
  g('add', '.'); g('commit', '-qm', 'base');
  return { dir, g };
}

const branchesOf = (dir: string): string[] =>
  execFileSync('git', ['branch', '--list', '--format=%(refname:short)'], { cwd: dir, stdio: 'pipe' })
    .toString().trim().split('\n').filter(Boolean);

const silentLog: SweepLog = { emit: () => {}, warn: () => {} };

const ticket = (over: Partial<Ticket>): Ticket => ({
  id: over.issue_id ?? 'x', issue_id: 'ISSUE-1', status: 'closed_deployed',
  updated_at: '2026-01-01T00:00:00Z', ...over,
});

/** One worktree, cut beside a fresh temp parent so nothing collides. */
function withWorktree(dir: string, g: (...a: string[]) => Buffer, n: number, branch = `issue-${n}`) {
  const parent = mkdtempSync(join(tmpdir(), 'crew-sweep-parent-'));
  const wt = join(parent, `proj-issue-${n}`);
  g('worktree', 'add', '-q', '-b', branch, wt);
  return { target: { name: 'proj', dir }, wt };
}

test('a deployed ticket: the worktree is removed AND the branch deleted', async () => {
  const { dir, g } = repo();
  const { target, wt } = withWorktree(dir, g, 9);
  const t = ticket({ issue_id: 'ISSUE-9', status: 'closed_deployed' });

  const actions = planWorktreeSweep(target, [t], DEFAULT_CONTRACT, 'proj-issue-');
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.branch, 'issue-9');
  assert.equal(actions[0]!.keepBranch, false);

  const r = await applyWorktreeSweep(dir, actions, false, silentLog);
  assert.deepEqual(r, { removed: 1, keptBranches: 0 });
  assert.ok(!existsSync(wt));
  assert.ok(!branchesOf(dir).includes('issue-9'));
});

test('closed_wont_fix: the worktree goes but the branch is kept — it holds work never merged', async () => {
  const { dir, g } = repo();
  const { target, wt } = withWorktree(dir, g, 10);
  const t = ticket({ issue_id: 'ISSUE-10', status: 'closed_wont_fix' });

  const actions = planWorktreeSweep(target, [t], DEFAULT_CONTRACT, 'proj-issue-');
  assert.equal(actions[0]!.keepBranch, true);

  const r = await applyWorktreeSweep(dir, actions, false, silentLog);
  assert.deepEqual(r, { removed: 1, keptBranches: 1 });
  assert.ok(!existsSync(wt));
  assert.ok(branchesOf(dir).includes('issue-10'));
});

test('closed_duplicate behaves the same as wont_fix: branch kept, worktree removed', async () => {
  const { dir, g } = repo();
  const { target, wt } = withWorktree(dir, g, 11);
  const t = ticket({ issue_id: 'ISSUE-11', status: 'closed_duplicate' });

  const actions = planWorktreeSweep(target, [t], DEFAULT_CONTRACT, 'proj-issue-');
  assert.equal(actions[0]!.keepBranch, true);
  await applyWorktreeSweep(dir, actions, false, silentLog);
  assert.ok(!existsSync(wt));
  assert.ok(branchesOf(dir).includes('issue-11'));
});

test('verified is excluded — still pre-release, the release phase needs this worktree next', async () => {
  const { dir, g } = repo();
  const { target, wt } = withWorktree(dir, g, 12);
  const t = ticket({ issue_id: 'ISSUE-12', status: 'verified' });

  const actions = planWorktreeSweep(target, [t], DEFAULT_CONTRACT, 'proj-issue-');
  assert.deepEqual(actions, []);
  assert.ok(existsSync(wt));
});

test('an open ticket (fixed, awaiting QA) is left alone', async () => {
  const { dir, g } = repo();
  const { target, wt } = withWorktree(dir, g, 13);
  const t = ticket({ issue_id: 'ISSUE-13', status: 'fixed' });

  const actions = planWorktreeSweep(target, [t], DEFAULT_CONTRACT, 'proj-issue-');
  assert.deepEqual(actions, []);
  assert.ok(existsSync(wt));
});

test('a worktree with no matching ticket in the fetched set is left alone', async () => {
  const { dir, g } = repo();
  const { target, wt } = withWorktree(dir, g, 14);

  const actions = planWorktreeSweep(target, [], DEFAULT_CONTRACT, 'proj-issue-');
  assert.deepEqual(actions, []);
  assert.ok(existsSync(wt));
});

test('dry run reports what it would do and touches nothing', async () => {
  const { dir, g } = repo();
  const { target, wt } = withWorktree(dir, g, 15);
  const t = ticket({ issue_id: 'ISSUE-15', status: 'closed_deployed' });
  const actions = planWorktreeSweep(target, [t], DEFAULT_CONTRACT, 'proj-issue-');

  const messages: string[] = [];
  const r = await applyWorktreeSweep(dir, actions, true, { emit: (m) => messages.push(m), warn: () => {} });

  assert.deepEqual(r, { removed: 0, keptBranches: 0 });
  assert.ok(existsSync(wt));
  assert.ok(branchesOf(dir).includes('issue-15'));
  assert.ok(messages.some((m) => /would remove worktree/.test(m) && /deleting branch/.test(m)));
});

test('the branch template is irrelevant — the sweep uses the branch actually checked out', async () => {
  // A repo renamed its branch template after this worktree was cut, or the
  // ticket's title (and so its {slug}) drifted since. Re-deriving the name
  // from today's template would miss the branch entirely; reading it off
  // `git worktree list` cannot.
  const { dir, g } = repo();
  const { target, wt } = withWorktree(dir, g, 16, 'bc/issue-16-old-title');
  const t = ticket({ issue_id: 'ISSUE-16', title: 'A brand new title', status: 'closed_deployed' });

  const actions = planWorktreeSweep(target, [t], DEFAULT_CONTRACT, 'proj-issue-');
  assert.equal(actions[0]!.branch, 'bc/issue-16-old-title');
  await applyWorktreeSweep(dir, actions, false, silentLog);
  assert.ok(!existsSync(wt));
  assert.ok(!branchesOf(dir).includes('bc/issue-16-old-title'));
});

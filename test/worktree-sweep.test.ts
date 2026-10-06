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

  const actions = planWorktreeSweep(target, [t], DEFAULT_CONTRACT);
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

  const actions = planWorktreeSweep(target, [t], DEFAULT_CONTRACT);
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

  const actions = planWorktreeSweep(target, [t], DEFAULT_CONTRACT);
  assert.equal(actions[0]!.keepBranch, true);
  await applyWorktreeSweep(dir, actions, false, silentLog);
  assert.ok(!existsSync(wt));
  assert.ok(branchesOf(dir).includes('issue-11'));
});

test('verified (CREW-1405): the worktree is planned for removal but the branch is kept and it must be pushed', async () => {
  const { dir, g } = repo();
  const { target, wt } = withWorktree(dir, g, 12);
  const t = ticket({ issue_id: 'ISSUE-12', status: 'verified' });

  const actions = planWorktreeSweep(target, [t], DEFAULT_CONTRACT);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.keepBranch, true);
  assert.equal(actions[0]!.requirePushed, true);

  // No remote configured: nothing it could be missing from.
  await applyWorktreeSweep(dir, actions, false, silentLog);
  assert.ok(!existsSync(wt));
  assert.ok(branchesOf(dir).includes('issue-12'));
});

test('verified: a worktree with commits missing from the remote is left alone', async () => {
  const { dir, g } = repo();
  const bare = mkdtempSync(join(tmpdir(), 'crew-sweep-bare-'));
  execFileSync('git', ['init', '-q', '--bare', bare]);
  g('remote', 'add', 'origin', bare);
  g('push', '-q', 'origin', 'main');
  const { target, wt } = withWorktree(dir, g, 15);
  const gw = (...a: string[]) => execFileSync('git', a, { cwd: wt, stdio: 'pipe' });
  gw('push', '-q', '--set-upstream', 'origin', 'issue-15');
  const t = ticket({ issue_id: 'ISSUE-15', status: 'verified' });

  writeFileSync(join(wt, 'x.txt'), 'x');
  gw('add', '.'); gw('-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-qm', 'unpushed');
  const warnings: string[] = [];
  const log: SweepLog = { emit: () => {}, warn: (m) => { warnings.push(m); } };
  let r = await applyWorktreeSweep(dir, planWorktreeSweep(target, [t], DEFAULT_CONTRACT), false, log);
  assert.equal(r.removed, 0);
  assert.ok(existsSync(wt));
  assert.match(warnings.join('\n'), /not on origin/);

  gw('push', '-q');
  r = await applyWorktreeSweep(dir, planWorktreeSweep(target, [t], DEFAULT_CONTRACT), false, silentLog);
  assert.equal(r.removed, 1);
  assert.ok(!existsSync(wt));
  assert.ok(branchesOf(dir).includes('issue-15'));
});

test('an open ticket (fixed, awaiting QA) is left alone', async () => {
  const { dir, g } = repo();
  const { target, wt } = withWorktree(dir, g, 13);
  const t = ticket({ issue_id: 'ISSUE-13', status: 'fixed' });

  const actions = planWorktreeSweep(target, [t], DEFAULT_CONTRACT);
  assert.deepEqual(actions, []);
  assert.ok(existsSync(wt));
});

test('a worktree with no matching ticket in the fetched set is left alone', async () => {
  const { dir, g } = repo();
  const { target, wt } = withWorktree(dir, g, 14);

  const actions = planWorktreeSweep(target, [], DEFAULT_CONTRACT);
  assert.deepEqual(actions, []);
  assert.ok(existsSync(wt));
});

test('dry run reports what it would do and touches nothing', async () => {
  const { dir, g } = repo();
  const { target, wt } = withWorktree(dir, g, 15);
  const t = ticket({ issue_id: 'ISSUE-15', status: 'closed_deployed' });
  const actions = planWorktreeSweep(target, [t], DEFAULT_CONTRACT);

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

  const actions = planWorktreeSweep(target, [t], DEFAULT_CONTRACT);
  assert.equal(actions[0]!.branch, 'bc/issue-16-old-title');
  await applyWorktreeSweep(dir, actions, false, silentLog);
  assert.ok(!existsSync(wt));
  assert.ok(!branchesOf(dir).includes('bc/issue-16-old-title'));
});

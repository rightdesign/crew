import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import {
  planWorktreeSweep, applyWorktreeSweep, planLocalBranchCleanup, applyLocalBranchCleanup,
  sweepCandidatesExist, worktreeTicketNumbers, orphanedWorktreeDirs, type SweepLog,
} from '../src/worktree-sweep.ts';
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

// CREW-1592: the builder is not always the releaser, and a branch whose worktree
// is already gone was reaped by nothing.
test('a deployed ticket with a local branch and no worktree ends with the branch gone', () => {
  const { dir, g } = repo();
  g('branch', 'issue-20'); g('branch', 'tabl-21-some-slug'); g('branch', 'v2'); g('branch', 'issue-22');
  const tickets = [
    ticket({ issue_id: 'ISSUE-20', status: 'closed_deployed' }),
    ticket({ issue_id: 'TABL-21', status: 'closed_deployed', project_issue_prefix: 'TABL' }),
    ticket({ issue_id: 'ISSUE-22', status: 'closed_wont_fix' }),
  ];
  const doomed = planLocalBranchCleanup(dir, 'main', tickets, DEFAULT_CONTRACT);
  assert.deepEqual(doomed.sort(), ['issue-20', 'tabl-21-some-slug']);
  assert.equal(applyLocalBranchCleanup(dir, doomed, false, silentLog), 2);
  assert.deepEqual(branchesOf(dir).sort(), ['issue-22', 'main', 'v2']);
});

test('a deployed ticket\'s branch still checked out in a worktree is not planned for deletion here', () => {
  const { dir, g } = repo();
  withWorktree(dir, g, 23);
  const t = ticket({ issue_id: 'ISSUE-23', status: 'closed_deployed' });
  assert.deepEqual(planLocalBranchCleanup(dir, 'main', [t], DEFAULT_CONTRACT), []);
});

test('sweepCandidatesExist is false for a clean checkout and true for a ticket worktree or branch', () => {
  const { dir, g } = repo();
  assert.equal(sweepCandidatesExist(dir, 'main'), false);
  g('branch', 'feature-x');
  assert.equal(sweepCandidatesExist(dir, 'main'), false);
  g('branch', 'issue-30');
  assert.equal(sweepCandidatesExist(dir, 'main'), true);
  const other = repo();
  withWorktree(other.dir, other.g, 31, 'whatever');
  assert.equal(sweepCandidatesExist(other.dir, 'main'), true);
});

test('a clean worktree of a deployed ticket is swept even though this ship released nothing', async () => {
  // The sweep is driven by tickets and the checkout alone, never by a release.
  const { dir, g } = repo();
  const { target, wt } = withWorktree(dir, g, 24);
  const t = ticket({ issue_id: 'ISSUE-24', status: 'closed_deployed' });
  assert.equal(sweepCandidatesExist(dir, 'main'), true);
  await applyWorktreeSweep(dir, planWorktreeSweep(target, [t], DEFAULT_CONTRACT), false, silentLog);
  assert.ok(!existsSync(wt));
  assert.ok(!branchesOf(dir).includes('issue-24'));
});

// CREW-2050: crew's own hand-back merge, suffixed/detached worktrees, failed removals.

/** Leaves `wt` mid-merge of `main` into its branch, conflicted, as refreshBranch does. */
function handBackMerge(dir: string, g: (...a: string[]) => Buffer, wt: string, branch: string) {
  const gw = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...a], { cwd: wt, stdio: 'pipe' });
  writeFileSync(join(wt, 'README.md'), 'branch side'); gw('commit', '-qam', 'branch');
  writeFileSync(join(dir, 'README.md'), 'main side'); g('-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-qam', 'main moved');
  assert.throws(() => gw('merge', '--no-edit', 'main'));
  assert.ok(readFileSync(join(wt, 'README.md'), 'utf8').includes('<<<<<<<'));
  void branch;
}

test('a deployed ticket\'s hand-back merge is aborted and the worktree removed', async () => {
  const { dir, g } = repo();
  const { target, wt } = withWorktree(dir, g, 40);
  handBackMerge(dir, g, wt, 'issue-40');
  const t = ticket({ issue_id: 'ISSUE-40', status: 'closed_deployed' });
  const messages: string[] = [];
  const r = await applyWorktreeSweep(dir, planWorktreeSweep(target, [t], DEFAULT_CONTRACT), false,
    { emit: (m) => messages.push(m), warn: () => {} }, 'origin', 'main');
  assert.equal(r.removed, 1);
  assert.ok(!existsSync(wt));
  assert.ok(messages.some((m) => /abandoned the hand-back merge/.test(m)));
});

test('a deployed ticket\'s hand-back merge with an earlier uncommitted edit is refused after the abort', async () => {
  const { dir, g } = repo();
  const { target, wt } = withWorktree(dir, g, 41);
  writeFileSync(join(wt, 'mine.txt'), 'uncommitted');
  const gw = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...a], { cwd: wt, stdio: 'pipe' });
  writeFileSync(join(wt, 'README.md'), 'branch side'); gw('commit', '-qam', 'branch');
  writeFileSync(join(dir, 'README.md'), 'main side'); g('-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-qam', 'main moved');
  assert.throws(() => gw('merge', '--no-edit', 'main'));
  const warnings: string[] = [];
  const t = ticket({ issue_id: 'ISSUE-41', status: 'closed_deployed' });
  const r = await applyWorktreeSweep(dir, planWorktreeSweep(target, [t], DEFAULT_CONTRACT), false,
    { emit: () => {}, warn: (m) => warnings.push(m) }, 'origin', 'main');
  assert.equal(r.removed, 0);
  assert.ok(existsSync(join(wt, 'mine.txt')));
  assert.match(warnings.join('\n'), /uncommitted changes/);
});

test('a verified ticket\'s hand-back merge is left alone', async () => {
  const { dir, g } = repo();
  const { target, wt } = withWorktree(dir, g, 42);
  handBackMerge(dir, g, wt, 'issue-42');
  const t = ticket({ issue_id: 'ISSUE-42', status: 'verified' });
  const r = await applyWorktreeSweep(dir, planWorktreeSweep(target, [t], DEFAULT_CONTRACT), false, silentLog, 'origin', 'main');
  assert.equal(r.removed, 0);
  assert.ok(existsSync(wt));
  assert.ok(readFileSync(join(wt, 'README.md'), 'utf8').includes('<<<<<<<'));
});

test('a clean detached worktree with a -qa suffix is swept for a deployed ticket only', async () => {
  const { dir, g } = repo();
  const parent = mkdtempSync(join(tmpdir(), 'crew-sweep-parent-'));
  const done = join(parent, 'proj-issue-50-qa');
  const open = join(parent, 'proj-issue-51-qa');
  g('worktree', 'add', '-q', '--detach', done); g('worktree', 'add', '-q', '--detach', open);
  const target = { name: 'proj', dir };
  const tickets = [
    ticket({ issue_id: 'ISSUE-50', status: 'closed_deployed' }),
    ticket({ issue_id: 'ISSUE-51', status: 'in_progress' }),
  ];
  assert.deepEqual(worktreeTicketNumbers(target).sort(), ['50', '51']);
  const r = await applyWorktreeSweep(dir, planWorktreeSweep(target, tickets, DEFAULT_CONTRACT), false, silentLog);
  assert.equal(r.removed, 1);
  assert.ok(!existsSync(done));
  assert.ok(existsSync(open));
});

test('a worktree on the ticket\'s branch is swept whatever its directory is called', async () => {
  const { dir, g } = repo();
  const parent = mkdtempSync(join(tmpdir(), 'crew-sweep-parent-'));
  const wt = join(parent, 'scratch');
  g('worktree', 'add', '-q', '-b', 'issue-52', wt);
  const target = { name: 'proj', dir };
  assert.deepEqual(worktreeTicketNumbers(target), ['52']);
  const t = ticket({ issue_id: 'ISSUE-52', status: 'closed_deployed' });
  const r = await applyWorktreeSweep(dir, planWorktreeSweep(target, [t], DEFAULT_CONTRACT), false, silentLog);
  assert.equal(r.removed, 1);
  assert.ok(!existsSync(wt));
});

test('a failing worktree remove warns, is not counted and keeps the branch', async () => {
  const { dir, g } = repo();
  const { target, wt } = withWorktree(dir, g, 53);
  const t = ticket({ issue_id: 'ISSUE-53', status: 'closed_deployed' });
  const actions = planWorktreeSweep(target, [t], DEFAULT_CONTRACT);
  // Locked worktrees are refused by a single --force.
  g('worktree', 'lock', wt);
  const warnings: string[] = []; const emitted: string[] = [];
  const r = await applyWorktreeSweep(dir, actions, false, { emit: (m) => emitted.push(m), warn: (m) => warnings.push(m) });
  assert.equal(r.removed, 0);
  assert.ok(existsSync(wt));
  assert.ok(branchesOf(dir).includes('issue-53'));
  assert.match(warnings.join('\n'), /could not remove worktree/);
  assert.ok(!emitted.some((m) => /removed worktree/.test(m)));
});

test('an unregistered sibling directory of a deployed ticket is reported, not deleted', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-sweep-orphan-'));
  const dir = join(parent, 'proj');
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const orphan = join(parent, 'proj-tabl-60'); mkdirSync(orphan);
  mkdirSync(join(parent, 'proj-tabl-61'));
  mkdirSync(join(parent, 'other-tabl-60'));
  const target = { name: 'proj', dir };
  assert.deepEqual(worktreeTicketNumbers(target).sort(), ['60', '61']);
  assert.equal(sweepCandidatesExist(dir, 'main'), true);
  const tickets = [ticket({ issue_id: 'TABL-60', status: 'closed_deployed' }), ticket({ issue_id: 'TABL-61', status: 'in_progress' })];
  assert.deepEqual(orphanedWorktreeDirs(target, tickets, DEFAULT_CONTRACT), [orphan]);
  assert.ok(existsSync(orphan));
});

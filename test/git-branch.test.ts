import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { branchForIssue, worktreeForNumber } from '../src/git.ts';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-branch-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  mkdirSync(join(dir, '.keep'));
  g('commit', '--allow-empty', '-qm', 'base');
  return { dir, g };
}

test('branchForIssue: a tagged repo still finds a ticket left on the old plain issue-{number} branch', () => {
  // ISSUE-969: the default template for THIS repo is now {prefix}-{number}
  // for a tagged ticket, but a branch cut before the workspace adopted tags
  // is still sitting on the legacy name — the templated candidates alone
  // would miss it.
  const { dir, g } = repo();
  g('branch', 'issue-946');
  const found = branchForIssue(dir, 'ISSUE-946', { name: '{prefix}-{number}' },
    (t) => t.replace('{prefix}', 'tabl').replace('{number}', '946'));
  assert.equal(found, 'issue-946');
});

test('branchForIssue: the templated candidate still wins when it exists', () => {
  const { dir, g } = repo();
  g('branch', 'tabl-946');
  g('branch', 'issue-946');
  const found = branchForIssue(dir, 'ISSUE-946', { name: '{prefix}-{number}' },
    (t) => t.replace('{prefix}', 'tabl').replace('{number}', '946'));
  assert.equal(found, 'tabl-946');
});

test('worktreeForNumber finds a worktree by its trailing ticket number, whatever scheme named it', () => {
  const { dir, g } = repo();
  const parent = mkdtempSync(join(tmpdir(), 'crew-branch-parent-'));
  const wt = join(parent, 'synthesis-issue-946');
  g('worktree', 'add', '-q', '-b', 'issue-946', wt);
  const found = worktreeForNumber(dir, '946');
  assert.equal(found && basename(found.path), basename(wt));
  assert.equal(found?.branch, 'issue-946');
});

test('worktreeForNumber does not match a different ticket that merely shares a trailing digit run', () => {
  const { dir, g } = repo();
  const parent = mkdtempSync(join(tmpdir(), 'crew-branch-parent-'));
  g('worktree', 'add', '-q', '-b', 'issue-9946', join(parent, 'tabl-9946'));
  assert.equal(worktreeForNumber(dir, '946'), null);
});

// CREW-1364: a branch built on another ship exists here only on the remote.
import { remoteBranchForIssue, materializeRemoteBranch, levelRemoteBranch, deleteRemoteBranch, fetchRemote } from '../src/git.ts';
import { planRemoteBranchCleanup, remoteBranchTicketNumbers } from '../src/worktree-sweep.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import type { Ticket } from '../src/tracker.ts';

/** `shipA` pushes ticket branches to a bare origin; `shipB` is a second clone that has never seen them. */
function twoShips() {
  const root = mkdtempSync(join(tmpdir(), 'crew-ships-'));
  const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();
  const origin = join(root, 'origin.git');
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const clone = (name: string) => {
    const d = join(root, name);
    sh(root, 'clone', '-q', origin, d);
    sh(d, 'config', 'user.email', 't@t'); sh(d, 'config', 'user.name', 'T');
    return d;
  };
  const shipA = clone('a');
  sh(shipA, 'checkout', '-q', '-b', 'main');
  sh(shipA, 'commit', '--allow-empty', '-qm', 'base');
  sh(shipA, 'push', '-q', '-u', 'origin', 'main');
  const shipB = clone('b');
  return { shipA, shipB, sh };
}

test('remoteBranchForIssue: finds a branch only the remote has, under either naming scheme', () => {
  const { shipA, shipB, sh } = twoShips();
  sh(shipA, 'branch', 'tcli-1359');
  sh(shipA, 'push', '-q', '--set-upstream', 'origin', 'tcli-1359');
  // Not fetched yet: invisible, which is the bug.
  assert.equal(remoteBranchForIssue(shipB, 'origin', 'ISSUE-1359', { name: 'issue-{number}' }), null);
  fetchRemote(shipB);
  // This ship's own template says issue-{number}; the branch was cut as tcli-1359.
  const render = (t: string) => t.replace('{prefix}', 'tcli').replace('{number}', '1359');
  assert.equal(remoteBranchForIssue(shipB, 'origin', 'ISSUE-1359', { name: '{prefix}-{number}' }, render), 'tcli-1359');
  // And the legacy name resolves too.
  sh(shipA, 'branch', 'issue-77');
  sh(shipA, 'push', '-q', 'origin', 'issue-77');
  fetchRemote(shipB);
  assert.equal(remoteBranchForIssue(shipB, 'origin', 'ISSUE-77'), 'issue-77');
});

test('materializeRemoteBranch: creates a tracking branch, then fast-forwards it, without a worktree', () => {
  const { shipA, shipB, sh } = twoShips();
  sh(shipA, 'checkout', '-q', '-b', 'tabl-5');
  sh(shipA, 'commit', '--allow-empty', '-qm', 'one');
  sh(shipA, 'push', '-q', '--set-upstream', 'origin', 'tabl-5');
  fetchRemote(shipB);
  assert.equal(materializeRemoteBranch(shipB, 'origin', 'tabl-5'), true);
  assert.equal(sh(shipB, 'rev-parse', 'tabl-5'), sh(shipA, 'rev-parse', 'tabl-5'));

  // A bounce-and-fix pushes again; the local copy follows.
  sh(shipA, 'commit', '--allow-empty', '-qm', 'two');
  sh(shipA, 'push', '-q', 'origin', 'tabl-5');
  fetchRemote(shipB);
  assert.equal(materializeRemoteBranch(shipB, 'origin', 'tabl-5'), true);
  assert.equal(sh(shipB, 'rev-parse', 'tabl-5'), sh(shipA, 'rev-parse', 'tabl-5'));
});

test('materializeRemoteBranch: leaves a diverged local branch alone', () => {
  const { shipA, shipB, sh } = twoShips();
  sh(shipA, 'checkout', '-q', '-b', 'tabl-6');
  sh(shipA, 'push', '-q', '--set-upstream', 'origin', 'tabl-6');
  fetchRemote(shipB);
  materializeRemoteBranch(shipB, 'origin', 'tabl-6');
  sh(shipB, 'checkout', '-q', 'tabl-6');
  sh(shipB, 'commit', '--allow-empty', '-qm', 'local only');
  sh(shipB, 'checkout', '-q', 'main');
  sh(shipA, 'commit', '--allow-empty', '-qm', 'remote only');
  sh(shipA, 'push', '-q', 'origin', 'tabl-6');
  fetchRemote(shipB);
  const before = sh(shipB, 'rev-parse', 'tabl-6');
  materializeRemoteBranch(shipB, 'origin', 'tabl-6');
  assert.equal(sh(shipB, 'rev-parse', 'tabl-6'), before);
});

test('levelRemoteBranch: fast-forwards a branch a clean worktree holds (CREW-1636)', () => {
  const { shipA, shipB, sh } = twoShips();
  sh(shipA, 'checkout', '-q', '-b', 'tabl-7');
  sh(shipA, 'push', '-q', '--set-upstream', 'origin', 'tabl-7');
  fetchRemote(shipB);
  materializeRemoteBranch(shipB, 'origin', 'tabl-7');
  const wt = shipB + '-wt7';
  sh(shipB, 'worktree', 'add', '-q', wt, 'tabl-7');
  sh(shipA, 'commit', '--allow-empty', '-qm', 'resolved');
  sh(shipA, 'push', '-q', 'origin', 'tabl-7');
  fetchRemote(shipB);
  const r = levelRemoteBranch(shipB, 'origin', 'tabl-7');
  assert.equal(r.problem, undefined);
  assert.equal(sh(shipB, 'rev-parse', 'tabl-7'), sh(shipA, 'rev-parse', 'tabl-7'));
  assert.equal(sh(wt, 'rev-parse', 'HEAD'), sh(shipA, 'rev-parse', 'tabl-7'));
});

test('levelRemoteBranch: reports, never hides, a stale branch a dirty worktree holds (CREW-1636)', () => {
  const { shipA, shipB, sh } = twoShips();
  sh(shipA, 'checkout', '-q', '-b', 'tabl-8');
  sh(shipA, 'push', '-q', '--set-upstream', 'origin', 'tabl-8');
  fetchRemote(shipB);
  materializeRemoteBranch(shipB, 'origin', 'tabl-8');
  const wt = shipB + '-wt8';
  sh(shipB, 'worktree', 'add', '-q', wt, 'tabl-8');
  writeFileSync(join(wt, 'dirty.txt'), 'x');
  sh(shipA, 'commit', '--allow-empty', '-qm', 'resolved');
  sh(shipA, 'push', '-q', 'origin', 'tabl-8');
  fetchRemote(shipB);
  const before = sh(shipB, 'rev-parse', 'tabl-8');
  const r = levelRemoteBranch(shipB, 'origin', 'tabl-8');
  assert.match(r.problem ?? '', /uncommitted or mid-merge/);
  assert.equal(sh(shipB, 'rev-parse', 'tabl-8'), before);
});

test('levelRemoteBranch: reports a diverged branch a worktree holds, naming both shas (CREW-1758)', () => {
  const { shipA, shipB, sh } = twoShips();
  sh(shipA, 'checkout', '-q', '-b', 'tabl-10');
  sh(shipA, 'push', '-q', '--set-upstream', 'origin', 'tabl-10');
  fetchRemote(shipB);
  materializeRemoteBranch(shipB, 'origin', 'tabl-10');
  const wt = shipB + '-wt10';
  sh(shipB, 'worktree', 'add', '-q', wt, 'tabl-10');
  sh(wt, 'config', 'user.email', 't@t'); sh(wt, 'config', 'user.name', 'T');
  sh(wt, 'commit', '--allow-empty', '-qm', 'local only');
  sh(shipA, 'commit', '--allow-empty', '-qm', 'remote only');
  sh(shipA, 'push', '-q', 'origin', 'tabl-10');
  fetchRemote(shipB);
  const local = sh(shipB, 'rev-parse', 'tabl-10');
  const r = levelRemoteBranch(shipB, 'origin', 'tabl-10');
  assert.match(r.problem ?? '', /has commits not on origin\/tabl-10/);
  assert.ok((r.problem ?? '').includes(local.slice(0, 8)));
  assert.ok((r.problem ?? '').includes(sh(shipA, 'rev-parse', 'tabl-10').slice(0, 8)));
  assert.ok((r.problem ?? '').includes(wt));
  assert.equal(sh(shipB, 'rev-parse', 'tabl-10'), local);
});

/** Ship A pushes the real branch from an older base; ship B's empty copy sits on the moved-on base. */
function staleEmptyBranch(branch: string) {
  const ships = twoShips();
  const { shipA, shipB, sh } = ships;
  sh(shipA, 'checkout', '-q', '-b', branch);
  sh(shipA, 'commit', '--allow-empty', '-qm', 'ticket work');
  sh(shipA, 'push', '-q', '--set-upstream', 'origin', branch);
  sh(shipA, 'checkout', '-q', 'main');
  sh(shipA, 'commit', '--allow-empty', '-qm', 'release');
  sh(shipA, 'push', '-q', 'origin', 'main');
  fetchRemote(shipB);
  sh(shipB, 'branch', '--no-track', branch, 'origin/main');
  return ships;
}

test('levelRemoteBranch: resets a branch holding only base commits to the remote tip (CREW-2528)', () => {
  const { shipA, shipB, sh } = staleEmptyBranch('tabl-20');
  const r = levelRemoteBranch(shipB, 'origin', 'tabl-20', 'origin/main');
  assert.equal(r.problem, undefined);
  assert.ok(r.reset);
  assert.equal(sh(shipB, 'rev-parse', 'tabl-20'), sh(shipA, 'rev-parse', 'tabl-20'));
});

test('levelRemoteBranch: resets a clean worktree holding only base commits in place (CREW-2528)', () => {
  const { shipA, shipB, sh } = staleEmptyBranch('tabl-21');
  const wt = shipB + '-wt21';
  sh(shipB, 'worktree', 'add', '-q', wt, 'tabl-21');
  const r = levelRemoteBranch(shipB, 'origin', 'tabl-21', 'origin/main');
  assert.equal(r.problem, undefined);
  assert.equal(sh(wt, 'rev-parse', 'HEAD'), sh(shipA, 'rev-parse', 'tabl-21'));
});

test('levelRemoteBranch: a branch with a genuine unpushed commit is still refused (CREW-1636 kept)', () => {
  const { shipB, sh } = staleEmptyBranch('tabl-22');
  const wt = shipB + '-wt22';
  sh(shipB, 'worktree', 'add', '-q', wt, 'tabl-22');
  sh(wt, 'config', 'user.email', 't@t'); sh(wt, 'config', 'user.name', 'T');
  sh(wt, 'commit', '--allow-empty', '-qm', 'my work');
  const before = sh(shipB, 'rev-parse', 'tabl-22');
  const r = levelRemoteBranch(shipB, 'origin', 'tabl-22', 'origin/main');
  assert.match(r.problem ?? '', /has commits not on origin\/tabl-22/);
  assert.equal(r.reset, undefined);
  assert.equal(sh(shipB, 'rev-parse', 'tabl-22'), before);
});

test('deleteRemoteBranch removes the upstream copy; a branch already gone is success', () => {
  const { shipA, sh } = twoShips();
  sh(shipA, 'branch', 'tabl-9');
  sh(shipA, 'push', '-q', 'origin', 'tabl-9');
  assert.equal(deleteRemoteBranch(shipA, 'origin', 'tabl-9'), true);
  assert.equal(sh(shipA, 'ls-remote', '--heads', 'origin', 'tabl-9'), '');
  assert.equal(deleteRemoteBranch(shipA, 'origin', 'tabl-9'), true);
});

test('planRemoteBranchCleanup: only branches of deployed tickets, never the base', () => {
  const { shipA, sh } = twoShips();
  for (const b of ['tabl-10', 'issue-11', 'crew-12-some-slug', 'tabl-110', 'v10', 'release-10', 'node-12', 'v2', 'release-2']) {
    sh(shipA, 'branch', b); sh(shipA, 'push', '-q', 'origin', b);
  }
  const t = (n: number, status: string): Ticket => ({ id: `r${n}`, issue_id: `ISSUE-${n}`, status, updated_at: '2026-01-01T00:00:00Z', project_issue_prefix: n === 12 ? 'CREW' : 'TABL' });
  const c = DEFAULT_CONTRACT;
  const plan = planRemoteBranchCleanup(
    shipA, 'origin', 'main',
    [t(2, c.statuses.deployed), t(10, c.statuses.deployed), t(11, c.statuses.verified), t(12, c.statuses.deployed), t(110, c.statuses.verified)],
    c,
  );
  assert.deepEqual(plan.sort(), ['crew-12-some-slug', 'tabl-10']);
});

test('remoteBranchTicketNumbers: the numbers on pushed ticket branches, never the base (CREW-1593)', () => {
  const { shipA, sh } = twoShips();
  for (const b of ['tabl-10', 'crew-12-some-slug', 'issue-7']) { sh(shipA, 'branch', b); sh(shipA, 'push', '-q', 'origin', b); }
  assert.deepEqual(remoteBranchTicketNumbers(shipA, 'origin', 'main').sort(), ['10', '12', '7']);
});

test('dropEmptyRunBranch: removes a fresh branch with no commits, keeps one with work or on the remote (CREW-2528)', async () => {
  const { dropEmptyRunBranch } = await import('../src/run-worktree.ts');
  const { shipA, sh } = twoShips();
  // Only `branch.remote` and `branch.base` are read.
  const cfg = { branch: { remote: 'origin', base: 'main' } } as Parameters<typeof dropEmptyRunBranch>[1];
  const wt = shipA + '-wt30';
  sh(shipA, 'worktree', 'add', '-q', '--no-track', '-b', 'tabl-30', wt, 'origin/main');
  assert.equal(dropEmptyRunBranch(shipA, cfg, 'tabl-30'), true);
  assert.equal(sh(shipA, 'branch', '--list', 'tabl-30'), '');

  const wt2 = shipA + '-wt31';
  sh(shipA, 'worktree', 'add', '-q', '--no-track', '-b', 'tabl-31', wt2, 'origin/main');
  sh(wt2, 'config', 'user.email', 't@t'); sh(wt2, 'config', 'user.name', 'T');
  sh(wt2, 'commit', '--allow-empty', '-qm', 'work');
  assert.equal(dropEmptyRunBranch(shipA, cfg, 'tabl-31'), false);
});

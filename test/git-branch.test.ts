import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
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
import { remoteBranchForIssue, materializeRemoteBranch, deleteRemoteBranch, fetchRemote } from '../src/git.ts';
import { planRemoteBranchCleanup } from '../src/worktree-sweep.ts';
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

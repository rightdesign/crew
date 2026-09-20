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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cloneUrlFor, ensureRepoCheckout, GitError } from '../src/git.ts';

test('cloneUrlFor builds an SSH GitHub URL from the tracker\'s owner/repo shape', () => {
  assert.equal(cloneUrlFor('rightdesign/crew'), 'git@github.com:rightdesign/crew.git');
});

test('ensureRepoCheckout is a no-op when the directory already has a .git', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-checkout-'));
  execFileSync('git', ['init', '-q', dir]);
  assert.equal(ensureRepoCheckout(dir, undefined), false);
  assert.equal(ensureRepoCheckout(dir, 'someone/somewhere'), false);
});

test('ensureRepoCheckout refuses to guess when the directory is missing and no remote was discovered', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'crew-checkout-')), 'nested', 'missing');
  assert.throws(() => ensureRepoCheckout(dir, undefined), GitError);
  assert.throws(() => ensureRepoCheckout(dir, undefined), /no discovered remote/);
});

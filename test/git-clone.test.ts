import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cloneUrlFor, ensureRepoCheckout, syncPassengerCheckout, GitError } from '../src/git.ts';

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

test('cloneUrlFor follows the primary checkout\'s origin scheme, then the configured fallback', () => {
  assert.equal(cloneUrlFor('rightdesign/crew', { originUrl: 'https://github.com/rightdesign/crew.git' }), 'https://github.com/rightdesign/crew.git');
  assert.equal(cloneUrlFor('rightdesign/crew', { originUrl: 'git@github.com:rightdesign/crew.git', scheme: 'https' }), 'git@github.com:rightdesign/crew.git');
  assert.equal(cloneUrlFor('rightdesign/crew', { scheme: 'https' }), 'https://github.com/rightdesign/crew.git');
  assert.equal(cloneUrlFor('rightdesign/crew', { originUrl: null }), 'git@github.com:rightdesign/crew.git');
});

test('ensureRepoCheckout surfaces git\'s own text on a failed clone, not a Buffer.trim crash', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'crew-checkout-')), 'clone');
  const prev = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND = 'false';
  try {
    assert.throws(() => ensureRepoCheckout(dir, 'nobody/nothing'), (e: Error) => {
      assert.ok(e instanceof GitError);
      assert.doesNotMatch(e.message, /trim is not a function/);
      assert.match(e.message, /git clone git@github\.com:nobody\/nothing\.git/);
      return true;
    });
  } finally {
    if (prev === undefined) delete process.env.GIT_SSH_COMMAND; else process.env.GIT_SSH_COMMAND = prev;
  }
});

test('syncPassengerCheckout reports a failed clone once, then skips it until the clone URL changes', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'crew-checkout-')), 'clone');
  const prev = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND = 'false';
  try {
    const first = syncPassengerCheckout(dir, 'nobody/nothing', 'origin', 'main');
    assert.equal(first.action, 'clone-failed');
    assert.equal(first.action === 'clone-failed' && first.repeat, false);
    const second = syncPassengerCheckout(dir, 'nobody/nothing', 'origin', 'main');
    assert.equal(second.action === 'clone-failed' && second.repeat, true);
    assert.equal(second.action === 'clone-failed' && second.detail, first.action === 'clone-failed' ? first.detail : '');
    // A changed scheme is a changed URL: it retries (and fails again, as a fresh report).
    process.env.GIT_TERMINAL_PROMPT = '0';
    const third = syncPassengerCheckout(dir, 'nobody/nothing', 'origin', 'main', { scheme: 'https' });
    assert.equal(third.action === 'clone-failed' && third.repeat, false);
  } finally {
    if (prev === undefined) delete process.env.GIT_SSH_COMMAND; else process.env.GIT_SSH_COMMAND = prev;
  }
});

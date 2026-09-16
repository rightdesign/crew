import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectClosure, detectClosureHeuristically, fetchRemote, fileAtRef, isAncestor, remoteBranchExists, findKeyOnBase,
} from '../src/git.ts';

/** A bare "remote" plus a clone — the real shape, not a mock. */
function pair() {
  const root = mkdtempSync(join(tmpdir(), 'crew-remote-'));
  const bare = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const work = join(root, 'work');
  execFileSync('git', ['clone', '-q', bare, work]);
  const g = (...a: string[]) => execFileSync('git', a, { cwd: work, stdio: 'pipe' });
  g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  writeFileSync(join(work, 'README.md'), 'x'); g('add', '.'); g('commit', '-qm', 'base');
  g('push', '-q', 'origin', 'main');
  return { work, g };
}

test('a SQUASH merge is detected — ancestry would have missed it', () => {
  const { work, g } = pair();
  g('checkout', '-qb', 'issue-999');
  writeFileSync(join(work, 'f.txt'), '1'); g('add', '.');
  g('commit', '-qm', 'Added the widget (ISSUE-999)');
  g('push', '-q', 'origin', 'issue-999');
  const branchHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();

  // the forge squash-merges and deletes the branch
  g('checkout', '-q', 'main');
  g('merge', '--squash', 'issue-999');
  g('commit', '-qm', 'Added the widget (ISSUE-999) (#42)');
  g('push', '-q', 'origin', 'main');
  g('push', '-q', 'origin', '--delete', 'issue-999');
  fetchRemote(work);

  // ancestry says no...
  let isAncestor = true;
  try { execFileSync('git', ['merge-base', '--is-ancestor', branchHead, 'origin/main'], { cwd: work, stdio: 'pipe' }); }
  catch { isAncestor = false; }
  assert.equal(isAncestor, false, 'squash should defeat ancestry');

  // ...but the key does not
  const c = detectClosureHeuristically(work, 'ISSUE-999', 'issue-999');
  assert.equal(c.state, 'merged');
  assert.match(c.detail, /appears on origin\/main/);
});

test('an open PR reads as open, not merged', () => {
  const { work, g } = pair();
  g('checkout', '-qb', 'issue-1');
  writeFileSync(join(work, 'f.txt'), '1'); g('add', '.'); g('commit', '-qm', 'wip (ISSUE-1)');
  g('push', '-q', 'origin', 'issue-1');
  fetchRemote(work);
  assert.ok(remoteBranchExists(work, 'origin', 'issue-1'));
  assert.equal(detectClosureHeuristically(work, 'ISSUE-1', 'issue-1').state, 'open');
});

test('closed-without-merging is distinguishable from merged', () => {
  const { work, g } = pair();
  g('checkout', '-qb', 'issue-2');
  writeFileSync(join(work, 'f.txt'), '1'); g('add', '.'); g('commit', '-qm', 'rejected (ISSUE-2)');
  g('push', '-q', 'origin', 'issue-2');
  g('push', '-q', 'origin', '--delete', 'issue-2');   // closed, never merged
  g('checkout', '-q', 'main');
  fetchRemote(work);
  const c = detectClosureHeuristically(work, 'ISSUE-2', 'issue-2');
  assert.equal(c.state, 'abandoned');
  assert.match(c.detail, /never reached main/);
});

test('a plain merge commit is detected too', () => {
  const { work, g } = pair();
  g('checkout', '-qb', 'issue-3');
  writeFileSync(join(work, 'f.txt'), '1'); g('add', '.'); g('commit', '-qm', 'work (ISSUE-3)');
  g('checkout', '-q', 'main');
  g('merge', '--no-ff', '-m', 'Merge (ISSUE-3)', 'issue-3');
  g('push', '-q', 'origin', 'main');
  fetchRemote(work);
  assert.equal(detectClosureHeuristically(work, 'ISSUE-3', 'issue-3').state, 'merged');
});

test('the search is bounded, so a long repo is not rescanned each cycle', () => {
  const { work, g } = pair();
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
  writeFileSync(join(work, 'f.txt'), '1'); g('add', '.'); g('commit', '-qm', 'later (ISSUE-5)');
  g('push', '-q', 'origin', 'main');
  fetchRemote(work);
  assert.ok(findKeyOnBase(work, 'ISSUE-5', 'origin', 'main', before));
  // bounded past the commit that carries it -> not found
  const head = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: work, encoding: 'utf8' }).trim();
  assert.equal(findKeyOnBase(work, 'ISSUE-5', 'origin', 'main', head), null);
});

test('a key that is a substring of another is not a false positive', () => {
  const { work, g } = pair();
  writeFileSync(join(work, 'f.txt'), '1'); g('add', '.');
  g('commit', '-qm', 'work (ISSUE-1234)'); g('push', '-q', 'origin', 'main');
  fetchRemote(work);
  // ISSUE-123 must not match a commit for ISSUE-1234
  const c = detectClosureHeuristically(work, 'ISSUE-123', 'issue-123');
  assert.notEqual(c.state, 'merged');
});

test('the key still matches in the shapes commits actually use', () => {
  const { work, g } = pair();
  for (const [i, subject] of [
    'Fixed a thing (ISSUE-77)',
    'ISSUE-78: did the work',
    'work for ISSUE-79',
    'Merge pull request #4 from x/issue-80 (ISSUE-80)',
  ].entries()) {
    writeFileSync(join(work, `f${i}.txt`), '1'); g('add', '.'); g('commit', '-qm', subject);
  }
  g('push', '-q', 'origin', 'main');
  fetchRemote(work);
  for (const k of ['ISSUE-77', 'ISSUE-78', 'ISSUE-79', 'ISSUE-80']) {
    assert.ok(findKeyOnBase(work, k, 'origin', 'main'), `${k} should be found`);
  }
});

test('the repo\'s merged hook is authoritative, and the heuristics are not consulted', async () => {
  const { work, g } = pair();
  g('checkout', '-qb', 'issue-500');
  writeFileSync(join(work, 'f.txt'), '1'); g('add', '.');
  // subject deliberately WITHOUT the key — the fragile case
  g('commit', '-qm', 'fix stuff');
  g('push', '-q', 'origin', 'issue-500');
  g('checkout', '-q', 'main');
  g('merge', '--squash', 'issue-500'); g('commit', '-qm', 'fix stuff');
  g('push', '-q', 'origin', 'main');
  g('push', '-q', 'origin', '--delete', 'issue-500');
  fetchRemote(work);

  // the heuristic gets it WRONG — this is the fragility, demonstrated
  const guess = detectClosureHeuristically(work, 'ISSUE-500', 'issue-500');
  assert.equal(guess.state, 'abandoned');
  assert.equal(guess.confidence, 'heuristic');
  assert.match(guess.detail, /rewritten subject/);

  // the hook gets it right, and says so definitively
  const seen: Record<string, string>[] = [];
  const truth = await detectClosure({
    cwd: work, key: 'ISSUE-500', pushedBranch: 'issue-500',
    mergedHook: async (env) => { seen.push(env); return 0; },
  });
  assert.equal(truth.state, 'merged');
  assert.equal(truth.confidence, 'definitive');
  assert.equal(truth.mergedAt, undefined);   // rewritten subject — nothing to resolve
  assert.deepEqual(seen[0], { CREW_TICKET: 'ISSUE-500', CREW_BRANCH: 'issue-500', CREW_BASE: 'main' });
});

test('the merged hook is authoritative about STATE, but the sha still comes from the base — same as the heuristic path', async () => {
  const { work, g } = pair();
  g('checkout', '-qb', 'issue-502');
  writeFileSync(join(work, 'f.txt'), '1'); g('add', '.');
  g('commit', '-qm', 'built it (ISSUE-502)');
  g('push', '-q', 'origin', 'issue-502');
  const branchHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
  g('checkout', '-q', 'main');
  g('merge', '--squash', 'issue-502'); g('commit', '-qm', 'built it (ISSUE-502) (#7)');
  const squashSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
  g('push', '-q', 'origin', 'main');
  g('push', '-q', 'origin', '--delete', 'issue-502');
  fetchRemote(work);

  const truth = await detectClosure({
    cwd: work, key: 'ISSUE-502', pushedBranch: 'issue-502', mergedHook: async () => 0,
  });
  assert.equal(truth.state, 'merged');
  assert.equal(truth.confidence, 'definitive');
  assert.notEqual(truth.mergedAt, branchHead);   // the branch's own head is not on the base — squashed
  assert.equal(truth.mergedAt, squashSha);
});

test('a hook saying "not landed" still distinguishes open from abandoned', async () => {
  const { work, g } = pair();
  g('checkout', '-qb', 'issue-501');
  writeFileSync(join(work, 'f.txt'), '1'); g('add', '.'); g('commit', '-qm', 'wip');
  g('push', '-q', 'origin', 'issue-501'); g('checkout', '-q', 'main');
  fetchRemote(work);
  const open = await detectClosure({
    cwd: work, key: 'ISSUE-501', pushedBranch: 'issue-501', mergedHook: async () => 1,
  });
  assert.equal(open.state, 'open');
  assert.equal(open.confidence, 'definitive');

  g('push', '-q', 'origin', '--delete', 'issue-501'); fetchRemote(work);
  const gone = await detectClosure({
    cwd: work, key: 'ISSUE-501', pushedBranch: 'issue-501', mergedHook: async () => 1,
  });
  assert.equal(gone.state, 'abandoned');
});

test('with no hook, the answer is explicitly heuristic', async () => {
  const { work } = pair();
  const c = await detectClosure({ cwd: work, key: 'ISSUE-1', pushedBranch: 'issue-1' });
  assert.equal(c.confidence, 'heuristic');
});

test('isAncestor matches a batched build commit that carries an earlier merge, not just an exact commit', () => {
  const { work, g } = pair();
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
  writeFileSync(join(work, 'a.txt'), '1'); g('add', '.'); g('commit', '-qm', 'a');
  const merge = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
  writeFileSync(join(work, 'b.txt'), '1'); g('add', '.'); g('commit', '-qm', 'later batch build');
  const batch = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();

  assert.equal(isAncestor(work, merge, batch), true);
  assert.equal(isAncestor(work, batch, merge), false);
  assert.equal(isAncestor(work, before, batch), true);
  // An unknown sha doesn't throw — it reads as "can't confirm", not a fault.
  assert.equal(isAncestor(work, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', batch), false);
});

test('fileAtRef reads a version file at a commit without checking it out', () => {
  const { work, g } = pair();
  writeFileSync(join(work, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  g('add', '.'); g('commit', '-qm', 'v1.0.0');
  const v1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
  writeFileSync(join(work, 'package.json'), JSON.stringify({ version: '2.0.0' }));
  g('add', '.'); g('commit', '-qm', 'v2.0.0');

  assert.equal(JSON.parse(fileAtRef(work, v1, 'package.json')!).version, '1.0.0');
  assert.equal(JSON.parse(fileAtRef(work, 'HEAD', 'package.json')!).version, '2.0.0');
  assert.equal(fileAtRef(work, 'HEAD', 'nope.json'), null);
});

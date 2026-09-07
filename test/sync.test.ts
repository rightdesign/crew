import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncState, fastForward, worktrees, fetchRemote, status, refreshBaseBranch } from '../src/git.ts';

/** A bare remote and two clones — "the reviewer" and "the ship". */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'crew-sync-'));
  const bare = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const mk = (name: string) => {
    const d = join(root, name);
    execFileSync('git', ['clone', '-q', bare, d]);
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: d });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: d });
    return { d, g: (...a: string[]) => execFileSync('git', a, { cwd: d, stdio: 'pipe' }) };
  };
  const ship = mk('ship');
  writeFileSync(join(ship.d, 'README.md'), 'x'); ship.g('add', '.'); ship.g('commit', '-qm', 'base');
  ship.g('push', '-q', 'origin', 'main');
  const reviewer = mk('reviewer');
  return { ship, reviewer };
}

test('a branch level with its upstream needs nothing', () => {
  const { ship } = world();
  ship.g('checkout', '-qb', 'issue-1');
  ship.g('push', '-q', '-u', 'origin', 'issue-1');
  const s = syncState(ship.d, 'issue-1');
  assert.equal(s.behind, 0);
  assert.equal(s.canFastForward, false);
  assert.match(s.detail, /level with origin\/issue-1/);
});

test('a reviewer\'s commits are taken automatically when the tree is clean', () => {
  const { ship, reviewer } = world();
  ship.g('checkout', '-qb', 'issue-2');
  writeFileSync(join(ship.d, 'a.txt'), '1'); ship.g('add', '.'); ship.g('commit', '-qm', 'crew work (ISSUE-2)');
  ship.g('push', '-q', '-u', 'origin', 'issue-2');

  // a reviewer pushes their own fix on top
  reviewer.g('fetch', '-q', 'origin');
  reviewer.g('checkout', '-qb', 'issue-2', 'origin/issue-2');
  writeFileSync(join(reviewer.d, 'b.txt'), '2'); reviewer.g('add', '.');
  reviewer.g('commit', '-qm', 'reviewer fix');
  reviewer.g('push', '-q', 'origin', 'issue-2');

  fetchRemote(ship.d);
  const before = syncState(ship.d, 'issue-2');
  assert.equal(before.behind, 1);
  assert.equal(before.canFastForward, true);
  assert.match(before.detail, /1 behind.*fast-forwardable/);

  assert.equal(fastForward(ship.d, 'issue-2'), true);
  assert.equal(syncState(ship.d, 'issue-2').behind, 0);
});

test('a dirty worktree is never touched, however far behind', () => {
  const { ship, reviewer } = world();
  ship.g('checkout', '-qb', 'issue-3');
  ship.g('push', '-q', '-u', 'origin', 'issue-3');
  reviewer.g('fetch', '-q', 'origin');
  reviewer.g('checkout', '-qb', 'issue-3', 'origin/issue-3');
  writeFileSync(join(reviewer.d, 'c.txt'), '1'); reviewer.g('add', '.');
  reviewer.g('commit', '-qm', 'theirs'); reviewer.g('push', '-q', 'origin', 'issue-3');
  fetchRemote(ship.d);

  writeFileSync(join(ship.d, 'uncommitted.txt'), 'mine');   // work in progress
  const s = syncState(ship.d, 'issue-3');
  assert.equal(s.behind, 1);
  assert.equal(s.dirty, true);
  assert.equal(s.canFastForward, false);
  assert.match(s.detail, /worktree is dirty — not touching it/);
  assert.equal(fastForward(ship.d, 'issue-3'), false);
});

test('divergence is reported for a human, never merged on their behalf', () => {
  const { ship, reviewer } = world();
  ship.g('checkout', '-qb', 'issue-4');
  ship.g('push', '-q', '-u', 'origin', 'issue-4');
  reviewer.g('fetch', '-q', 'origin');
  reviewer.g('checkout', '-qb', 'issue-4', 'origin/issue-4');
  writeFileSync(join(reviewer.d, 'r.txt'), '1'); reviewer.g('add', '.');
  reviewer.g('commit', '-qm', 'theirs'); reviewer.g('push', '-q', 'origin', 'issue-4');
  writeFileSync(join(ship.d, 's.txt'), '1'); ship.g('add', '.'); ship.g('commit', '-qm', 'ours');
  fetchRemote(ship.d);

  const s = syncState(ship.d, 'issue-4');
  assert.equal(s.ahead, 1);
  assert.equal(s.behind, 1);
  assert.equal(s.canFastForward, false);
  assert.match(s.detail, /diverged.*needs a human/);
  assert.equal(fastForward(ship.d, 'issue-4'), false);
});

test('a branch tracking nothing is left alone', () => {
  const { ship } = world();
  ship.g('checkout', '-qb', 'local-only');
  const s = syncState(ship.d, 'local-only');
  assert.equal(s.upstream, null);
  assert.equal(s.canFastForward, false);
  assert.match(s.detail, /tracks no remote branch/);
});

test('worktrees are enumerated with their branches', () => {
  const { ship } = world();
  const wt = join(mkdtempSync(join(tmpdir(), 'crew-wt-')), 'issue-9');
  ship.g('worktree', 'add', '-q', '-b', 'issue-9', wt);
  const list = worktrees(ship.d);
  assert.ok(list.some((w) => w.branch === 'issue-9'));
  assert.ok(list.some((w) => w.branch === 'main'));
});

/* ── refreshBaseBranch: the PRIMARY checkout's own base branch, not a
   worktree's — used both by the release phase before deciding what to
   release, and by `crew sync` before an agent cuts a new ticket's worktree
   from it (ISSUE-635). ── */

test('refreshBaseBranch fast-forwards the primary checkout when another ship pushed to base', () => {
  const { ship, reviewer } = world();
  writeFileSync(join(reviewer.d, 'elsewhere.txt'), '1'); reviewer.g('add', '.');
  reviewer.g('commit', '-qm', 'another ship shipped this'); reviewer.g('push', '-q', 'origin', 'main');

  const r = refreshBaseBranch(ship.d, 'origin', 'main');
  assert.equal(r.action, 'fast-forwarded');
  assert.match(r.detail, /fast-forwarded main to origin\/main/);
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ship.d, encoding: 'utf8' }).trim(),
    execFileSync('git', ['rev-parse', 'origin/main'], { cwd: ship.d, encoding: 'utf8' }).trim(),
  );
});

test('refreshBaseBranch is a dry-run no-op that only reports what it would do', () => {
  const { ship, reviewer } = world();
  writeFileSync(join(reviewer.d, 'elsewhere.txt'), '1'); reviewer.g('add', '.');
  reviewer.g('commit', '-qm', 'another ship shipped this'); reviewer.g('push', '-q', 'origin', 'main');
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ship.d, encoding: 'utf8' }).trim();

  const r = refreshBaseBranch(ship.d, 'origin', 'main', true);
  assert.equal(r.action, 'would-fast-forward');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ship.d, encoding: 'utf8' }).trim(), before);
});

test('refreshBaseBranch never touches a dirty checkout', () => {
  const { ship, reviewer } = world();
  writeFileSync(join(reviewer.d, 'elsewhere.txt'), '1'); reviewer.g('add', '.');
  reviewer.g('commit', '-qm', 'another ship shipped this'); reviewer.g('push', '-q', 'origin', 'main');
  writeFileSync(join(ship.d, 'uncommitted.txt'), 'wip');   // work in progress

  const r = refreshBaseBranch(ship.d, 'origin', 'main');
  assert.equal(r.action, 'not-applicable');
});

test('refreshBaseBranch reports divergence rather than merging on anyone\'s behalf', () => {
  const { ship, reviewer } = world();
  writeFileSync(join(reviewer.d, 'theirs.txt'), '1'); reviewer.g('add', '.');
  reviewer.g('commit', '-qm', 'theirs'); reviewer.g('push', '-q', 'origin', 'main');
  writeFileSync(join(ship.d, 'ours.txt'), '1'); ship.g('add', '.'); ship.g('commit', '-qm', 'ours');

  const r = refreshBaseBranch(ship.d, 'origin', 'main');
  assert.equal(r.action, 'diverged');
  assert.match(r.detail, /diverged from origin\/main/);
});

test('refreshBaseBranch is a no-op when no remote is configured', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-nosync-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), '1');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir });

  const r = refreshBaseBranch(dir, 'origin', 'main');
  assert.equal(r.action, 'not-applicable');
});

test('porcelain parsing keeps the leading status column, and the whole filename', () => {
  // `git()` trims, which strips the leading space of the FIRST porcelain line
  // only — so `slice(3)` started a character late and ate the first character
  // of the first filename. `.crew.yaml` was reported as `crew.yaml`, a file
  // that does not exist, which is how this was noticed at all. Later lines
  // kept their leading space and parsed correctly, so it looked like a one-off.
  const dir = mkdtempSync(join(tmpdir(), 'crew-status-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  writeFileSync(join(dir, '.crew.yaml'), 'x');
  writeFileSync(join(dir, 'b.txt'), 'y');
  g('add', '.'); g('commit', '-qm', 'base');

  // A dotfile first, unstaged: the exact shape that lost its dot.
  writeFileSync(join(dir, '.crew.yaml'), 'changed');
  writeFileSync(join(dir, 'b.txt'), 'changed');
  const unstaged = status(dir);
  assert.deepEqual(unstaged.map((c) => c.path).sort(), ['.crew.yaml', 'b.txt']);
  // The code is positional and must survive too — " M" is worktree-modified,
  // "M " is staged, and reading one as the other would be a real mistake.
  assert.ok(unstaged.every((c) => c.code === ' M'), JSON.stringify(unstaged));

  g('add', '.crew.yaml');
  const staged = status(dir).find((c) => c.path === '.crew.yaml')!;
  assert.equal(staged.code, 'M ');

  // Untracked never had a leading space, so it always worked — pin it anyway.
  writeFileSync(join(dir, '.env'), 'secret');
  const untracked = status(dir).find((c) => c.path === '.env')!;
  assert.equal(untracked.untracked, true);
});

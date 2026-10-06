import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveRepoConfig } from '../src/repo-config.ts';
import { planRunWorktree, applyRunWorktree, finishRunWorktree } from '../src/run-worktree.ts';
import type { Ticket } from '../src/tracker.ts';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A primary checkout `repo` with an origin; `other` is a second clone used to push as "another ship". */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runwt-')));
  const dir = join(root, 'repo');
  const bare = join(root, 'origin.git');
  sh(root, 'init', '-q', '-b', 'main', dir);
  sh(dir, 'config', 'user.email', 't@example.com');
  sh(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'a');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-qm', 'base');
  sh(root, 'init', '-q', '--bare', bare);
  sh(dir, 'remote', 'add', 'origin', bare);
  sh(dir, 'push', '-q', 'origin', 'main');
  const other = join(root, 'other');
  sh(root, 'clone', '-q', bare, other);
  sh(other, 'config', 'user.email', 't@example.com');
  sh(other, 'config', 'user.name', 't');
  return { root, dir, bare, other };
}

const cfg = (dir: string, handoff?: string) =>
  resolveRepoConfig(null, handoff ? { hooks: { handoff } } : undefined, dir);
const ticket = (): Ticket => ({
  id: 'row-9', issue_id: 'ISSUE-9', issue_tag: 'CREW-9', project_issue_prefix: 'CREW',
  status: 'in_progress', assignee_id: null, updated_at: '2026-01-01T00:00:00Z',
}) as Ticket;

/** Another ship pushes `crew-9` with one commit. */
function pushFromElsewhere(other: string, file = 'b.txt') {
  sh(other, 'checkout', '-q', '-b', 'crew-9');
  writeFileSync(join(other, file), 'b');
  sh(other, 'add', '.');
  sh(other, 'commit', '-qm', 'work');
  sh(other, 'push', '-q', 'origin', 'crew-9');
}

test('no worktree and no remote branch: a fresh start from origin/base, nothing addressed to anyone', () => {
  const { dir } = fixture();
  const plan = planRunWorktree(dir, cfg(dir), ticket(), 'dev');
  assert.equal(plan.action, 'cut-fresh');
  const path = applyRunWorktree(dir, cfg(dir), plan)!;
  assert.ok(existsSync(join(path, 'a.txt')));
  assert.equal(sh(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'crew-9');
});

test('a branch built and pushed on another ship is cut from the remote, tracking it', () => {
  const { dir, other } = fixture();
  pushFromElsewhere(other);
  const plan = planRunWorktree(dir, cfg(dir), ticket(), 'dev');
  assert.equal(plan.action, 'cut-remote');
  const path = applyRunWorktree(dir, cfg(dir), plan)!;
  assert.ok(existsSync(join(path, 'b.txt')));
  assert.equal(sh(path, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/crew-9');
});

test('a clean stale worktree is reset to the remote tip', () => {
  const { dir, other } = fixture();
  pushFromElsewhere(other);
  const first = applyRunWorktree(dir, cfg(dir), planRunWorktree(dir, cfg(dir), ticket(), 'dev'))!;
  writeFileSync(join(other, 'c.txt'), 'c');
  sh(other, 'add', '.');
  sh(other, 'commit', '-qm', 'more');
  sh(other, 'push', '-q', 'origin', 'crew-9');
  const plan = planRunWorktree(dir, cfg(dir), ticket(), 'dev');
  assert.equal(plan.action, 'reset');
  applyRunWorktree(dir, cfg(dir), plan);
  assert.ok(existsSync(join(first, 'c.txt')));
});

test('a dirty worktree is left alone', () => {
  const { dir, other } = fixture();
  pushFromElsewhere(other);
  const path = applyRunWorktree(dir, cfg(dir), planRunWorktree(dir, cfg(dir), ticket(), 'dev'))!;
  writeFileSync(join(path, 'wip.txt'), 'x');
  const plan = planRunWorktree(dir, cfg(dir), ticket(), 'dev');
  assert.equal(plan.action, 'leave-dirty');
  assert.equal(applyRunWorktree(dir, cfg(dir), plan), null);
  assert.ok(existsSync(join(path, 'wip.txt')));
});

test('a worktree with unpushed commits is never reset or re-cut', () => {
  const { dir } = fixture();
  const path = applyRunWorktree(dir, cfg(dir), planRunWorktree(dir, cfg(dir), ticket(), 'dev'))!;
  writeFileSync(join(path, 'mine.txt'), 'm');
  sh(path, 'add', '.');
  sh(path, 'commit', '-qm', 'local work');
  const plan = planRunWorktree(dir, cfg(dir), ticket(), 'dev');
  assert.equal(plan.action, 'leave-unpushed');
  assert.ok(existsSync(join(path, 'mine.txt')));
});

test('a work-free worktree whose branch is gone from origin is re-cut from base', () => {
  const { dir } = fixture();
  const path = applyRunWorktree(dir, cfg(dir), planRunWorktree(dir, cfg(dir), ticket(), 'dev'))!;
  sh(dir, 'commit', '-q', '--allow-empty', '-m', 'base moved');
  sh(dir, 'push', '-q', 'origin', 'main');
  const plan = planRunWorktree(dir, cfg(dir), ticket(), 'dev');
  assert.equal(plan.action, 'recut');
  applyRunWorktree(dir, cfg(dir), plan);
  assert.equal(sh(path, 'rev-parse', 'HEAD'), sh(dir, 'rev-parse', 'origin/main'));
});

test('the worktree is removed after the push when the repo has no handoff hook', async () => {
  const { dir } = fixture();
  const path = applyRunWorktree(dir, cfg(dir), planRunWorktree(dir, cfg(dir), ticket(), 'dev'))!;
  const o = await finishRunWorktree(dir, cfg(dir), 'crew-9');
  assert.equal(o.kind, 'removed');
  assert.equal(existsSync(path), false);
});

test('the worktree is kept when a handoff hook serves from it', async () => {
  const { dir } = fixture();
  const path = applyRunWorktree(dir, cfg(dir, 'echo url'), planRunWorktree(dir, cfg(dir, 'echo url'), ticket(), 'dev'))!;
  const o = await finishRunWorktree(dir, cfg(dir, 'echo url'), 'crew-9');
  assert.equal(o.kind, 'kept-handoff');
  assert.ok(existsSync(path));
});

test('a dirty worktree is never removed at the end of a run', async () => {
  const { dir } = fixture();
  const path = applyRunWorktree(dir, cfg(dir), planRunWorktree(dir, cfg(dir), ticket(), 'dev'))!;
  writeFileSync(join(path, 'wip.txt'), 'x');
  const o = await finishRunWorktree(dir, cfg(dir), 'crew-9');
  assert.equal(o.kind, 'kept-dirty');
  assert.ok(existsSync(path));
});

test('a worktree holding commits that are not on the remote is never removed (CREW-1405)', async () => {
  const { dir } = fixture();
  const path = applyRunWorktree(dir, cfg(dir), planRunWorktree(dir, cfg(dir), ticket(), 'qa'))!;
  writeFileSync(join(path, 'wip.txt'), 'x');
  sh(path, 'add', '.');
  sh(path, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'local only');
  const o = await finishRunWorktree(dir, cfg(dir), 'crew-9');
  assert.equal(o.kind, 'kept-unpushed');
  assert.ok(existsSync(path));
});

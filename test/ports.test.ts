import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ticketForPort, worktreeExists, worktreeExistsIn, DEFAULT_PORTS, listeners } from '../src/ports.ts';

test('a port maps back to its ticket and role', () => {
  assert.deepEqual(ticketForPort(30042), { n: 42, role: 'backend' });
  assert.deepEqual(ticketForPort(40042), { n: 42, role: 'frontend' });
  assert.equal(ticketForPort(3000), null);     // the operator's own stack
  assert.equal(ticketForPort(5173), null);
  assert.equal(ticketForPort(31000), null);    // past the span
});

test('a worktree is recognised with or without zero padding', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-wt-'));
  mkdirSync(join(parent, 'proj-issue-007'));
  writeFileSync(join(parent, 'proj-issue-007', '.git'), 'gitdir: ...');
  assert.ok(worktreeExists(parent, 'proj-issue-', 7));
  assert.ok(!worktreeExists(parent, 'proj-issue-', 8));
});

test('a directory left behind by a leaked server does not shield it', () => {
  // A removed worktree whose server rebuilt dist/ leaves a directory with no
  // .git — matching on the directory alone let it protect the very process
  // that recreated it.
  const parent = mkdtempSync(join(tmpdir(), 'crew-wt-'));
  mkdirSync(join(parent, 'proj-issue-9', 'apps', 'backend', 'dist'), { recursive: true });
  assert.equal(worktreeExists(parent, 'proj-issue-', 9), false);
});

test('listeners() returns plausible pid/port pairs on this machine', () => {
  const ls = listeners();
  assert.ok(Array.isArray(ls));
  for (const l of ls.slice(0, 20)) {
    assert.ok(Number.isFinite(l.pid) && l.pid > 0, `bad pid ${l.pid}`);
    assert.ok(Number.isFinite(l.port) && l.port > 0 && l.port < 65536, `bad port ${l.port}`);
  }
});

test('a custom port scheme is honoured', () => {
  const s = { backendBase: 8000, frontendBase: 9000, span: 100 };
  assert.deepEqual(ticketForPort(8005, s), { n: 5, role: 'backend' });
  assert.equal(ticketForPort(8500, s), null);
  assert.deepEqual(ticketForPort(9005, s), { n: 5, role: 'frontend' });
});

// ISSUE-350. Each repo names its worktrees after itself, so asking only the
// route's first directory answers "gone" for a worktree that is alive
// next door — and `reap` kills the processes of what it thinks is gone.
test('a worktree counts as present when any of the route\'s repos has it', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-wt-'));
  mkdirSync(join(parent, 'crew-issue-350'), { recursive: true });
  writeFileSync(join(parent, 'crew-issue-350', '.git'), 'gitdir: elsewhere');
  const where = [
    { parent, prefix: 'synthesis-issue-' },
    { parent, prefix: 'crew-issue-' },
  ];
  assert.equal(worktreeExistsIn(where, 350), true);
  assert.equal(worktreeExistsIn([where[0]!], 350), false);   // the pre-ISSUE-350 answer
  assert.equal(worktreeExistsIn(where, 351), false);
});

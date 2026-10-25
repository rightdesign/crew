import test from 'node:test';
import assert from 'node:assert/strict';
import { handBackComment, type ConflictBounce } from '../src/conflict.ts';
import type { Ticket } from '../src/tracker.ts';

const base: ConflictBounce = {
  ticket: { id: 't', issue_id: 'ISSUE-2', title: 'x', status: 'verified', updated_at: '' } as Ticket,
  branch: 'p-2', base: 'main', worktree: null, paths: ['a.swift'], priorBounces: 0, cwd: '/x',
  baseSha: null, priorBaseSha: null,
};

test('a conflict with a branch merged earlier in the release names that branch', () => {
  const s = handBackComment({ ...base, siblings: [{ key: 'P-1', branch: 'p-1' }] }, true);
  assert.match(s, /P-1 \(`p-1`\), merged earlier in the same release/);
  assert.doesNotMatch(s, /Work that landed on/);
});

test('without a sibling the note blames the base as before', () => {
  assert.match(handBackComment(base, true), /Work that landed on `main`/);
});

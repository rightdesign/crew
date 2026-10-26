import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repoFindings, attentionProblems } from '../src/doctor-problems.ts';

const ok = { message: 'base main: level with origin', failed: false, skipRest: false };
const base = { route: 'r', repo: 'app', dir: '/x/app', notes: [] as string[], base: ok, hooks: {}, onPath: () => true };

test('a missing checkout is a blocker naming the repo', () => {
  const f = repoFindings({ ...base, base: { message: '/x/app is missing on disk', failed: true, skipRest: true } });
  assert.equal(f.problems.length, 1);
  assert.equal(f.problems[0]!.severity, 'blocker');
  assert.equal(f.problems[0]!.kind, 'repo_missing_checkout');
  assert.match(f.problems[0]!.message, /app/);
});

test('a release-readiness note is a note, not a blocker', () => {
  const f = repoFindings({ ...base, notes: ['release.mode "local" needs a deploy hook'] });
  assert.deepEqual(f.problems.map((p) => [p.severity, p.kind]), [['note', 'release_note']]);
});

test('a hook command off the scheduler PATH is hook_missing with hook and command', () => {
  const f = repoFindings({ ...base, hooks: { test: 'yarn test', setup: 'pnpm install' }, onPath: (c) => c !== 'yarn' });
  const p = f.problems.find((x) => x.kind === 'hook_missing')!;
  assert.equal(p.severity, 'attention');
  assert.equal(p.hook, 'test');
  assert.equal(p.command, 'yarn');
});

test('no findings gives an empty list and a pass count', () => {
  const f = repoFindings({ ...base, hooks: { test: 'pnpm test' } });
  assert.deepEqual(f.problems, []);
  assert.ok(f.passed > 0);
});

test('open attention items are listed once; a hook_missing already found is not repeated', () => {
  const found = repoFindings({ ...base, hooks: { test: 'yarn test' }, onPath: () => false }).problems;
  const items = [
    { kind: 'hook_missing' as const, key: 'hook_missing:r/app/test', message: 'm', since: 's' },
    { kind: 'disk_low' as const, key: 'disk_low:app', message: 'low', since: 's' },
  ];
  assert.deepEqual(attentionProblems(items, found).map((p) => p.kind), ['disk_low']);
});

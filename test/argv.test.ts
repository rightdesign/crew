import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionalArgs, splitConnectArg } from '../src/argv.ts';

test('agents sync --force <route> and <route> --force resolve the same route (CREW-1539)', () => {
  assert.deepEqual(positionalArgs(['agents', 'sync', '--force', 'paradium/issues']), ['agents', 'sync', 'paradium/issues']);
  assert.deepEqual(positionalArgs(['agents', 'sync', 'paradium/issues', '--force']), ['agents', 'sync', 'paradium/issues']);
  assert.deepEqual(positionalArgs(['skills', 'sync', '--dry-run', 'a/b']), ['skills', 'sync', 'a/b']);
});

test('value-taking flags still consume their value', () => {
  assert.deepEqual(positionalArgs(['watch', '--role', 'qa', 'a/b', '--tail', '5']), ['watch', 'a/b']);
  assert.deepEqual(positionalArgs(['agents', 'prompt', 'dev', '--harness', 'codex', 'a/b']), ['agents', 'prompt', 'dev', 'a/b']);
});

import { pickWorktreeRoute, splitWorktreeArgs } from '../src/argv.ts';

test('crew worktree NNN names no route; crew worktree <route> NNN does (CREW-1551)', () => {
  assert.deepEqual(splitWorktreeArgs(['worktree', '1534'], ['issues/issues']), { ticket: '1534' });
  assert.deepEqual(splitWorktreeArgs(['worktree', 'CREW-1534'], ['a/b', 'c/d']), { ticket: 'CREW-1534' });
  assert.deepEqual(splitWorktreeArgs(['worktree', 'a/b', '1534'], ['a/b', 'c/d']), { route: 'a/b', ticket: '1534' });
  assert.deepEqual(splitWorktreeArgs(['worktree', 'a/b'], ['a/b']), { route: 'a/b', ticket: undefined });
});

test('a trailing role word is not read as a route or ticket (CREW-1551)', () => {
  assert.deepEqual(splitWorktreeArgs(['worktree', '1534', 'qa'], ['a/b', 'c/d']), { ticket: '1534' });
  assert.deepEqual(splitWorktreeArgs(['worktree', 'CREW-1534', 'dev'], ['a/b', 'c/d']), { ticket: 'CREW-1534' });
  assert.deepEqual(splitWorktreeArgs(['worktree', 'a/b', '1534', 'design'], ['a/b', 'c/d']), { route: 'a/b', ticket: '1534' });
});

test('pickWorktreeRoute chooses the route that has the ticket and serves its repo (CREW-1551)', () => {
  const two = [
    { route: 'a/issues', hit: undefined, servedRepoIds: ['r1'] },
    { route: 'b/issues', hit: { repoId: 'r2' }, servedRepoIds: ['r2'] },
  ];
  assert.deepEqual(pickWorktreeRoute(7, two), { route: 'b/issues' });
  // ticket found, but no route serves its repo: names the repo and the routes
  const unserved = [
    { route: 'a/issues', hit: { repoId: 'rX' }, servedRepoIds: ['r1'] },
    { route: 'b/issues', hit: undefined, servedRepoIds: ['r2'] },
  ];
  const err = pickWorktreeRoute(7, unserved);
  assert.ok('error' in err);
  assert.match(err.error, /looked on a\/issues, b\/issues/);
  assert.match(err.error, /a\/issues \(repo rX\)/);
  // ticket on no route
  const none = pickWorktreeRoute(7, [{ route: 'a/issues', hit: undefined, servedRepoIds: [] }]);
  assert.ok('error' in none);
  assert.doesNotMatch(none.error, /found it only/);
  // single candidate takes its hit regardless of served repos
  assert.deepEqual(pickWorktreeRoute(7, [{ route: 'a/issues', hit: { repoId: null }, servedRepoIds: [] }]), { route: 'a/issues' });
});

test('splitConnectArg keeps a colon in the workspace part and splits only on the first slash', () => {
  assert.deepEqual(splitConnectArg('a:b'), ['a:b', undefined]);
  assert.deepEqual(splitConnectArg('a:b/c'), ['a:b', 'c']);
  assert.deepEqual(splitConnectArg('a/c'), ['a', 'c']);
  assert.deepEqual(splitConnectArg(undefined), [undefined, undefined]);
});

test('--recipes takes a value, so its id is never a positional (CREW-2317)', () => {
  assert.deepEqual(positionalArgs(['repos', 'hooks', 'p', '--write', 'repo', '--recipes', 'github-actions-release']), ['repos', 'hooks', 'p']);
});

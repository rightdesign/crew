import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envForRepository, eraseRepositoryEnv, readRepositoryEnv, repoEnvPathFor, repositoryEnvCount, writeRepositoryEnv } from '../src/repo-env.ts';

const sets = [
  { repoRowId: 'r1', remote: 'git@github.com:acme/api.git', env: { DATABASE_URL: 'postgres://secret-1' } },
  { remote: 'https://github.com/acme/web.git', env: { DATABASE_URL: 'postgres://secret-2' } },
];

test('a run matches its repository by row id, else by remote; another repository gets nothing', () => {
  assert.deepEqual(envForRepository(sets, { repoRowId: 'r1' }), { DATABASE_URL: 'postgres://secret-1' });
  assert.deepEqual(envForRepository(sets, { remote: 'https://github.com/acme/web' }), { DATABASE_URL: 'postgres://secret-2' });
  assert.deepEqual(envForRepository(sets, { repoRowId: 'r1', remote: 'git@github.com:acme/web.git' }), { DATABASE_URL: 'postgres://secret-1' });
  assert.deepEqual(envForRepository(sets, { repoRowId: 'other', remote: 'git@github.com:acme/else.git' }), {});
  assert.deepEqual(envForRepository(sets, {}), {});
});

test('the set is stored owner-only, replaced wholesale, and a repository omitted from a later set is gone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-env-'));
  writeRepositoryEnv(dir, sets);
  assert.equal(statSync(repoEnvPathFor(dir)).mode & 0o777, 0o600);
  assert.equal(repositoryEnvCount(dir), 2);
  writeRepositoryEnv(dir, [{ repoRowId: 'r1', env: { DATABASE_URL: 'changed' } }]);
  assert.deepEqual(envForRepository(readRepositoryEnv(dir), { repoRowId: 'r1' }), { DATABASE_URL: 'changed' });
  assert.deepEqual(envForRepository(readRepositoryEnv(dir), { remote: 'https://github.com/acme/web' }), {});
  writeRepositoryEnv(dir, []);
  assert.equal(existsSync(repoEnvPathFor(dir)), false);
  writeRepositoryEnv(dir, sets);
  eraseRepositoryEnv(dir);
  assert.equal(repositoryEnvCount(dir), 0);
});

test('malformed entries are dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-env-'));
  writeRepositoryEnv(dir, [{ env: { A: 'x' } }, { repoRowId: 'r', env: { 'bad-name': 'x' } }, { repoRowId: 'r', env: { OK: 'y' } }] as never);
  assert.deepEqual(readRepositoryEnv(dir), [{ repoRowId: 'r', env: { OK: 'y' } }]);
});

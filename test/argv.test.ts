import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionalArgs } from '../src/argv.ts';

test('agents sync --force <route> and <route> --force resolve the same route (CREW-1539)', () => {
  assert.deepEqual(positionalArgs(['agents', 'sync', '--force', 'paradium/issues']), ['agents', 'sync', 'paradium/issues']);
  assert.deepEqual(positionalArgs(['agents', 'sync', 'paradium/issues', '--force']), ['agents', 'sync', 'paradium/issues']);
  assert.deepEqual(positionalArgs(['skills', 'sync', '--dry-run', 'a/b']), ['skills', 'sync', 'a/b']);
});

test('value-taking flags still consume their value', () => {
  assert.deepEqual(positionalArgs(['watch', '--role', 'qa', 'a/b', '--tail', '5']), ['watch', 'a/b']);
  assert.deepEqual(positionalArgs(['agents', 'prompt', 'dev', '--harness', 'codex', 'a/b']), ['agents', 'prompt', 'dev', 'a/b']);
});

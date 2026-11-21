import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleepSync, sleepSyncCheck } from '../src/sleep-sync.ts';

test('sleepSync waits at least the requested time', () => {
  const t = Date.now();
  sleepSync(60);
  assert.ok(Date.now() - t >= 55);
});

test('sleepSync works when SharedArrayBuffer is not a global (the compiled binary)', () => {
  const saved = globalThis.SharedArrayBuffer;
  // @ts-expect-error simulate the compiled runtime, which has no such global
  delete globalThis.SharedArrayBuffer;
  try {
    const t = Date.now();
    sleepSync(60);
    assert.ok(Date.now() - t >= 55);
  } finally {
    globalThis.SharedArrayBuffer = saved;
  }
});

test('sleepSyncCheck passes on the real helper and fails when the helper throws or returns early', () => {
  assert.equal(sleepSyncCheck().ok, true);
  assert.equal(sleepSyncCheck(() => { throw new Error('SharedArrayBuffer is not defined'); }).ok, false);
  assert.equal(sleepSyncCheck(() => {}).ok, false);
});

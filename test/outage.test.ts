import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientError, transientBackoffMs, describeCause } from '../src/outage.ts';
import { runDaemonLoop, type PassResult } from '../src/daemon.ts';

const idle: PassResult = { pending: [], started: [], skipped: [] };
const withCause = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code }) });

test('classifier: each transient cause shape', () => {
  assert.ok(isTransientError(new TypeError('fetch failed')));
  for (const c of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN']) {
    assert.ok(isTransientError(Object.assign(new Error('boom'), { cause: { code: c } })), c);
  }
  assert.ok(isTransientError(new Error('reading the event log failed: HTTP 503')));
  assert.ok(isTransientError(new Error('HTTP 502')));
  assert.ok(isTransientError(new Error('HTTP 504')));
  assert.ok(isTransientError(new SyntaxError(`Unexpected token '<', "<html>" is not valid JSON`)));
});

test('classifier: 401, 422 and bugs are not transient', () => {
  assert.equal(isTransientError(new Error('HTTP 401')), false);
  assert.equal(isTransientError(new Error('HTTP 422')), false);
  assert.equal(isTransientError(new TypeError("Cannot read properties of undefined (reading 'x')")), false);
  assert.equal(isTransientError('fetch failed'), false);
});

test('backoff is 15s, 30s, 60s, then capped', () => {
  assert.deepEqual([1, 2, 3, 4, 9].map(transientBackoffMs), [15_000, 30_000, 60_000, 60_000, 60_000]);
});

test('describeCause is one line and names the code', () => {
  assert.equal(describeCause(withCause('ECONNREFUSED')), 'fetch failed (ECONNREFUSED)');
});

test('loop: backoff sequence, one outage at 5, one recovery, no onPassError', async () => {
  let t = 0;
  const sleeps: number[] = [];
  const log: string[] = [];
  let n = 0;
  await runDaemonLoop({
    runPass: async () => { if (++n <= 6) throw withCause('ECONNREFUSED'); return idle; },
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    onTransient: ({ consecutive }) => log.push(`t${consecutive}`),
    onOutage: ({ consecutive, downMs }) => log.push(`outage${consecutive}@${downMs}`),
    onRecovered: ({ downMs }) => log.push(`back@${downMs}`),
    onPassError: () => log.push('ERROR'),
    maxPasses: 7,
  });
  assert.deepEqual(sleeps.slice(0, 6), [15_000, 30_000, 60_000, 60_000, 60_000, 60_000]);
  assert.deepEqual(log, ['t1', 't2', 't3', 't4', 't5', 'outage5@165000', 't6', 'back@285000']);
});

test('loop: a non-transient failure still reaches onPassError on the first occurrence', async () => {
  const errs: unknown[] = [];
  await runDaemonLoop({
    runPass: async () => { throw new Error('HTTP 401'); },
    sleep: async () => {}, onPassError: (e) => errs.push(e), onTransient: () => assert.fail('transient'),
    maxPasses: 1,
  });
  assert.equal(errs.length, 1);
});

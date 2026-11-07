import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  noteStartFailure, startFailureDelayMs, reportStartFailure, clearStartFailure, readStartFailure,
  DAEMON_START_FAILED_KEY, START_FAILURE_BACKOFF_MS,
} from '../src/daemon-start-failure.ts';
import { openShipAttention } from '../src/ship-attention.ts';
import { Emitter, eventFileFor } from '../src/events.ts';
import { State } from '../src/state.ts';

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-startfail-'));
  const emit = new Emitter({ route: '', eventFile: eventFileFor(dir), console: () => {} });
  return { dir, emit, state: new State(dir) };
};

test('the same reason counts up, a different one starts the run over', () => {
  const { dir } = setup();
  assert.equal(noteStartFailure(dir, 'a', 1000).count, 1);
  assert.equal(noteStartFailure(dir, 'a', 2000).count, 2);
  const third = noteStartFailure(dir, 'b', 3000);
  assert.equal(third.count, 1);
  assert.equal(third.firstAt, new Date(3000).toISOString());
});

test('the first failure exits at once; from the second on the daemon sleeps a minute', () => {
  assert.equal(startFailureDelayMs(1), 0);
  assert.equal(startFailureDelayMs(2), START_FAILURE_BACKOFF_MS);
  assert.equal(startFailureDelayMs(40), START_FAILURE_BACKOFF_MS);
});

test('a startup failure raises the attention item and one error event, then clears on the first pass', async () => {
  const { dir, emit, state } = setup();
  const slept: number[] = [];
  const sleep = async (ms: number) => { slept.push(ms); };
  for (let i = 0; i < 3; i++) {
    await reportStartFailure({ state, stateDir: dir, emit, reason: 'two enabled routes, none named', fix: 'Name a route', logPath: '/x/crew.scheduler.log', sleep });
  }
  const open = openShipAttention(state).filter((x) => x.kind === 'daemon_start_failed');
  assert.equal(open.length, 1);
  assert.equal(open[0]!.key, DAEMON_START_FAILED_KEY);
  assert.match(open[0]!.message, /two enabled routes, none named/);
  assert.match(open[0]!.message, /Name a route/);
  assert.match(open[0]!.message, /crew\.scheduler\.log/);
  assert.deepEqual(slept, [START_FAILURE_BACKOFF_MS, START_FAILURE_BACKOFF_MS]);

  const events = readFileSync(eventFileFor(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.filter((e) => e.level === 'error' && e.step === 'poll').length, 1, 'one error event per run of identical failures');

  clearStartFailure(state, dir);
  assert.equal(openShipAttention(state).filter((x) => x.kind === 'daemon_start_failed').length, 0);
  assert.equal(readStartFailure(dir), null);
  assert.equal(existsSync(join(dir, '.daemon-start-failure.json')), false);
});

test('a throwing publisher does not stop the report', async () => {
  const { dir, emit, state } = setup();
  await reportStartFailure({ state, stateDir: dir, emit, reason: 'r', publish: async () => { throw new Error('no key'); }, sleep: async () => {} });
  assert.equal(openShipAttention(state).length, 1);
});

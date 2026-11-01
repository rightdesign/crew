import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveRuns, settleRunEnd, describeRun, type LiveRun } from '../src/live-runs.ts';
import type { RunSidecar } from '../src/agent.ts';
import type { Route } from '../src/config.ts';
import type { Emitter } from '../src/events.ts';
import type { Tracker } from '../src/tracker.ts';

function sidecar(over: Partial<RunSidecar>): RunSidecar {
  return {
    pid: 100, ownerPid: 1, spawnedAt: '2026-11-01T01:00:00.000Z', role: 'dev', route: 'main', ticket: 'CREW-1',
    ticketRecordId: 'rec-1', model: 'm', toolchain: 't', harness: 'claude', provider: 'anthropic',
    eventsPath: '/tmp/e', promptSha: 'x', ...over,
  };
}

function fixture(files: Array<{ name: string; sc: RunSidecar; finished?: boolean }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'live-runs-'));
  mkdirSync(join(dir, 'streams'));
  for (const f of files) {
    writeFileSync(join(dir, 'streams', `${f.name}.jsonl`), '');
    writeFileSync(join(dir, 'streams', `${f.name}.jsonl.pid`), JSON.stringify(f.sc));
    if (f.finished) writeFileSync(join(dir, 'streams', `${f.name}.jsonl.meta.json`), JSON.stringify({ running: false }));
  }
  return dir;
}

const MAIN = { route: 'main' } as unknown as Route; // settleRunEnd reads only route.route

function fakeTracker() {
  const calls: unknown[][] = [];
  const t = {
    setCrewStatus: async (...a: unknown[]) => { calls.push(['seat', ...a]); },
    beatEngaged: async (...a: unknown[]) => { calls.push(['engaged', ...a]); },
    beatIdle: async (...a: unknown[]) => { calls.push(['idle', ...a]); },
  } as unknown as Tracker; // test double exposing only the three writes settleRunEnd makes
  return { t, calls };
}
const emit = { warn: () => {} } as unknown as Emitter; // settleRunEnd only calls warn

test('liveRuns lists unfinished runs with a live process, oldest first', (t) => {
  const dir = fixture([
    { name: 'b', sc: sidecar({ pid: 2, spawnedAt: '2026-11-01T02:00:00.000Z', ticketRecordId: 'rec-2' }) },
    { name: 'a', sc: sidecar({ pid: 1 }) },
    { name: 'done', sc: sidecar({ pid: 3 }), finished: true },
    { name: 'dead', sc: sidecar({ pid: 4 }) },
  ]);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runs = liveRuns(dir, (sc) => sc.pid !== 4);
  assert.deepEqual(runs.map((r) => r.pid), [1, 2]);
});

test('two dev runs on one seat: the first to finish leaves the seat working on the other ticket, the last one idles it', async (t) => {
  const dir = fixture([
    { name: 'a', sc: sidecar({ pid: 1, ticketRecordId: 'rec-1' }) },
    { name: 'b', sc: sidecar({ pid: 2, ticketRecordId: 'rec-2', spawnedAt: '2026-11-01T02:00:00.000Z' }) },
  ]);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const both = liveRuns(dir, () => true);

  const first = fakeTracker();
  await settleRunEnd({ tracker: first.t, shipName: 'S', route: MAIN, role: 'dev', memberId: 'seat-dev', ownTicketRecordId: 'rec-2', stateDir: dir, emit, runs: both });
  assert.deepEqual(first.calls[0], ['seat', 'seat-dev', 'working', 'rec-1']);
  assert.deepEqual(first.calls[1], ['engaged', 'S', 'main', 'rec-1', '2026-11-01T01:00:00.000Z']);

  const last = fakeTracker();
  await settleRunEnd({ tracker: last.t, shipName: 'S', route: MAIN, role: 'dev', memberId: 'seat-dev', ownTicketRecordId: 'rec-1', stateDir: dir, emit, runs: [both[0]!] });
  assert.deepEqual(last.calls, [['seat', 'seat-dev', 'idle'], ['idle', 'S']]);
});

test('one run per role: the same seat-idle then ship-idle writes, in the same order', async () => {
  const { t, calls } = fakeTracker();
  await settleRunEnd({ tracker: t, shipName: 'S', route: MAIN, role: 'dev', memberId: 'seat-dev', ownTicketRecordId: 'rec-1', stateDir: '/nonexistent', emit, runs: [] });
  assert.deepEqual(calls, [['seat', 'seat-dev', 'idle'], ['idle', 'S']]);
});

test('a live run of another role keeps the ship engaged but lets this seat go idle', async () => {
  const qa = { ...sidecar({ role: 'qa', ticketRecordId: 'rec-9' }), streamPath: '/s' } as LiveRun;
  const { t, calls } = fakeTracker();
  await settleRunEnd({ tracker: t, shipName: 'S', route: MAIN, role: 'dev', memberId: 'seat-dev', ownTicketRecordId: 'rec-1', stateDir: '/x', emit, runs: [qa] });
  assert.deepEqual(calls[0], ['seat', 'seat-dev', 'idle']);
  assert.equal(calls[1]![0], 'engaged');
});

test('describeRun reports the status entry, with the seat only for this route', () => {
  const route = { route: 'main', dir: '/nowhere', repoTargets: [] } as unknown as Route; // only route/dir are read here
  const run = { ...sidecar({ repo: null }), streamPath: '/s/a.jsonl' } as LiveRun;
  assert.deepEqual(describeRun(run, route, { dev: 'seat-dev' }), {
    role: 'dev', seat: 'seat-dev', ticket: 'CREW-1', ticketRecordId: 'rec-1', repo: null, worktree: null,
    stream: '/s/a.jsonl', pid: 100, startedAt: '2026-11-01T01:00:00.000Z',
  });
  assert.equal(describeRun({ ...run, route: 'other' }, route, { dev: 'seat-dev' }).seat, null);
});

test('a live run of the same role on another route does not keep this route\'s seat busy, and the heartbeat names the route, not its slug', async () => {
  const other = { ...sidecar({ route: 'ws-proj', routeName: 'ws/proj', ticketRecordId: 'rec-7' }), streamPath: '/s' } as LiveRun;
  const { t, calls } = fakeTracker();
  await settleRunEnd({ tracker: t, shipName: 'S', route: MAIN, role: 'dev', memberId: 'seat-dev', ownTicketRecordId: 'rec-1', stateDir: '/x', emit, runs: [other] });
  assert.deepEqual(calls[0], ['seat', 'seat-dev', 'idle']);
  assert.deepEqual(calls[1], ['engaged', 'S', 'ws/proj', 'rec-7', '2026-11-01T01:00:00.000Z']);
});

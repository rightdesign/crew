import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Emitter, eventFileFor } from '../src/events.ts';
import { State } from '../src/state.ts';
import type { Route, Ship } from '../src/config.ts';
import type { CycleDecision } from '../src/poll.ts';
import {
  runDaemonLoop, runOnePass, computeTreeSignature, makeStaleChecker,
  type PassResult, type RunOnePassOptions,
} from '../src/daemon.ts';

// ---------------------------------------------------------------------------
// Layer 1: runDaemonLoop — pure scheduler, no tracker/filesystem beyond a
// fresh State dir for the (unused, injected) runPass fake.
// ---------------------------------------------------------------------------

function emptyResult(started: string[] = []): PassResult {
  return { pending: [], started: started as PassResult['started'], skipped: [] };
}

test('chains immediately with no sleep while a pass keeps finding work', async () => {
  const sleeps: number[] = [];
  let call = 0;
  await runDaemonLoop({
    runPass: async () => {
      call++;
      return emptyResult(call <= 3 ? ['dev'] : []);
    },
    sleep: async (ms) => { sleeps.push(ms); },
    // One extra pass beyond the first idle one, so that idle pass's sleep
    // actually runs before maxPasses cuts the loop off (the loop returns
    // immediately once maxPasses is hit, without sleeping that final pass).
    maxPasses: 5,
  });
  assert.equal(call, 5);
  // Passes 1-3 started work and chained with zero sleep; only pass 4 (idle) slept.
  assert.deepEqual(sleeps, [5000]);
});

test('backs off exponentially from the floor up to the ceiling while idle', async () => {
  const sleeps: number[] = [];
  await runDaemonLoop({
    runPass: async () => emptyResult(),
    sleep: async (ms) => { sleeps.push(ms); },
    floorMs: 1000,
    ceilingMs: 8000,
    // See the comment above: one extra pass so the last observed sleep
    // actually records before the loop stops.
    maxPasses: 7,
  });
  assert.deepEqual(sleeps, [1000, 2000, 4000, 8000, 8000, 8000]);
});

test('resets backoff to the floor the instant a pass finds work again', async () => {
  const sleeps: number[] = [];
  let call = 0;
  await runDaemonLoop({
    runPass: async () => {
      call++;
      // Idle for two passes, then one pass with work, then idle again.
      return emptyResult(call === 3 ? ['dev'] : []);
    },
    sleep: async (ms) => { sleeps.push(ms); },
    floorMs: 1000,
    ceilingMs: 8000,
    maxPasses: 5,
  });
  assert.deepEqual(sleeps, [1000, 2000, 1000]);
});

test('stops as soon as the signal is aborted, even mid-idle-backoff', async () => {
  const controller = new AbortController();
  let call = 0;
  await runDaemonLoop({
    runPass: async () => {
      call++;
      if (call === 2) controller.abort();
      return emptyResult();
    },
    sleep: async () => {},
    signal: controller.signal,
  });
  assert.equal(call, 2);
});

test('onPass reports the backoff the loop is about to sleep for, 0 when chaining', () => {
  const observed: Array<{ started: string[]; next: number }> = [];
  let call = 0;
  return runDaemonLoop({
    runPass: async () => {
      call++;
      return emptyResult(call === 1 ? ['dev'] : []);
    },
    sleep: async () => {},
    floorMs: 500,
    maxPasses: 2,
    onPass: (result, nextBackoffMs) => observed.push({ started: result.started, next: nextBackoffMs }),
  }).then(() => {
    assert.deepEqual(observed, [
      { started: ['dev'], next: 0 },
      { started: [], next: 500 },
    ]);
  });
});

test('checkStale is consulted only on an idle pass, and stops the loop with reason "stale"', async () => {
  const sleeps: number[] = [];
  let call = 0;
  let staleChecks = 0;
  const reason = await runDaemonLoop({
    runPass: async () => {
      call++;
      // Busy for the first two passes (checkStale must not even be called
      // then), idle from the third pass on.
      return emptyResult(call <= 2 ? ['dev'] : []);
    },
    checkStale: () => { staleChecks++; return staleChecks >= 2; },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(reason, 'stale');
  assert.equal(call, 4); // 2 busy + 2 idle (first idle checks stale=false and sleeps, second returns)
  assert.equal(staleChecks, 2);
  assert.deepEqual(sleeps, [5000]); // only the first idle pass actually slept
});

test('an aborted signal wins over a pending stale check', async () => {
  const controller = new AbortController();
  let call = 0;
  const reason = await runDaemonLoop({
    runPass: async () => {
      call++;
      if (call === 1) controller.abort();
      return emptyResult();
    },
    checkStale: () => true,
    sleep: async () => {},
    signal: controller.signal,
  });
  assert.equal(reason, 'aborted');
  assert.equal(call, 1);
});

test('maxPasses is reported as its own stop reason, distinct from staleness', async () => {
  const reason = await runDaemonLoop({
    runPass: async () => emptyResult(),
    checkStale: () => false,
    sleep: async () => {},
    maxPasses: 2,
  });
  assert.equal(reason, 'maxPasses');
});

// ---------------------------------------------------------------------------
// computeTreeSignature / makeStaleChecker (ISSUE-764)
// ---------------------------------------------------------------------------

test('computeTreeSignature changes when a watched file is added, touched, or removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-sig-'));
  const srcDir = join(dir, 'src');
  mkdirSync(srcDir);
  writeFileSync(join(srcDir, 'a.ts'), 'one');

  const before = computeTreeSignature([srcDir]);

  writeFileSync(join(srcDir, 'b.ts'), 'two');
  const afterAdd = computeTreeSignature([srcDir]);
  assert.notEqual(before, afterAdd);

  // Bump mtime further forward — a content edit without a forward mtime
  // bump isn't the case this cheap signature is meant to catch (see the
  // file's doc comment: mtime, not a content hash), so this only proves
  // the signature reacts to mtime moving at all, ahead of whatever the
  // newest file already contributed.
  const future = new Date(Date.now() + 60_000);
  utimesSync(join(srcDir, 'a.ts'), future, future);
  const afterTouch = computeTreeSignature([srcDir]);
  assert.notEqual(afterAdd, afterTouch);
});

test('computeTreeSignature treats a missing path as a stable, non-throwing 0', () => {
  const sig = computeTreeSignature(['/definitely/does/not/exist/anywhere']);
  assert.equal(sig, computeTreeSignature(['/definitely/does/not/exist/anywhere']));
});

test('makeStaleChecker reports false until a watched path actually changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-sig-'));
  writeFileSync(join(dir, 'cli.js'), 'v1');
  const isStale = makeStaleChecker([dir]);
  assert.equal(isStale(), false);
  assert.equal(isStale(), false, 'repeated checks with no change stay false');

  const future = new Date(Date.now() + 60_000);
  utimesSync(join(dir, 'cli.js'), future, future);
  assert.equal(isStale(), true);
});

// ---------------------------------------------------------------------------
// Layer 2: runOnePass — deliberate concurrent-slot filling across every
// pending role via the real State.acquireRun lock, with decideCycle and the
// real claim/checkout/spawn sequence both faked out.
// ---------------------------------------------------------------------------

function fakeRoute(): Route {
  return {
    route: 'issues/test',
    enabled: true,
    dir: '/tmp/does-not-matter',
    repos: {},
    baseUrl: 'https://example.test',
    apiKey: 'sk_test',
    hooks: {},
    labels: {},
    release: {},
    repoOverrides: {},
    branch: {},
    resolved: {
      workspaceId: 'ws-1',
      models: { issues: 'issues-model', comments: 'comments-model', crew: 'crew-model' },
      seats: { dev: 'dev-id', qa: 'qa-id', design: 'design-id' },
      operator: 'operator-id',
      holds: [],
    },
  } as unknown as Route;
}

function fakeShip(stateDir: string): Ship {
  return {
    name: 'test-ship',
    platform: 'darwin',
    agent: { bin: 'claude', model: 'sonnet', maxThinkingTokens: 0 },
    useNvm: false,
    stateDir,
    logFile: join(stateDir, 'crew.log'),
    userAgent: 'test-agent',
  } as unknown as Ship;
}

function fakeDecision(pending: CycleDecision['selection']['pending']): CycleDecision {
  const ranks: CycleDecision['selection']['ranks'] = {};
  pending.forEach((role, i) => { ranks[role] = i; });
  return {
    tickets: [],
    comments: [],
    roster: {} as CycleDecision['roster'],
    blocked: new Set(),
    info: {} as CycleDecision['info'],
    sweep: [],
    stranded: [],
    selection: { pending, selected: pending[0] ?? null, ranks, reasons: {} },
    actionable: { top: undefined } as unknown as CycleDecision['actionable'],
    watermark: '2026-08-01T00:00:00Z',
    selectionInput: {} as CycleDecision['selectionInput'],
  };
}

function rig(): { state: State; opts: Omit<RunOnePassOptions, 'decide' | 'spawnRoleAgent'> } {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'));
  const state = new State(dir);
  const route = fakeRoute();
  const ship = fakeShip(dir);
  return {
    state,
    opts: {
      route,
      ship,
      state,
      maxConcurrentAgents: 5,
      newEmitter: () => new Emitter({
        route: route.route,
        eventFile: eventFileFor(dir),
        logFile: ship.logFile,
        console: () => {},
      }),
    },
  };
}

test('runOnePass tries every pending role, most-urgent (lowest rank) first', async () => {
  const { opts } = rig();
  const decision = fakeDecision(['qa', 'dev', 'design']);
  const spawned: string[] = [];
  const result = await runOnePass({
    ...opts,
    decide: async () => decision,
    spawnRoleAgent: async (role) => { spawned.push(role); },
  });
  assert.deepEqual(result.pending, ['qa', 'dev', 'design']);
  assert.deepEqual(result.started, ['qa', 'dev', 'design']);
  assert.deepEqual(spawned, ['qa', 'dev', 'design']);
});

test('runOnePass fills every open slot with a DIFFERENT role, bounded by capacity', async () => {
  const { opts } = rig();
  const decision = fakeDecision(['dev', 'qa', 'design']);
  const spawned: string[] = [];
  const result = await runOnePass({
    ...opts,
    maxConcurrentAgents: 2,
    decide: async () => decision,
    spawnRoleAgent: async (role) => { spawned.push(role); },
  });
  assert.equal(result.started.length, 2);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]!.reason, /at capacity/);
});

test('runOnePass skips a role already running (same role, real acquireRun lock)', async () => {
  const { state, opts } = rig();
  const held = state.acquireRun('dev', 5);
  assert.equal(held.ok, true);
  const decision = fakeDecision(['dev', 'qa']);
  const spawned: string[] = [];
  const result = await runOnePass({
    ...opts,
    decide: async () => decision,
    spawnRoleAgent: async (role) => { spawned.push(role); },
  });
  assert.deepEqual(result.started, ['qa']);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]!.role, 'dev');
  assert.match(result.skipped[0]!.reason, /already running/);
  assert.deepEqual(spawned, ['qa']);
  if (held.ok) held.release();
});

test('runOnePass releases the slot once the spawned agent settles, success or failure', async () => {
  const { state, opts } = rig();
  const decision = fakeDecision(['dev']);
  let resolveSpawn: (() => void) | undefined;
  const spawnStarted = new Promise<void>((resolve) => { resolveSpawn = resolve; });
  const inFlight = new Set<Promise<void>>();
  const result = await runOnePass({
    ...opts,
    inFlight,
    decide: async () => decision,
    spawnRoleAgent: async () => {
      resolveSpawn?.();
      // Never resolves until the test lets it — the lock must still be
      // held while the agent is genuinely still running.
      await new Promise((r) => setTimeout(r, 20));
    },
  });
  assert.deepEqual(result.started, ['dev']);
  await spawnStarted;
  // Still in flight: the role lock must still be held.
  assert.equal(state.acquireRun('dev', 5).ok, false);
  await Promise.all(inFlight);
  // Now released.
  const after = state.acquireRun('dev', 5);
  assert.equal(after.ok, true);
  if (after.ok) after.release();
});

test('runOnePass never awaits the agents it starts — returns as soon as every role is tried', async () => {
  const { opts } = rig();
  const decision = fakeDecision(['dev']);
  let spawnResolved = false;
  const result = await runOnePass({
    ...opts,
    decide: async () => decision,
    spawnRoleAgent: async () => {
      await new Promise((r) => setTimeout(r, 50));
      spawnResolved = true;
    },
  });
  assert.deepEqual(result.started, ['dev']);
  assert.equal(spawnResolved, false, 'runOnePass must return before the agent finishes');
});

test('a spawnRoleAgent that throws is caught and reported, not left to crash the pass', async () => {
  const { opts } = rig();
  const decision = fakeDecision(['dev']);
  const result = await runOnePass({
    ...opts,
    decide: async () => decision,
    spawnRoleAgent: async () => { throw new Error('boom'); },
  });
  assert.deepEqual(result.started, ['dev']);
});

test('a role with no rank sorts last rather than crashing the pass', async () => {
  const { opts } = rig();
  const decision = fakeDecision(['dev', 'qa']);
  delete decision.selection.ranks.dev;
  const spawned: string[] = [];
  const result = await runOnePass({
    ...opts,
    decide: async () => decision,
    spawnRoleAgent: async (role) => { spawned.push(role); },
  });
  assert.deepEqual(result.started, ['qa', 'dev']);
});

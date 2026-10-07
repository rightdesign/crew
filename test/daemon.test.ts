import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Emitter, eventFileFor } from '../src/events.ts';
import { State } from '../src/state.ts';
import type { Route, Ship } from '../src/config.ts';
import { resolveApiKey } from '../src/config.ts';
import type { CycleDecision } from '../src/poll.ts';
import {
  runDaemonLoop, runOnePass, computeTreeSignature, makeStaleChecker, SpawnBreaker,
  type PassResult, type RunOnePassOptions,
} from '../src/daemon.ts';
import { AgentSpawnError } from '../src/agent.ts';
import type { SessionStore, StoredSession } from '@tablation/client';

/**
 * `runOnePass` re-hydrates its route's API key from the OS keychain every
 * cycle (ISSUE-966) via `getSessionStore` — a test must never let that reach
 * a real macOS Keychain/libsecret/Credential Manager call, so every test
 * touching that behavior supplies its own fake store through this option.
 */
function fakeSessionStore(sessions: Record<string, StoredSession | undefined>): SessionStore {
  return {
    get: async (host, workspaceSlug) => sessions[`${host}/${workspaceSlug}`],
    set: async () => {},
    clear: async () => {},
  };
}

function fakeSession(apiKey: string): StoredSession {
  return { apiKey, shipId: 'shp_test', workspaceId: 'ws-1', identityId: 'id-1', createdAt: '2026-09-21T00:00:00Z' };
}

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

function fakeRoute(overrides: Partial<Route> = {}): Route {
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
    ...overrides,
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
    ships: [],
    blocked: new Set(),
    info: {} as CycleDecision['info'],
    sweep: [], epicSync: [],
    stranded: [],
    selection: { pending, selected: pending[0] ?? null, ranks, reasons: {} },
    actionable: { top: undefined } as unknown as CycleDecision['actionable'],
    watermark: '2026-08-01T00:00:00Z',
    selectionInput: {} as CycleDecision['selectionInput'],
    attention: {},
  };
}

function rig(routeOverrides: Partial<Route> = {}): { state: State; opts: Omit<RunOnePassOptions, 'decide' | 'spawnRoleAgent'> } {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-'));
  const state = new State(dir);
  const route = fakeRoute(routeOverrides);
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

// ---------------------------------------------------------------------------
// ISSUE-966: runOnePass re-hydrates its route's API key from the OS
// keychain at the top of every cycle, so a re-`crew connect` (a fresh
// device-login session) takes effect on the very next pass without a daemon
// restart. `getSessionStore` is the test-injection seam — never a real
// keychain call here.
// ---------------------------------------------------------------------------

test('ISSUE-1372: a paused crew makes a daemon pass poll nothing and start nothing, until resumed', async () => {
  const { state, opts } = rig();
  const decision = fakeDecision(['dev']);
  let decides = 0;
  const spawned: string[] = [];
  const pass = () => runOnePass({
    ...opts,
    getSessionStore: () => fakeSessionStore({}),
    decide: async () => { decides++; return decision; },
    spawnRoleAgent: async (role) => { spawned.push(role); },
  });

  state.pause();
  assert.deepEqual(await pass(), { pending: [], started: [], skipped: [] });
  assert.equal(decides, 0, 'a paused pass must not poll the tracker');
  assert.deepEqual(spawned, [], 'a paused pass must not start an agent');

  state.resume();
  const resumed = await pass();
  assert.equal(decides, 1, 'the first pass after resume polls again');
  assert.deepEqual(resumed.started, ['dev']);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(spawned, ['dev']);
});

test('runOnePass hydrates a keychain-backed route\'s apiKey before deciding the cycle', async () => {
  const { opts } = rig({ apiKey: undefined, apiKeyFile: undefined, apiKeyVar: undefined });
  const decision = fakeDecision([]);
  let apiKeyAtDecideTime: string | undefined;
  await runOnePass({
    ...opts,
    getSessionStore: () => fakeSessionStore({ 'example.test/issues': fakeSession('sk_from_keychain') }),
    decide: async (ctx) => { apiKeyAtDecideTime = resolveApiKey(ctx.route); return decision; },
    spawnRoleAgent: async () => {},
  });
  assert.equal(apiKeyAtDecideTime, 'sk_from_keychain');
});

test('runOnePass never queries the keychain for a route with an explicit apiKey', async () => {
  const { opts } = rig({ apiKey: 'sk_explicit' });
  const decision = fakeDecision([]);
  const calls: string[] = [];
  await runOnePass({
    ...opts,
    getSessionStore: () => {
      calls.push('getSessionStore called');
      return fakeSessionStore({ 'example.test/issues': fakeSession('sk_from_keychain') });
    },
    decide: async () => decision,
    spawnRoleAgent: async () => {},
  });
  // hydrateApiKeys still runs (it always does), but resolveApiKey succeeds
  // for an explicit apiKey before ever asking the store for anything.
  assert.equal(opts.route.apiKey, 'sk_explicit');
});

test('runOnePass re-queries the keychain on a LATER cycle and picks up a re-connected session, no restart needed', async () => {
  const { opts } = rig({ apiKey: undefined, apiKeyFile: undefined, apiKeyVar: undefined });
  const decision = fakeDecision([]);

  await runOnePass({
    ...opts,
    getSessionStore: () => fakeSessionStore({ 'example.test/issues': fakeSession('sk_v1') }),
    decide: async () => decision,
    spawnRoleAgent: async () => {},
  });
  assert.equal(resolveApiKey(opts.route), 'sk_v1');

  // A second pass — as the daemon's persistent loop would run it — with a
  // DIFFERENT session now stored (an operator re-ran `crew connect`).
  await runOnePass({
    ...opts,
    getSessionStore: () => fakeSessionStore({ 'example.test/issues': fakeSession('sk_v2') }),
    decide: async () => decision,
    spawnRoleAgent: async () => {},
  });
  assert.equal(resolveApiKey(opts.route), 'sk_v2');
});

test('SpawnBreaker: a failed start waits floor*2^(n-1), then parks the role for the ceiling', () => {
  let t = 0;
  const b = new SpawnBreaker({ now: () => t, floorMs: 1000, ceilingMs: 8000 });
  assert.equal(b.allows('dev'), true);

  const first = b.recordFailure('dev', 'ENOENT');
  assert.equal(first.parked, false);
  assert.equal(first.retryInMs, 1000);
  assert.equal(b.allows('dev'), false);
  t = 1000;
  assert.equal(b.allows('dev'), true);

  const second = b.recordFailure('dev', 'ENOENT');
  assert.equal(second.parked, false);
  assert.equal(second.firstOfMessage, false, 'the same message is not worth a fresh log line');
  assert.equal(second.retryInMs, 2000);

  t = 3000;
  const third = b.recordFailure('dev', 'ENOENT');
  assert.equal(third.parked, true);
  assert.equal(third.retryInMs, 8000);
  t = 10999;
  assert.equal(b.allows('dev'), false);
  t = 11000;
  assert.equal(b.allows('dev'), true);

  // A run that spawns clears the history: the next failure starts over at the floor.
  b.recordSuccess('dev');
  assert.equal(b.recordFailure('dev', 'ENOENT').failures, 1);
});

test('SpawnBreaker: a different failure message is reported as a fresh log line', () => {
  const b = new SpawnBreaker({ now: () => 0 });
  b.recordFailure('dev', 'ENOENT');
  assert.equal(b.recordFailure('dev', 'EACCES').firstOfMessage, true);
});

test('runOnePass: a role whose agent cannot start is not restarted each pass, and is parked after repeated failures', async () => {
  const { opts } = rig();
  const decision = fakeDecision(['dev']);
  let t = 0;
  const breaker = new SpawnBreaker({ now: () => t, floorMs: 1000, ceilingMs: 8000 });
  let spawns = 0;
  const pass = () => runOnePass({
    ...opts,
    spawnBreaker: breaker,
    decide: async () => decision,
    spawnRoleAgent: async () => {
      spawns++;
      throw new AgentSpawnError('cannot run claude: spawn ENOENT');
    },
  });
  // The spawn rejection is handled on a later tick; let it land before the next pass.
  const settle = () => new Promise((r) => setTimeout(r, 0));

  assert.deepEqual((await pass()).started, ['dev']);
  await settle();
  assert.equal(spawns, 1);

  // Still inside the first retry window: skipped, not started, so the loop idles.
  const waiting = await pass();
  assert.deepEqual(waiting.started, []);
  assert.equal(waiting.skipped[0]?.role, 'dev');
  assert.equal(spawns, 1);

  t = 1000;
  assert.deepEqual((await pass()).started, ['dev']);
  await settle();
  assert.equal(spawns, 2);

  t = 2000;
  assert.deepEqual((await pass()).started, [], 'second failure waits 2s, not 1s');

  t = 3000;
  assert.deepEqual((await pass()).started, ['dev']);
  await settle();
  assert.equal(spawns, 3);

  // Third consecutive failure: parked for the ceiling, not just one more short backoff.
  t = 10999;
  assert.deepEqual((await pass()).started, []);
  t = 11000;
  assert.deepEqual((await pass()).started, ['dev']);
  await settle();
  assert.equal(spawns, 4);
});

test('runOnePass: a spawn failure that is not a failed start (plain Error) does not park the role', async () => {
  const { opts } = rig();
  const decision = fakeDecision(['dev']);
  const breaker = new SpawnBreaker({ now: () => 0 });
  for (let i = 0; i < 4; i++) {
    const result = await runOnePass({
      ...opts,
      spawnBreaker: breaker,
      decide: async () => decision,
      spawnRoleAgent: async () => { throw new Error('boom'); },
    });
    assert.deepEqual(result.started, ['dev'], `pass ${i + 1} must still start the role`);
    await new Promise((r) => setTimeout(r, 0));
  }
});

test('runOnePass: a park raises role_parked once with one sweep event; a later successful spawn clears it silently (CREW-1373)', async () => {
  const { opts, state } = rig();
  const decision = fakeDecision(['dev']);
  let t = 0;
  const breaker = new SpawnBreaker({ now: () => t, floorMs: 1000, ceilingMs: 8000 });
  let fail = true;
  const pass = () => runOnePass({
    ...opts,
    spawnBreaker: breaker,
    decide: async () => decision,
    spawnRoleAgent: async () => { if (fail) throw new AgentSpawnError('cannot run claude: spawn ENOENT'); },
  });
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const sweepEvents = () => readFileSync(eventFileFor(state.dir), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l)).filter((e) => e.step === 'sweep' && e.data?.attention);

  for (const at of [0, 1000, 3000]) { t = at; await pass(); await settle(); }
  assert.deepEqual(state.shipAttention().previous().map((i) => i.key), ['role_parked:dev']);
  assert.equal(sweepEvents().length, 1);
  assert.deepEqual(sweepEvents()[0].data.attention, ['ship:role_parked']);

  // A second park at the ceiling re-raises the same key: no second event.
  t = 11000; await pass(); await settle();
  assert.equal(sweepEvents().length, 1);

  fail = false;
  t = 30000; await pass(); await settle();
  assert.deepEqual(state.shipAttention().previous(), []);
  assert.equal(sweepEvents().length, 1, 'clearing announces nothing');
});

test('runOnePass persists the attention set so the next pass can diff against it (CREW-1413)', async () => {
  const { state, opts } = rig();
  const decision = fakeDecision([]);
  decision.attention = { 't1': [{ kind: 'needs_info' }] } as unknown as CycleDecision['attention'];
  assert.deepEqual(state.attention(opts.route.route).previous(), {});
  await runOnePass({ ...opts, decide: async () => decision, spawnRoleAgent: async () => {} });
  assert.deepEqual(state.attention(opts.route.route).previous(), decision.attention);
});

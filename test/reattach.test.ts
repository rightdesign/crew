import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnAgent, reattachRun, readRunSidecar, runIsAlive, pidPathFor, type AgentPlan, type RunSidecar } from '../src/agent.ts';
import { Emitter } from '../src/events.ts';
import { reconcileRuns, resetReconcileForTests, orphanedStreams } from '../src/interrupted.ts';
import { State } from '../src/state.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const LINGER = join(FIXTURES, 'fake-claude-stream-linger.mjs');
const SPAWN_AND_WAIT = join(FIXTURES, 'spawn-and-wait.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const pgidOf = (pid: number): number => Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-reattach-'));
  const streams = join(dir, 'streams');
  mkdirSync(streams, { recursive: true });
  const go = join(dir, 'go');
  const plan = (cycle = 'c1'): AgentPlan => ({
    role: 'dev', route: 'proj', cwd: dir, bin: process.execPath, args: [LINGER],
    prompt: 'p', promptBytes: 1, unsetEnv: [], setEnv: { LINGER_GO: go }, digestAttached: false,
    model: 'm', streamPath: join(streams, `proj-dev-${cycle}.jsonl`), eventsPath: join(streams, `proj-dev-${cycle}.events.jsonl`),
    ticket: 'ISSUE-7', ticketRecordId: 'row-7', promptSha: 'sha',
    agentLog: { baseUrl: 'https://example.test', workspaceId: 'ws-1', apiKey: 'sk_secret', userAgent: 'ua' },
  });
  const emitter = (lines: string[] = []) => {
    const e = new Emitter({ route: 'proj', cycleId: 'c1', console: (l) => lines.push(l) });
    e.enter('agent', 'dev');
    return e;
  };
  return { dir, streams, go, plan, emitter };
}

function mockFetch() {
  const original = globalThis.fetch;
  const calls: Array<{ key: string; body: any }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ key: `${init?.method ?? 'GET'} ${url.pathname}`, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return new Response(JSON.stringify({ id: 'log-1' }), { status: 200 });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, calls };
}

const deadPid = (): number => {
  const r = spawnSync(process.execPath, ['-e', '']);
  return (r as unknown as { pid: number }).pid;
};

test('spawnAgent runs the agent in its own process group and leaves a pid sidecar with no secret in it', async () => {
  const r = rig();
  const plan = r.plan();
  const run = spawnAgent(plan, r.emitter());
  await until(() => readRunSidecar(plan.streamPath) !== null, 'the pid sidecar');
  const sc = readRunSidecar(plan.streamPath)!;
  assert.notEqual(pgidOf(sc.pid), pgidOf(process.pid), 'the agent must not share the daemon\'s process group');
  assert.equal(sc.ownerPid, process.pid);
  assert.equal(sc.ticketRecordId, 'row-7');
  assert.equal(sc.agentLog?.workspaceId, 'ws-1');
  assert.ok(!readFileSync(pidPathFor(plan.streamPath), 'utf8').includes('sk_secret'));
  assert.ok(runIsAlive(sc));
  writeFileSync(r.go, '');
  assert.equal((await run).code, 0);
  assert.match(readFileSync(plan.streamPath, 'utf8'), /"type":"result"/);
  assert.equal(JSON.parse(readFileSync(`${plan.streamPath}.meta.json`, 'utf8')).exitCode, 0);
});

test('an agent outlives the death of the process group that spawned it, and a later process finishes it', async (t) => {
  const r = rig();
  const plan = r.plan();
  const planFile = join(r.dir, 'plan.json');
  writeFileSync(planFile, JSON.stringify(plan));
  // The stand-in daemon is a group leader of its own, so killing its group is
  // what launchd does when it relaunches the real one.
  const daemon = spawn(process.execPath, ['--experimental-strip-types', SPAWN_AND_WAIT, planFile], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-daemon.pid!, 'SIGKILL'); } catch { /* gone */ } });
  await until(() => readRunSidecar(plan.streamPath) !== null, 'the pid sidecar');
  const sc = readRunSidecar(plan.streamPath)!;
  assert.equal(sc.ownerPid, daemon.pid);

  process.kill(-daemon.pid!, 'SIGKILL');
  await until(() => { try { process.kill(daemon.pid!, 0); return false; } catch { return true; } }, 'the stand-in daemon to die');
  await sleep(300);
  assert.ok(runIsAlive(sc), 'the agent must still be running');

  // It is an orphan now: sidecar, no meta, owner gone.
  assert.deepEqual(orphanedStreams({ stateDir: r.dir, routeLabel: 'proj' }).map((o) => o.streamPath), [plan.streamPath]);

  writeFileSync(r.go, '');   // the agent finishes after its parent is gone — its writes must not hit a dead pipe
  await until(() => !runIsAlive(sc), 'the agent to exit');
  assert.match(readFileSync(plan.streamPath, 'utf8'), /"type":"result"/);

  const lines: string[] = [];
  const res = await reattachRun(plan.streamPath, sc, r.emitter(lines), { pollMs: 20 });
  assert.equal(res.adopted, false);
  assert.equal(res.interrupted, undefined, 'its stream ends in a result, so it completed');
  const meta = JSON.parse(readFileSync(`${plan.streamPath}.meta.json`, 'utf8'));
  assert.equal(meta.exitCode, null);
  assert.equal(meta.numTurns, 3);
  assert.ok(lines.some((l) => l.includes('agent run finished')), lines.join('\n'));
});

test('a run found dead with no result is reported as interrupted: meta, event and Agent Log row', async (t) => {
  const r = rig();
  const plan = r.plan();
  writeFileSync(plan.streamPath, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at ISSUE-7.' }] } })}\n`);
  const sc: RunSidecar = {
    pid: deadPid(), ownerPid: deadPid(), spawnedAt: new Date(Date.now() - 60_000).toISOString(), role: 'dev', route: 'proj',
    ticket: 'ISSUE-7', ticketRecordId: 'row-7', model: 'm', toolchain: 'claude', harness: 'claude', provider: 'anthropic',
    eventsPath: plan.eventsPath, agentLog: { baseUrl: 'https://example.test', workspaceId: 'ws-1', userAgent: 'ua' }, promptSha: 'sha',
  };
  const { restore, calls } = mockFetch();
  t.after(restore);
  const lines: string[] = [];
  const res = await reattachRun(plan.streamPath, sc, r.emitter(lines), { agentLogKey: 'k' });

  assert.equal(res.adopted, false);
  assert.equal(res.interrupted, 'daemon-exit');
  const meta = JSON.parse(readFileSync(`${plan.streamPath}.meta.json`, 'utf8'));
  assert.equal(meta.exitCode, null);
  assert.equal(meta.interrupted, 'daemon-exit');
  assert.ok(lines.some((l) => l.includes('agent run interrupted')), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('agent run finished')));
  assert.equal(calls[0]!.key, 'POST /api/workspaces/ws-1/agents/log');
  assert.equal(calls[0]!.body.outcome, 'interrupted');
  assert.equal(calls[0]!.body.ticketReference, 'ISSUE-7');
  assert.equal(calls[1]!.body.thinking, 'Looking at ISSUE-7.');
});

test('a sidecar whose pid now belongs to an unrelated process is not mistaken for the run', () => {
  // This test process is alive, but nothing started it a minute ago.
  assert.equal(runIsAlive({ pid: process.pid, spawnedAt: new Date(Date.now() - 3_600_000).toISOString() }), false);
  assert.equal(runIsAlive({ pid: deadPid(), spawnedAt: new Date().toISOString() }), false);
});

test('reconcile reports a dead run once, tells the follow-up, and leaves a live owner\'s run alone', async () => {
  resetReconcileForTests();
  const r = rig();
  const state = new State(mkdtempSync(join(tmpdir(), 'crew-reattach-state-')));
  const dead = r.plan('dead');
  const owned = r.plan('owned');
  writeFileSync(dead.streamPath, '');
  writeFileSync(owned.streamPath, '');
  const base = { role: 'dev', route: 'proj', ticket: 'ISSUE-7', ticketRecordId: 'row-7', model: 'm', toolchain: 'claude', harness: 'claude', provider: 'anthropic', promptSha: 's' } as const;
  const side = (p: AgentPlan, pid: number, ownerPid: number): RunSidecar => ({ ...base, pid, ownerPid, spawnedAt: new Date().toISOString(), eventsPath: p.eventsPath });
  writeFileSync(pidPathFor(dead.streamPath), JSON.stringify(side(dead, deadPid(), deadPid())));
  writeFileSync(pidPathFor(owned.streamPath), JSON.stringify(side(owned, deadPid(), process.pid)));

  const followed: Array<[string, string | undefined]> = [];
  const opts = {
    stateDir: r.dir, routeLabel: 'proj', emit: r.emitter(), state, maxConcurrentAgents: 2,
    afterRun: async (sc: RunSidecar, res: { interrupted?: string }) => { followed.push([sc.ticketRecordId!, res.interrupted]); },
  };
  assert.deepEqual(await reconcileRuns(opts), { adopted: 0, interrupted: 1 });
  assert.deepEqual(followed, [['row-7', 'daemon-exit']]);
  assert.ok(existsSync(`${dead.streamPath}.meta.json`));
  assert.ok(!existsSync(`${owned.streamPath}.meta.json`), 'a run whose own process is alive is that process\'s to finish');

  assert.deepEqual(await reconcileRuns(opts), { adopted: 0, interrupted: 0 });
  assert.equal(followed.length, 1);
});

test('reconcile adopts a live run: it holds its role and a capacity slot until it exits', async () => {
  resetReconcileForTests();
  const r = rig();
  const state = new State(mkdtempSync(join(tmpdir(), 'crew-reattach-state-')));
  const plan = r.plan('live');
  writeFileSync(plan.streamPath, `${JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0.01 })}\n`);
  const sc: RunSidecar = {
    pid: 999_999, ownerPid: deadPid(), spawnedAt: new Date().toISOString(), role: 'dev', route: 'proj', ticket: 'ISSUE-7',
    ticketRecordId: 'row-7', model: 'm', toolchain: 'claude', harness: 'claude', provider: 'anthropic', eventsPath: plan.eventsPath, promptSha: 's',
  };
  writeFileSync(pidPathFor(plan.streamPath), JSON.stringify(sc));

  let alive = true;
  const inFlight = new Set<Promise<void>>();
  const followed: string[] = [];
  const out = await reconcileRuns({
    stateDir: r.dir, routeLabel: 'proj', emit: r.emitter(), state, maxConcurrentAgents: 1, inFlight, pollMs: 10,
    isAlive: () => alive,
    afterRun: async (_sc, res) => { followed.push(res.interrupted ?? 'completed'); },
  });
  assert.deepEqual(out, { adopted: 0, interrupted: 0 }, 'the count lands when the adopted run ends');
  assert.equal(inFlight.size, 1);

  const sameRole = state.acquireRun('dev', 1);
  assert.equal(sameRole.ok, false, 'the adopted run keeps its role busy');
  const otherRole = state.acquireRun('qa', 1);
  assert.equal(otherRole.ok, false, 'and counts toward maxConcurrentAgents');

  alive = false;
  await Promise.all(inFlight);
  assert.deepEqual(followed, ['completed']);
  assert.ok(existsSync(`${plan.streamPath}.meta.json`));
  const freed = state.acquireRun('dev', 1);
  assert.equal(freed.ok, true);
  if (freed.ok) freed.release();
});

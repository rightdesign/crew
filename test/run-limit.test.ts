import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { spawnAgent, reattachRun, readRunSidecar, type AgentPlan, type RunSidecar } from '../src/agent.ts';
import { Emitter, type CrewEvent } from '../src/events.ts';
import { deadlineFor, msUntilDeadline, resolveMaxRunMinutes, runKilledComment, DEFAULT_MAX_RUN_MINUTES } from '../src/run-limit.ts';
import { loadConfig, ConfigError, MAX_RUN_MINUTES_CEILING } from '../src/config.ts';

const LINGER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude-stream-linger.mjs');

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-runlimit-'));
  const streams = join(dir, 'streams');
  mkdirSync(streams, { recursive: true });
  const events: CrewEvent[] = [];
  const emitter = () => {
    const e = new Emitter({ route: 'proj', cycleId: 'c1', console: () => {}, eventFile: join(dir, 'events.jsonl') });
    e.enter('agent', 'dev');
    return e;
  };
  const plan = (maxRunMinutes: number | undefined): AgentPlan => ({
    role: 'dev', route: 'proj', cwd: dir, bin: process.execPath, args: [LINGER],
    prompt: 'p', promptBytes: 1, unsetEnv: [], setEnv: { LINGER_GO: join(dir, 'never') }, digestAttached: false,
    model: 'm', streamPath: join(streams, 'proj-dev-c1.jsonl'), eventsPath: join(streams, 'proj-dev-c1.events.jsonl'),
    ticket: 'ISSUE-7', ticketRecordId: 'row-7', promptSha: 'sha', ...(maxRunMinutes !== undefined ? { maxRunMinutes } : {}),
  });
  const logged = (): CrewEvent[] =>
    readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as CrewEvent).concat(events);
  return { dir, emitter, plan, logged };
}

test('the limit is the route\'s, else the toolchain\'s, else the ship default; 0 means none', () => {
  assert.equal(resolveMaxRunMinutes(30, 60), 30);
  assert.equal(resolveMaxRunMinutes(undefined, 60), 60);
  assert.equal(resolveMaxRunMinutes(undefined, undefined), DEFAULT_MAX_RUN_MINUTES);
  assert.equal(resolveMaxRunMinutes(0, 60), 0);
  assert.equal(deadlineFor('2026-01-01T00:00:00.000Z', 0), undefined);
  assert.equal(deadlineFor('2026-01-01T00:00:00.000Z', 90), '2026-01-01T01:30:00.000Z');
  assert.equal(msUntilDeadline(undefined), undefined);
  assert.ok(msUntilDeadline('2000-01-01T00:00:00.000Z')! < 0);
});

test('a run past its limit is killed, run_killed is recorded, and the sidecar carried the deadline', async () => {
  const r = rig();
  const plan = r.plan(0.02);   // 1.2 s
  const result = await spawnAgent(plan, r.emitter());
  assert.ok(result.killed, 'the result says the daemon killed it');
  assert.equal(result.killed!.limitMinutes, 0.02);
  const sc = readRunSidecar(plan.streamPath)!;
  assert.ok(sc.deadline, 'the sidecar names the deadline');
  assert.equal(Date.parse(sc.deadline!) - Date.parse(sc.spawnedAt), 1200);
  const killedEvent = r.logged().find((e) => e.data?.event === 'run_killed');
  assert.ok(killedEvent, 'a run_killed event is on the stream');
  assert.equal(killedEvent!.data!.reason, 'wall-clock');
  assert.ok((killedEvent!.data!.elapsedMs as number) >= 1000);
  assert.ok(r.logged().some((e) => e.message.startsWith('agent run interrupted')));
  const meta = JSON.parse(readFileSync(`${plan.streamPath}.meta.json`, 'utf8'));
  assert.equal(meta.interrupted, 'wall-clock');
});

test('a run with no limit is not killed and carries no deadline', async () => {
  const r = rig();
  const plan = r.plan(0);
  writeFileSync(join(r.dir, 'never'), '');   // let it finish on its own
  const result = await spawnAgent(plan, r.emitter());
  assert.equal(result.killed, undefined);
  assert.equal(readRunSidecar(plan.streamPath)!.deadline, undefined);
});

test('a restarted daemon that adopts a live run enforces the ORIGINAL deadline', async () => {
  const r = rig();
  const plan = r.plan(undefined);
  writeFileSync(plan.streamPath, '');
  const child = spawn(process.execPath, [LINGER], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, LINGER_GO: join(r.dir, 'never') } });
  child.stdin!.end('p');
  const spawnedAt = new Date(Date.now() - 3_600_000).toISOString();
  const sc: RunSidecar = {
    pid: child.pid!, ownerPid: 999999, spawnedAt, deadline: new Date(Date.now() - 1000).toISOString(), maxRunMinutes: 30,
    role: 'dev', route: 'proj', ticket: 'ISSUE-7', ticketRecordId: 'row-7', model: 'm', toolchain: 'claude', harness: 'claude',
    provider: 'anthropic', eventsPath: plan.eventsPath, promptSha: 'sha',
  };
  let alive = true;
  child.on('exit', () => { alive = false; });
  const res = await reattachRun(plan.streamPath, sc, r.emitter(), { pollMs: 20, isAlive: () => alive });
  assert.equal(res.adopted, true);
  assert.equal(res.interrupted, 'wall-clock');
  assert.equal(res.killed?.limitMinutes, 30);
  assert.ok(r.logged().some((e) => e.data?.event === 'run_killed'));
});

test('the hand-back comment names the limit and the worktree state', () => {
  const c = runKilledComment({ limitMinutes: 240, branch: 'crew-7', dirty: true });
  assert.match(c, /wall-clock limit of 240 minutes/);
  assert.match(c, /`crew-7`/);
  assert.match(c, /uncommitted/);
});

const CFG = (shipExtra: string, routeExtra = '') => `ship:
  agent: { bin: /bin/true }
  toolchains:
    claude2: { harness: claude${shipExtra} }
routes:
  - route: acme/proj
    dir: /tmp/x
    baseUrl: https://example.test
    apiKey: k${routeExtra}
`;
function load(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-runlimit-cfg-'));
  const file = join(dir, 'crew.yaml');
  writeFileSync(file, text);
  return () => loadConfig(dir, file);
}

test('maxRunMinutes parses on a toolchain and a route, and rejects junk', () => {
  const cfg = load(CFG(', maxRunMinutes: 90', '\n    maxRunMinutes: 30'))();
  assert.equal(cfg.ship.toolchains![0]!.maxRunMinutes, 90);
  assert.equal(cfg.routes[0]!.maxRunMinutes, 30);
  assert.throws(load(CFG(', maxRunMinutes: -1')), ConfigError);
  // A value past the timer range would be clamped to 1 ms by Node and kill every run at once.
  assert.throws(load(CFG(', maxRunMinutes: 100000')), /use 0 for no limit/);
  assert.throws(load(CFG('', '\n    maxRunMinutes: 100000')), ConfigError);
  assert.equal(load(CFG(`, maxRunMinutes: ${MAX_RUN_MINUTES_CEILING}`))().ship.toolchains![0]!.maxRunMinutes, MAX_RUN_MINUTES_CEILING);
  assert.equal(load(CFG(', maxRunMinutes: 0'))().ship.toolchains![0]!.maxRunMinutes, 0);
  assert.throws(load(CFG('', '\n    maxRunMinutes: soon')), ConfigError);
});

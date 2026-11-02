import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, readdirSync, chmodSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { spawnAgent, reattachRun, readRunSidecar, type AgentPlan, type RunSidecar } from '../src/agent.ts';
import { Emitter, type CrewEvent } from '../src/events.ts';
import { SandboxRunner, checkSandboxRunner, sandboxName, shQuote, SANDBOX_STDIN_LIMIT } from '../src/runner.ts';
import { parseShipSandbox, ConfigError } from '../src/config.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAKE_OS = join(FIX, 'fake-openshell.mjs');
const STREAM = join(FIX, 'fake-claude-stream.mjs');
const LINGER = join(FIX, 'fake-claude-stream-linger.mjs');

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-sandbox-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
  const osDir = join(dir, 'os');
  mkdirSync(osDir);
  const bin = join(dir, 'openshell');
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_OS)} "$@"\n`);
  chmodSync(bin, 0o755);
  process.env.FAKE_OS_DIR = osDir;
  // What `--env-from` would carry into a real sandbox; the fake runs the harness on the host.
  process.env.LINGER_GO = join(dir, 'never');
  const streams = join(dir, 'streams');
  mkdirSync(streams);
  const emitter = () => {
    const e = new Emitter({ route: 'proj', cycleId: 'c1', console: () => {}, eventFile: join(dir, 'events.jsonl') });
    e.enter('agent', 'dev');
    return e;
  };
  const plan = (script: string, extra: Partial<AgentPlan> = {}): AgentPlan => ({
    role: 'dev', route: 'proj', cwd: dir, bin: process.execPath, args: [script],
    prompt: 'p', promptBytes: 1, unsetEnv: [], setEnv: { CREW_API_KEY: 'sk-secret-value', LINGER_GO: join(dir, 'never') },
    digestAttached: false, model: 'm', streamPath: join(streams, 'proj-dev-c1.jsonl'), eventsPath: join(streams, 'proj-dev-c1.events.jsonl'),
    ticket: 'ISSUE-7', ticketRecordId: 'row-7', promptSha: 'sha', runner: 'sandbox',
    sandboxConfig: { bin, agentBin: process.execPath, cacheVolume: 'cache-vol', policy: '/p.yaml' }, ...extra,
  });
  const calls = (): Array<{ argv: string[]; env: Record<string, string | null> }> =>
    readFileSync(join(osDir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const logged = (): CrewEvent[] => readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as CrewEvent);
  return { dir, osDir, bin, emitter, plan, calls, logged };
}

// The runner reads the checkout's origin; tests have no git remote.
const withOrigin = (cfg: ConstructorParameters<typeof SandboxRunner>[0]) => new SandboxRunner(cfg, () => 'git@github.com:acme/widgets.git');

test('a sandbox run creates, clones from the mirror, execs, streams into the stream file and deletes', async () => {
  const r = rig();
  const plan = r.plan(STREAM);
  const result = await spawnAgent(plan, r.emitter());
  assert.equal(result.code, 0);
  const stream = readFileSync(plan.streamPath, 'utf8');
  assert.match(stream, /"type":"result"/, 'the harness output landed in the stream file');
  assert.deepEqual(readdirSync(join(r.osDir, 'sandboxes')), [], 'the sandbox was deleted on exit');
  const verbs = r.calls().map((c) => c.argv.slice(0, 2).join(' '));
  assert.deepEqual(verbs.filter((v) => v.startsWith('sandbox')), ['sandbox create', 'sandbox exec', 'sandbox exec', 'sandbox delete']);
  const names = r.logged().map((e) => e.data?.event);
  assert.ok(names.includes('sandbox_created') && names.includes('sandbox_deleted'));
  assert.equal(typeof r.logged().find((e) => e.data?.event === 'sandbox_created')!.data!.ms, 'number');
});

test('the clone step installs container-engine stubs and the harness runs with them first on PATH (CREW-2800)', async () => {
  const r = rig();
  await spawnAgent(r.plan(STREAM), r.emitter());
  const execs = r.calls().filter((c) => c.argv[1] === 'exec');
  assert.match(execs[0]!.argv.join(' '), /\.crew-bin\/docker/);
  assert.match(execs[0]!.argv.join(' '), /\.crew-bin\/podman/);
  assert.match(execs[1]!.argv.join(' '), /PATH='\/sandbox\/\.crew-bin':"\$PATH"/);
});

test('secrets reach the sandbox through --env-from, never argv', async () => {
  const r = rig();
  await spawnAgent(r.plan(STREAM), r.emitter());
  const create = r.calls().find((c) => c.argv[1] === 'create')!;
  assert.ok(create.argv.includes('--env-from') && create.argv.includes('CREW_API_KEY'));
  assert.equal(create.env.CREW_API_KEY, 'sk-secret-value', 'the create process carried it in its environment');
  assert.ok(!JSON.stringify(r.calls().map((c) => c.argv)).includes('sk-secret-value'), 'no argv anywhere contains the value');
  const mounts = JSON.parse(create.argv[create.argv.indexOf('--driver-config-json') + 1]!);
  assert.deepEqual(mounts.docker.mounts[0], { type: 'volume', source: 'cache-vol', target: '/cache', read_only: true });
});

test('the sidecar names the sandbox and a client pid; runner events carry timings', async () => {
  const r = rig();
  const plan = r.plan(LINGER);
  writeFileSync(join(r.dir, 'never'), '');
  const done = spawnAgent(plan, r.emitter());
  await new Promise((res) => setTimeout(res, 800));
  const sc = readRunSidecar(plan.streamPath)!;
  assert.equal(sc.runner, 'sandbox');
  assert.match(sc.sandbox!, /^crew-proj-dev-issue-7-/);
  assert.ok(sc.pid > 0);
  await done;
});

test('the wall-clock limit deletes the sandbox and the run is killed', async () => {
  const r = rig();
  const plan = r.plan(LINGER, { maxRunMinutes: 0.02, setEnv: { CREW_API_KEY: 'k', LINGER_GO: join(r.dir, 'never') } });
  const t0 = Date.now();
  const result = await spawnAgent(plan, r.emitter());
  assert.ok(result.killed, 'killed at the limit');
  assert.ok(Date.now() - t0 < 10_000);
  assert.ok(r.calls().some((c) => c.argv[1] === 'delete'));
  assert.deepEqual(readdirSync(join(r.osDir, 'sandboxes')), []);
});

test('a failed create is a spawn error and leaves nothing behind', async () => {
  const r = rig();
  process.env.FAKE_OS_CREATE_FAILS = '1';
  try {
    await assert.rejects(spawnAgent(r.plan(STREAM), r.emitter()), /could not create the sandbox: ControlSupervisorStartFailed/);
  } finally { delete process.env.FAKE_OS_CREATE_FAILS; }
  assert.deepEqual(readdirSync(join(r.osDir, 'sandboxes')), []);
});

test('a restarted daemon reattaches to a live sandbox run and deletes the sandbox when it ends', async () => {
  const r = rig();
  const plan = r.plan(LINGER);
  writeFileSync(plan.streamPath, '');
  mkdirSync(join(r.osDir, 'sandboxes'), { recursive: true });
  writeFileSync(join(r.osDir, 'sandboxes', 'crew-orphan'), '');
  const client = spawn(process.execPath, [LINGER], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, LINGER_GO: join(r.dir, 'never') } });
  client.stdin!.end('p');
  const sc: RunSidecar = {
    pid: client.pid!, ownerPid: 999999, spawnedAt: new Date().toISOString(), runner: 'sandbox', sandbox: 'crew-orphan', sandboxBin: r.bin,
    role: 'dev', route: 'proj', ticket: 'ISSUE-7', ticketRecordId: 'row-7', model: 'm', toolchain: 'claude', harness: 'claude',
    provider: 'anthropic', eventsPath: plan.eventsPath, promptSha: 'sha',
  };
  let alive = true;
  client.on('exit', () => { alive = false; });
  setTimeout(() => writeFileSync(join(r.dir, 'never'), ''), 300);
  const res = await reattachRun(plan.streamPath, sc, r.emitter(), { pollMs: 20, isAlive: () => alive });
  assert.equal(res.adopted, true);
  assert.ok(!existsSync(join(r.osDir, 'sandboxes', 'crew-orphan')), 'the sandbox was deleted');
  assert.ok(r.logged().some((e) => e.data?.event === 'sandbox_deleted'));
});

test('a prompt over the stdin limit goes through sandbox upload', async () => {
  const r = rig();
  const big = 'x'.repeat(SANDBOX_STDIN_LIMIT + 10);
  const plan = r.plan(STREAM, { prompt: big, promptBytes: big.length });
  const started = await withOrigin(plan.sandboxConfig).start(plan, {
    env: process.env, streamFd: 2, emit: r.emitter(),
  });
  started.child.stdin?.on('error', () => {});
  started.child.stdin?.end();
  await new Promise((res) => started.child.on('close', res));
  const exec = r.calls().filter((c) => c.argv[1] === 'exec').pop()!;
  assert.ok(r.calls().some((c) => c.argv[1] === 'upload'));
  assert.match(exec.argv.join(' '), /sh -c .*exec .* < \/sandbox\/prompt\.txt/);
  await withOrigin(plan.sandboxConfig).release(started.handle, r.emitter());
});

test('spawnAgent does not write an uploaded prompt to the exec client stdin', async () => {
  const r = rig();
  const big = 'x'.repeat(SANDBOX_STDIN_LIMIT + 10);
  const plan = r.plan(STREAM, { prompt: big, promptBytes: big.length });
  const log = join(r.dir, 'stdin-bytes');
  process.env.FAKE_OS_STDIN_LOG = log;
  try {
    const result = await spawnAgent(plan, r.emitter());
    assert.equal(result.code, 0);
  } finally { delete process.env.FAKE_OS_STDIN_LOG; }
  assert.ok(r.calls().some((c) => c.argv[1] === 'upload'));
  assert.equal(readFileSync(log, 'utf8'), '0', 'no prompt bytes went through the exec client');
});

test('a small prompt still goes over the exec client stdin', async () => {
  const r = rig();
  const plan = r.plan(STREAM, { prompt: 'hello', promptBytes: 5 });
  const log = join(r.dir, 'stdin-bytes');
  process.env.FAKE_OS_STDIN_LOG = log;
  try { await spawnAgent(plan, r.emitter()); } finally { delete process.env.FAKE_OS_STDIN_LOG; }
  assert.equal(readFileSync(log, 'utf8'), '5');
});

test('sandbox names are lowercase, bounded and unique per call time', () => {
  const n = sandboxName({ route: 'My_Route/Proj', role: 'dev', ticket: 'CREW-2793' }, 1000);
  assert.match(n, /^crew-my-route-proj-dev-crew-2793-[a-z0-9]+$/);
  assert.ok(sandboxName({ route: 'a'.repeat(200), role: 'dev', ticket: undefined }).length < 63);
  assert.equal(shQuote("it's"), `'it'\\''s'`);
});

test('ship.sandbox rejects unknown settings and non-strings', () => {
  assert.deepEqual(parseShipSandbox({ image: 'x', cacheVolume: 'v' }), { image: 'x', cacheVolume: 'v' });
  assert.equal(parseShipSandbox(undefined), undefined);
  assert.throws(() => parseShipSandbox({ imag: 'x' }), ConfigError);
  assert.throws(() => parseShipSandbox({ image: 3 }), ConfigError);
});

test('doctor: reports a missing CLI, a dead gateway and a healthy setup', () => {
  const ok = checkSandboxRunner({}, () => 'openshell 0.1.6');
  assert.equal(ok.ok, true);
  const missing = checkSandboxRunner({}, () => { throw new Error('spawn openshell ENOENT'); });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /not installed/);
  const down = checkSandboxRunner({}, (_b, a) => { if (a[0] === 'status') throw Object.assign(new Error('x'), { stderr: 'Connection refused' }); return 'openshell 0.1.6'; });
  assert.equal(down.ok, false);
  assert.match(down.detail, /supervisor_network_mode/);
});

test('CREW-2801: the run gets a generated policy written beside its stream file, and the log records declared hosts', async () => {
  const r = rig();
  const plan = r.plan(STREAM, {
    sandboxConfig: { bin: r.bin, agentBin: process.execPath, cacheVolume: 'cache-vol' },
    sandboxPolicy: {
      forgeHosts: ['github.com'], tablationUrl: 'https://app.tablation.com', authMode: 'workspace', provider: 'anthropic',
      harnessBin: 'claude', extraHosts: ['api.example.com'],
    },
  });
  await spawnAgent(plan, r.emitter());
  const create = r.calls().find((c) => c.argv[1] === 'create')!;
  const file = create.argv[create.argv.indexOf('--policy') + 1]!;
  assert.equal(file, plan.streamPath.replace(/\.jsonl$/, '.policy.yaml'));
  const yaml = readFileSync(file, 'utf8');
  assert.match(yaml, /hard_requirement/);
  assert.match(yaml, /api\.example\.com/);
  assert.doesNotMatch(yaml, /api\.anthropic\.com/);
  const ev = r.logged().find((e) => e.data?.event === 'sandbox_policy')!;
  assert.deepEqual(ev.data!.declared, ['api.example.com']);
});

test('CREW-2801: an operator-set ship.sandbox.policy overrides the generated one', async () => {
  const r = rig();
  const plan = r.plan(STREAM, { sandboxPolicy: { forgeHosts: [], tablationUrl: 'https://app.tablation.com', authMode: 'workspace', provider: 'anthropic', harnessBin: 'claude' } });
  await spawnAgent(plan, r.emitter());
  const create = r.calls().find((c) => c.argv[1] === 'create')!;
  assert.equal(create.argv[create.argv.indexOf('--policy') + 1], '/p.yaml');
  assert.ok(!existsSync(plan.streamPath.replace(/\.jsonl$/, '.policy.yaml')));
});

test('CREW-2801: a policy that would reach the metadata address fails the run before any sandbox exists', async () => {
  const r = rig();
  const plan = r.plan(STREAM, {
    sandboxConfig: { bin: r.bin, agentBin: process.execPath },
    sandboxPolicy: { forgeHosts: [], tablationUrl: 'https://app.tablation.com', authMode: 'workspace', provider: 'anthropic', harnessBin: 'claude', extraHosts: ['169.254.169.254'] },
  });
  await assert.rejects(spawnAgent(plan, r.emitter()), /cannot generate the sandbox policy/);
  assert.ok(!existsSync(join(r.osDir, 'calls.jsonl')), 'openshell was never invoked');
});

test('CREW-2801: denied requests in the sandbox log are folded into the run events before the delete', async () => {
  const r = rig();
  const logFile = join(r.dir, 'sandbox.log');
  writeFileSync(logFile, 'WARN network deny host=api.anthropic.com port=443 binary=/usr/bin/curl\n');
  process.env.FAKE_OS_LOG_FILE = logFile;
  try {
    await spawnAgent(r.plan(STREAM), r.emitter());
  } finally { delete process.env.FAKE_OS_LOG_FILE; }
  const denied = r.logged().find((e) => e.data?.event === 'sandbox_denied')!;
  assert.match(denied.message, /api\.anthropic\.com:443 by \/usr\/bin\/curl/);
  const verbs = r.calls().map((c) => c.argv[0]);
  assert.ok(verbs.indexOf('logs') < verbs.lastIndexOf('sandbox'), 'the log is read before the sandbox is deleted');
});

test('a run with a ticket repository clones that repository, not the route directory\'s origin (CREW-2946)', async () => {
  const r = rig();
  // The rig's route directory has the widgets origin; the ticket is on gadgets.
  await spawnAgent(r.plan(STREAM, { repo: 'gadgets', sandboxOrigin: 'https://github.com/acme/gadgets.git' }), r.emitter());
  const clone = r.calls().filter((c) => c.argv[1] === 'exec')[0]!.argv.join(' ');
  assert.match(clone, /mirrors\/github\.com\/acme\/gadgets\.git/);
  assert.doesNotMatch(clone, /widgets/);
});

test('a ticket repository the route cannot place fails naming the ticket and route, never the directory (CREW-2946)', async () => {
  const r = rig();
  const runner = new SandboxRunner({ bin: r.bin }, () => 'git@github.com:acme/widgets.git');
  await assert.rejects(
    runner.start(r.plan(STREAM, { repo: 'gadgets' }), { env: process.env, streamFd: 1, emit: r.emitter() }),
    /repository gadgets of ISSUE-7 on route proj/,
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import {
  createSyncDaemonServer, syncDaemonPortFor, syncPassengerSyncDaemons, generateSyncSecret,
  type SpawnFn,
} from '../src/passenger-sync-daemon.ts';
import type { ContainerPlan, PassengerCheckoutSyncSpec } from '../src/passenger-containers.ts';
import type { CrewConfig } from '../src/config.ts';

function emptyConfig(): CrewConfig {
  return { ship: { stateDir: '/tmp/state' }, routes: [], crewHome: '/tmp/crew' } as unknown as CrewConfig;
}

/* ── createSyncDaemonServer(): the wire protocol, against real git fixtures
   (no child process/Docker involved) — same split `passenger-mcp.ts`'s own
   createPassengerHttpServer/createPassengerMcpServer test coverage uses. ── */

function gitWorld() {
  const root = mkdtempSync(join(tmpdir(), 'crew-sync-daemon-'));
  const bare = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const seed = join(root, 'seed');
  execFileSync('git', ['clone', '-q', bare, seed]);
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: seed });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: seed });
  writeFileSync(join(seed, 'README.md'), 'x');
  execFileSync('git', ['add', '.'], { cwd: seed });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: seed });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: seed });

  const checkoutDir = join(root, 'checkout');
  execFileSync('git', ['clone', '-q', bare, checkoutDir]);

  return { root, bare, seed, checkoutDir };
}

function post(baseUrl: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers }).then(async (res) => ({
    status: res.status,
    body: await res.json().catch(() => undefined),
  }));
}

test('createSyncDaemonServer() rejects a request with no/wrong bearer secret before touching git', async (t) => {
  const server = createSyncDaemonServer([], 'right-secret');
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const noAuth = await post(baseUrl, '/sync', {});
  assert.equal(noAuth.status, 401);

  const wrongAuth = await post(baseUrl, '/sync', { Authorization: 'Bearer wrong-secret' });
  assert.equal(wrongAuth.status, 401);
});

test('createSyncDaemonServer() 404s anything but POST /sync or GET/POST /activity, even unauthenticated', async (t) => {
  const server = createSyncDaemonServer([], 'secret');
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const withAuth = await fetch(`http://127.0.0.1:${port}/other`, { method: 'POST', headers: { Authorization: 'Bearer secret' } });
  assert.equal(withAuth.status, 404);

  const withoutAuth = await fetch(`http://127.0.0.1:${port}/other`, { method: 'POST' });
  assert.equal(withoutAuth.status, 404, 'an unrecognized route 404s before the secret is even checked');
});

test('GET /activity reports null until a POST /activity lands, then the timestamp of the most recent one', async (t) => {
  const server = createSyncDaemonServer([], 'right-secret');
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const authHeader = { Authorization: 'Bearer right-secret' };

  const before = await fetch(`${baseUrl}/activity`, { headers: authHeader });
  assert.equal(before.status, 200);
  assert.deepEqual(await before.json(), { lastActivityAt: null });

  const posted = await fetch(`${baseUrl}/activity`, { method: 'POST', headers: authHeader });
  assert.equal(posted.status, 204);

  const after = await fetch(`${baseUrl}/activity`, { headers: authHeader });
  const body = await after.json() as { lastActivityAt: string | null };
  assert.ok(body.lastActivityAt, 'expected a timestamp after a ping');
  assert.ok(!Number.isNaN(Date.parse(body.lastActivityAt!)), 'expected an ISO timestamp');
});

test('/activity requires the same bearer secret as /sync', async (t) => {
  const server = createSyncDaemonServer([], 'right-secret');
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const noAuth = await fetch(`${baseUrl}/activity`, { method: 'POST' });
  assert.equal(noAuth.status, 401);

  const wrongAuth = await fetch(`${baseUrl}/activity`, { headers: { Authorization: 'Bearer wrong-secret' } });
  assert.equal(wrongAuth.status, 401);
});

test('createSyncDaemonServer() fast-forwards every target checkout and reports outcomes, given a valid secret', async (t) => {
  const { bare, seed, checkoutDir } = gitWorld();

  // A commit lands after the checkout was cloned — what the sync call below
  // must catch up on, exactly like syncAllPassengerCheckouts()'s own test.
  writeFileSync(join(seed, 'more.txt'), '1');
  execFileSync('git', ['add', '.'], { cwd: seed });
  execFileSync('git', ['commit', '-qm', 'more'], { cwd: seed });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: seed });

  const targets: PassengerCheckoutSyncSpec[] = [
    { name: 'crew', workspaceId: 'ws-1', dir: checkoutDir, remote: bare, gitRemoteName: 'origin', base: 'main' },
  ];
  const server = createSyncDaemonServer(targets, 'right-secret');
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const { status, body } = await post(`http://127.0.0.1:${port}`, '/sync', { Authorization: 'Bearer right-secret' });
  assert.equal(status, 200);
  assert.equal(body.synced.length, 1);
  assert.equal(body.synced[0].name, 'crew');
  assert.equal(body.synced[0].outcome.action, 'fast-forwarded');
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkoutDir, encoding: 'utf8' }).trim(),
    execFileSync('git', ['rev-parse', 'main'], { cwd: bare, encoding: 'utf8' }).trim(),
  );
});

/* ── syncDaemonPortFor(): must never collide with portFor()'s own MCP-
   container range for the same workspace id. ── */

test('syncDaemonPortFor() never lands in portFor()\'s own 28765-29764 MCP-container range', () => {
  for (const id of ['ws-1', 'ws-2', 'a-much-longer-workspace-id', 'x']) {
    const port = syncDaemonPortFor(id);
    assert.ok(port < 28765 || port >= 29765, `${id} -> ${port} collides with the MCP-container port range`);
  }
});

test('generateSyncSecret() returns a long, distinct value each call', () => {
  const a = generateSyncSecret();
  const b = generateSyncSecret();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32);
});

/* ── syncPassengerSyncDaemons(): lifecycle, mirroring tunnel.test.ts's own
   syncPassengerTunnels() coverage — no real child process, a fake spawnFn
   stands in exactly the way tunnel.test.ts's FakeChild does. ── */

class FakeChild extends EventEmitter {
  pid: number;
  constructor(pid: number) { super(); this.pid = pid; }
}

function fakeSpawn(child: FakeChild): { spawnFn: SpawnFn; calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> } {
  const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawnFn: SpawnFn = (cmd, args, env) => {
    calls.push({ cmd, args, env });
    return child as unknown as ChildProcess;
  };
  return { spawnFn, calls };
}

function makePlan(workspaceId: string, mountsHash = 'hash-1'): ContainerPlan {
  return {
    workspaceId, containerName: `crew-passenger-${workspaceId}`, port: 28800, image: 'tablation/crew-passenger-mcp:9.9.9',
    mounts: [{ hostPath: '/tmp/only', containerPath: '/workspace/only' }], mountsHash,
  };
}

test('syncPassengerSyncDaemons() spawns a daemon for a newly planned workspace and returns its endpoint', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-sync-daemon-state-'));
  const { spawnFn, calls } = fakeSpawn(new FakeChild(494241));

  const endpoints = syncPassengerSyncDaemons([makePlan('ws-1')], emptyConfig(), stateDir, { spawnFn });

  assert.equal(calls.length, 1);
  const endpoint = endpoints.get('ws-1');
  assert.ok(endpoint);
  assert.equal(endpoint!.host, 'host.docker.internal');
  assert.equal(endpoint!.port, syncDaemonPortFor('ws-1'));
  assert.ok(endpoint!.secret.length >= 32);
  assert.equal(calls[0]!.env.PASSENGER_SYNC_SECRET, endpoint!.secret);
  assert.equal(calls[0]!.env.PASSENGER_SYNC_PORT, String(endpoint!.port));
  assert.equal(calls[0]!.args[1], 'passenger-sync-daemon');
});

test('syncPassengerSyncDaemons() leaves an alive daemon with unchanged mounts alone — no respawn, same secret', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-sync-daemon-state-'));
  const { spawnFn, calls } = fakeSpawn(new FakeChild(494241));

  const first = syncPassengerSyncDaemons([makePlan('ws-1')], emptyConfig(), stateDir, { spawnFn });
  assert.equal(calls.length, 1);

  const second = syncPassengerSyncDaemons([makePlan('ws-1')], emptyConfig(), stateDir, { spawnFn, isPidAlive: () => true });
  assert.equal(calls.length, 1, 'should not have spawned a second daemon process');
  assert.equal(second.get('ws-1')!.secret, first.get('ws-1')!.secret);
});

test('syncPassengerSyncDaemons() respawns with the SAME secret when a daemon\'s pid has died but mounts are unchanged', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-sync-daemon-state-'));
  const { spawnFn: spawn1 } = fakeSpawn(new FakeChild(494241));
  const first = syncPassengerSyncDaemons([makePlan('ws-1')], emptyConfig(), stateDir, { spawnFn: spawn1 });

  const { spawnFn: spawn2, calls: calls2 } = fakeSpawn(new FakeChild(494242));
  const second = syncPassengerSyncDaemons([makePlan('ws-1')], emptyConfig(), stateDir, { spawnFn: spawn2, isPidAlive: () => false });

  assert.equal(calls2.length, 1, 'a dead pid should trigger a respawn');
  assert.equal(
    second.get('ws-1')!.secret, first.get('ws-1')!.secret,
    'the still-running container was told the OLD secret — a respawned daemon must reuse it',
  );
});

test('syncPassengerSyncDaemons() generates a NEW secret when mountsHash changed (the container behind it was recreated)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-sync-daemon-state-'));
  const { spawnFn: spawn1 } = fakeSpawn(new FakeChild(494241));
  const first = syncPassengerSyncDaemons([makePlan('ws-1', 'hash-1')], emptyConfig(), stateDir, { spawnFn: spawn1 });

  const { spawnFn: spawn2, calls: calls2 } = fakeSpawn(new FakeChild(494242));
  const second = syncPassengerSyncDaemons(
    [makePlan('ws-1', 'hash-2')], emptyConfig(), stateDir, { spawnFn: spawn2, isPidAlive: () => true },
  );

  assert.equal(calls2.length, 1, 'a changed mountsHash should trigger a respawn');
  assert.notEqual(second.get('ws-1')!.secret, first.get('ws-1')!.secret);
});

test('syncPassengerSyncDaemons() drops a persisted daemon whose workspace is no longer planned', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-sync-daemon-state-'));
  const { spawnFn } = fakeSpawn(new FakeChild(494241));
  syncPassengerSyncDaemons([makePlan('ws-1')], emptyConfig(), stateDir, { spawnFn });

  // pid 111 is fake and not a real running process — `syncPassengerSyncDaemons`
  // best-effort SIGTERMs it (swallowing the resulting ESRCH) the same way
  // `syncPassengerTunnels` does for a stale tunnel; nothing here asserts on
  // that signal itself, only on the persisted state actually being dropped.
  const endpoints = syncPassengerSyncDaemons([], emptyConfig(), stateDir, { spawnFn, isPidAlive: () => true });
  assert.equal(endpoints.size, 0);

  // A later cycle replanning ws-1 must be treated as brand new, not a
  // leftover "unchanged" match against the dropped state.
  const { spawnFn: spawn2, calls: calls2 } = fakeSpawn(new FakeChild(494242));
  syncPassengerSyncDaemons([makePlan('ws-1')], emptyConfig(), stateDir, { spawnFn: spawn2 });
  assert.equal(calls2.length, 1);
});

test('syncPassengerSyncDaemons() waits for the old daemon to actually exit before spawning its replacement, so the two never race for the port', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-sync-daemon-state-'));
  const { spawnFn: spawn1 } = fakeSpawn(new FakeChild(494241));
  syncPassengerSyncDaemons([makePlan('ws-1', 'hash-1')], emptyConfig(), stateDir, { spawnFn: spawn1 });

  // Reports alive for the first few checks (the SIGTERM'd old daemon hasn't
  // released its socket yet), then dead — waitForExit is what has to keep
  // polling through that window rather than spawning the replacement the
  // instant SIGTERM was sent.
  let aliveCalls = 0;
  const alive = () => { aliveCalls += 1; return aliveCalls <= 3; };
  const { spawnFn: spawn2, calls: calls2 } = fakeSpawn(new FakeChild(494242));
  syncPassengerSyncDaemons(
    [makePlan('ws-1', 'hash-2')], emptyConfig(), stateDir, { spawnFn: spawn2, isPidAlive: alive },
  );

  assert.equal(calls2.length, 1);
  assert.ok(aliveCalls > 3, 'the replacement must not spawn until the old pid is confirmed dead');
});

/* ── the real CLI subcommand, not just createSyncDaemonServer() called
   directly — the only way to actually exercise runSyncDaemonFromEnv's own
   process-boundary env parsing and its bind-failure handling. ── */

test('the real `passenger-sync-daemon` CLI subcommand exits loudly, with a message naming the failure, rather than dying silently on a bind failure', async () => {
  // Bound to 0.0.0.0, same as runSyncDaemonFromEnv itself — binding 0.0.0.0
  // while only 127.0.0.1 is taken does NOT conflict on macOS, so a blocker
  // on the loopback address alone would make this test pass for the wrong
  // reason (no real EADDRINUSE) rather than exercising the failure path.
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '0.0.0.0', resolve));
  const port = (blocker.address() as AddressInfo).port;

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const child = spawnProcess(
    process.execPath,
    ['--experimental-strip-types', 'src/cli.ts', 'passenger-sync-daemon'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PASSENGER_SYNC_PORT: String(port),
        PASSENGER_SYNC_SECRET: 'test-secret',
        PASSENGER_SYNC_TARGETS: '[]',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  const [code] = await once(child, 'exit');
  await new Promise<void>((resolve) => blocker.close(() => resolve()));

  assert.equal(code, 1);
  assert.match(stderr, /failed to bind/);
});

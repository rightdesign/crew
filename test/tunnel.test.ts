import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import {
  sshArgsFor, bindAddrFor, publicUrlFor, generateTunnelSlug, rotatePersistedSlug, startTunnel, syncPassengerTunnels, readPersistedTunnel, updatePersistedTunnel, DEFAULT_SPAWN_OPTIONS,
  type SpawnFn, type TunnelStatus,
} from '../src/tunnel.ts';
import type { ContainerPlan } from '../src/passenger-containers.ts';

const SLUG = 'abcdefghij12';
const KEY = 'sk_test-key';
const KEYS = new Map([['ws-1', KEY]]);

/** A fake `ssh` child process this test drives by hand — no real subprocess. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  unrefCalled = false;
  kill(_signal?: string) { this.emit('killed'); }
  unref() { this.unrefCalled = true; }
}

test('the real ssh child is spawned detached (ISSUE-680) — crew run must not block on a tunnel meant to outlive this cycle', () => {
  assert.equal(DEFAULT_SPAWN_OPTIONS.detached, true);
});

test('startTunnel() unrefs the child so the parent event loop does not wait on it (ISSUE-680)', () => {
  const child = new FakeChild();
  const { spawnFn } = fakeSpawn(child);
  startTunnel({
    relayHost: 'crewd@ships.tablation.dev', relayPort: 2222, workspaceId: 'ws-1', slug: SLUG, apiKey: KEY, localPort: 28800, privateKeyPath: '/keys/id_ed25519', spawnFn,
  });
  assert.equal(child.unrefCalled, true);
});

function fakeSpawn(child: FakeChild): { spawnFn: SpawnFn; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawnFn: SpawnFn = (cmd, args) => {
    calls.push({ cmd, args });
    return child as unknown as ChildProcess;
  };
  return { spawnFn, calls };
}

test('sshArgsFor() builds the exact -R remote-forward argv the relay expects', () => {
  const args = sshArgsFor({
    relayHost: 'crewd@ships.tablation.dev', relayPort: 2222, workspaceId: 'ws-1', slug: SLUG, apiKey: KEY, localPort: 28800, privateKeyPath: '/keys/id_ed25519',
  });
  assert.deepEqual(args, [
    '-N',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-i', '/keys/id_ed25519',
    '-p', '2222',
    '-R', `workspace-ws-1-slug-${SLUG}-key-${KEY}:0:127.0.0.1:28800`,
    'crewd@ships.tablation.dev',
  ]);
});

test('sshArgsFor() dials relayPort, not the ssh default of 22 (ISSUE-681)', () => {
  const args = sshArgsFor({
    relayHost: 'crewd@ships.tablation.dev', relayPort: 9999, workspaceId: 'ws-1', slug: SLUG, apiKey: KEY, localPort: 28800, privateKeyPath: '/keys/id_ed25519',
  });
  const portFlagIndex = args.indexOf('-p');
  assert.ok(portFlagIndex >= 0, 'must pass -p explicitly rather than relying on ssh_config/the default port');
  assert.equal(args[portFlagIndex + 1], '9999');
});

test('sshArgsFor() embeds mcpSecret in the bind address via the -secret- marker (ISSUE-685)', () => {
  const args = sshArgsFor({
    relayHost: 'crewd@ships.tablation.dev', relayPort: 2222, workspaceId: 'ws-1', slug: SLUG, apiKey: KEY, localPort: 28800,
    privateKeyPath: '/keys/id_ed25519', mcpSecret: 'deadbeef',
  });
  const bindIndex = args.indexOf('-R');
  assert.equal(args[bindIndex + 1], `workspace-ws-1-slug-${SLUG}-key-${KEY}-secret-deadbeef:0:127.0.0.1:28800`);
});

test('sshArgsFor() omits the -secret- marker entirely when there is no mcpSecret (ISSUE-685)', () => {
  const args = sshArgsFor({
    relayHost: 'crewd@ships.tablation.dev', relayPort: 2222, workspaceId: 'ws-1', slug: SLUG, apiKey: KEY, localPort: 28800,
    privateKeyPath: '/keys/id_ed25519',
  });
  const bindIndex = args.indexOf('-R');
  assert.equal(args[bindIndex + 1], `workspace-ws-1-slug-${SLUG}-key-${KEY}:0:127.0.0.1:28800`);
});

test('startTunnel() starts as "connecting" and stays there — no in-process "connected" signal any more (ISSUE-680)', () => {
  const child = new FakeChild();
  const { spawnFn, calls } = fakeSpawn(child);
  const statuses: TunnelStatus[] = [];

  const tunnel = startTunnel({
    relayHost: 'crewd@ships.tablation.dev', relayPort: 2222, workspaceId: 'ws-1', slug: SLUG, apiKey: KEY, localPort: 28800,
    privateKeyPath: '/keys/id_ed25519', spawnFn, onStatus: (s) => statuses.push(s),
  });

  assert.equal(calls[0]!.cmd, 'ssh');
  assert.equal(tunnel.status, 'connecting');
  assert.deepEqual(statuses, ['connecting']);

  // Emitting on the (now unused) stderr stream must not change anything —
  // stdio is fully 'ignore'd on the real spawn now, so nothing reads it.
  child.stderr.emit('data', 'Allocated port 54321 for remote forward to workspace-ws-1\n');
  assert.equal(tunnel.status, 'connecting');
  assert.deepEqual(statuses, ['connecting']);
});

test('startTunnel() reports "disconnected" when the ssh child exits', () => {
  const child = new FakeChild();
  const { spawnFn } = fakeSpawn(child);
  const statuses: TunnelStatus[] = [];

  const tunnel = startTunnel({
    relayHost: 'h', relayPort: 2222, workspaceId: 'ws-1', slug: SLUG, apiKey: KEY, localPort: 1, privateKeyPath: '/k', spawnFn, onStatus: (s) => statuses.push(s),
  });
  child.emit('exit', 1, null);

  assert.equal(tunnel.status, 'disconnected');
  assert.deepEqual(statuses, ['connecting', 'disconnected']);
});

test('startTunnel().stop() sends SIGTERM to the child', () => {
  const child = new FakeChild();
  const { spawnFn } = fakeSpawn(child);
  let killed = false;
  child.on('killed', () => { killed = true; });

  const tunnel = startTunnel({ relayHost: 'h', relayPort: 2222, workspaceId: 'ws-1', slug: SLUG, apiKey: KEY, localPort: 1, privateKeyPath: '/k', spawnFn });
  tunnel.stop();

  assert.ok(killed);
});

function makePlan(workspaceId: string, mountsHash = 'hash-1'): ContainerPlan {
  return {
    workspaceId, containerName: `crew-passenger-${workspaceId}`, port: 28800, image: 'tablation/crew-passenger-mcp:9.9.9',
    mounts: [{ hostPath: '/tmp/only', containerPath: '/workspace/only' }], mountsHash,
  };
}

test('syncPassengerTunnels() threads the matching mcpSecret into the spawned ssh argv (ISSUE-685)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-tunnel-'));
  const child = new FakeChild();
  const { spawnFn, calls } = fakeSpawn(child);

  syncPassengerTunnels(
    [makePlan('ws-1')], 'crewd@ships.tablation.dev', 2222, '/keys/id_ed25519', stateDir,
    new Map([['ws-1', 'the-secret']]), { apiKeys: KEYS, spawnFn },
  );

  const bindIndex = calls[0]!.args.indexOf('-R');
  assert.match(
    calls[0]!.args[bindIndex + 1]!,
    new RegExp(`^workspace-ws-1-slug-[a-z0-9]{12}-key-${KEY}-secret-the-secret:0:127\\.0\\.0\\.1:28800$`),
  );
});

test('syncPassengerTunnels() spawns a new tunnel when nothing is persisted for a planned workspace', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-tunnel-'));
  const child = new FakeChild();
  const { spawnFn, calls } = fakeSpawn(child);

  syncPassengerTunnels([makePlan('ws-1')], 'crewd@ships.tablation.dev', 2222, '/keys/id_ed25519', stateDir, new Map(), { apiKeys: KEYS, spawnFn });

  assert.equal(calls.length, 1);
  const persisted = readPersistedTunnel(stateDir, 'ws-1');
  assert.ok(persisted);
  assert.equal(persisted!.pid, child.pid);
  assert.equal(persisted!.mountsHash, 'hash-1');
});

test('syncPassengerTunnels() leaves an alive tunnel with unchanged mounts alone — no respawn', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-tunnel-'));
  const child = new FakeChild();
  const { spawnFn, calls } = fakeSpawn(child);

  syncPassengerTunnels([makePlan('ws-1')], 'h', 2222, '/k', stateDir, new Map(), { apiKeys: KEYS, spawnFn });
  assert.equal(calls.length, 1);

  // Second cycle: same plan, pid reported alive.
  syncPassengerTunnels([makePlan('ws-1')], 'h', 2222, '/k', stateDir, new Map(), { apiKeys: KEYS, spawnFn, isPidAlive: () => true });
  assert.equal(calls.length, 1, 'should not have spawned a second ssh process');
});

test('syncPassengerTunnels() promotes a still-"connecting" persisted tunnel to "connected" once it has survived a cycle', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-tunnel-'));
  const child = new FakeChild();
  const { spawnFn } = fakeSpawn(child);
  const statuses: Array<[string, TunnelStatus]> = [];

  // First cycle: spawns, settles at "connecting" (no stderr line emitted).
  syncPassengerTunnels([makePlan('ws-1')], 'h', 2222, '/k', stateDir, new Map(), { apiKeys: KEYS, spawnFn, onStatus: (w, s) => statuses.push([w, s]) });
  assert.equal(readPersistedTunnel(stateDir, 'ws-1')!.status, 'connecting');

  // Second cycle: pid still alive, mounts unchanged -> promoted to connected.
  syncPassengerTunnels([makePlan('ws-1')], 'h', 2222, '/k', stateDir, new Map(), {
    spawnFn, isPidAlive: () => true, onStatus: (w, s) => statuses.push([w, s]),
  });
  assert.equal(readPersistedTunnel(stateDir, 'ws-1')!.status, 'connected');
  assert.ok(statuses.some(([w, s]) => w === 'ws-1' && s === 'connected'));
});

test('syncPassengerTunnels() respawns when a persisted tunnel\'s pid has died', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-tunnel-'));
  const child1 = new FakeChild();
  const { spawnFn: spawn1 } = fakeSpawn(child1);
  syncPassengerTunnels([makePlan('ws-1')], 'h', 2222, '/k', stateDir, new Map(), { apiKeys: KEYS, spawnFn: spawn1 });

  const child2 = new FakeChild();
  const { spawnFn: spawn2, calls: calls2 } = fakeSpawn(child2);
  syncPassengerTunnels([makePlan('ws-1')], 'h', 2222, '/k', stateDir, new Map(), { apiKeys: KEYS, spawnFn: spawn2, isPidAlive: () => false });

  assert.equal(calls2.length, 1, 'a dead pid should trigger a respawn');
  assert.equal(readPersistedTunnel(stateDir, 'ws-1')!.pid, child2.pid);
});

test('syncPassengerTunnels() respawns when the container behind an alive tunnel was recreated (mountsHash changed)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-tunnel-'));
  const child1 = new FakeChild();
  const { spawnFn: spawn1 } = fakeSpawn(child1);
  syncPassengerTunnels([makePlan('ws-1', 'hash-1')], 'h', 2222, '/k', stateDir, new Map(), { apiKeys: KEYS, spawnFn: spawn1 });

  const child2 = new FakeChild();
  const { spawnFn: spawn2, calls: calls2 } = fakeSpawn(child2);
  syncPassengerTunnels([makePlan('ws-1', 'hash-2')], 'h', 2222, '/k', stateDir, new Map(), { apiKeys: KEYS, spawnFn: spawn2, isPidAlive: () => true });

  assert.equal(calls2.length, 1, 'a changed mountsHash should trigger a respawn');
  assert.equal(readPersistedTunnel(stateDir, 'ws-1')!.mountsHash, 'hash-2');
});

test('syncPassengerTunnels() respawns when the resolved mcpSecret has drifted from what the live tunnel was started with (ISSUE-696)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-tunnel-'));
  const child1 = new FakeChild();
  const { spawnFn: spawn1 } = fakeSpawn(child1);
  syncPassengerTunnels(
    [makePlan('ws-1')], 'h', 2222, '/k', stateDir,
    new Map([['ws-1', 'secret-old']]),
    { apiKeys: KEYS, spawnFn: spawn1 },
  );
  assert.equal(readPersistedTunnel(stateDir, 'ws-1')!.mcpSecret, 'secret-old');

  // Same mountsHash, pid still alive — the container was recreated with a
  // fresh secret (mountsHash unchanged on the tunnel's own plan, but the
  // sync-daemon/container side rotated the secret independently), so the
  // old tunnel's -R bind address now names a secret the container no
  // longer recognizes. Must be caught even though nothing else changed.
  const child2 = new FakeChild();
  const { spawnFn: spawn2, calls: calls2 } = fakeSpawn(child2);
  syncPassengerTunnels(
    [makePlan('ws-1')], 'h', 2222, '/k', stateDir,
    new Map([['ws-1', 'secret-new']]),
    { apiKeys: KEYS, spawnFn: spawn2, isPidAlive: () => true },
  );

  assert.equal(calls2.length, 1, 'a drifted mcpSecret should trigger a respawn even with mountsHash unchanged');
  assert.equal(readPersistedTunnel(stateDir, 'ws-1')!.mcpSecret, 'secret-new');
});

test('syncPassengerTunnels() leaves an alive tunnel alone when mcpSecret is unchanged, including when both are absent', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-tunnel-'));
  const child1 = new FakeChild();
  const { spawnFn: spawn1 } = fakeSpawn(child1);
  syncPassengerTunnels([makePlan('ws-1')], 'h', 2222, '/k', stateDir, new Map(), { apiKeys: KEYS, spawnFn: spawn1 });

  const child2 = new FakeChild();
  const { spawnFn: spawn2, calls: calls2 } = fakeSpawn(child2);
  syncPassengerTunnels([makePlan('ws-1')], 'h', 2222, '/k', stateDir, new Map(), {
    spawnFn: spawn2, isPidAlive: () => true,
  });

  assert.equal(calls2.length, 0, 'no mcpSecret before or after should not be treated as a drift');
});

test('syncPassengerTunnels() does not delete passenger-sync-daemon.ts\'s own <workspaceId>-sync.json state file (ISSUE-705)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-tunnel-'));
  const passengersDir = join(stateDir, 'passengers');
  mkdirSync(passengersDir, { recursive: true });
  // Mimics writePersistedSyncDaemon() in passenger-sync-daemon.ts, which
  // shares this same directory but with a `-sync.json` suffix.
  const syncDaemonStatePath = join(passengersDir, 'ws-1-sync.json');
  writeFileSync(syncDaemonStatePath, '{}\n');

  const child = new FakeChild();
  const { spawnFn } = fakeSpawn(child);
  // ws-1 is planned, so its own tunnel state file gets created too — the
  // cleanup loop below used to also match "ws-1-sync" (stripped only of
  // ".json") as an unplanned workspace and delete the sync-daemon's file.
  syncPassengerTunnels([makePlan('ws-1')], 'h', 2222, '/k', stateDir, new Map(), { apiKeys: KEYS, spawnFn });

  assert.ok(existsSync(syncDaemonStatePath), 'the sync-daemon\'s own state file must survive a tunnel sync cycle');
});

test('syncPassengerTunnels() kills and drops a persisted tunnel whose workspace is no longer planned', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-tunnel-'));
  const child = new FakeChild();
  const { spawnFn } = fakeSpawn(child);
  syncPassengerTunnels([makePlan('ws-1')], 'h', 2222, '/k', stateDir, new Map(), { apiKeys: KEYS, spawnFn });
  assert.ok(readPersistedTunnel(stateDir, 'ws-1'));

  const statuses: Array<[string, TunnelStatus]> = [];
  syncPassengerTunnels([], 'h', 2222, '/k', stateDir, new Map(), {
    spawnFn, isPidAlive: () => true, onStatus: (w, s) => statuses.push([w, s]),
  });

  assert.equal(readPersistedTunnel(stateDir, 'ws-1'), undefined);
  assert.deepEqual(statuses, [['ws-1', 'disconnected']]);
});

test('bindAddrFor() emits the v2 shape, with the secret last and optional (CREW-1320)', () => {
  const uuid = '11111111-2222-3333-4444-555555555555';
  assert.equal(
    bindAddrFor({ workspaceId: uuid, slug: SLUG, apiKey: 'sk_a-b_c' }),
    `workspace-${uuid}-slug-${SLUG}-key-sk_a-b_c`,
  );
  assert.equal(
    bindAddrFor({ workspaceId: uuid, slug: SLUG, apiKey: 'sk_a-b_c', mcpSecret: 'beef' }),
    `workspace-${uuid}-slug-${SLUG}-key-sk_a-b_c-secret-beef`,
  );
  assert.ok(!bindAddrFor({ workspaceId: uuid, slug: SLUG, apiKey: 'k' }).includes(':'), 'ssh splits -R on colons');
});

test('generateTunnelSlug() is 12 chars of [a-z0-9] (CREW-1320)', () => {
  for (let i = 0; i < 50; i++) assert.match(generateTunnelSlug(), /^[a-z0-9]{12}$/);
});

test('publicUrlFor() derives the domain from relayHost, omits :443, and honours an explicit domain (CREW-1320)', () => {
  assert.equal(publicUrlFor(SLUG, 'crewd@ships.tablation.dev', 443), `https://${SLUG}.ships.tablation.dev/mcp`);
  assert.equal(publicUrlFor(SLUG, 'crewd@ships.tablation.dev', 8443), `https://${SLUG}.ships.tablation.dev:8443/mcp`);
  assert.equal(publicUrlFor(SLUG, 'crewd@10.0.0.5', 443, 'relay.example.com'), `https://${SLUG}.relay.example.com/mcp`);
});

test('syncPassengerTunnels() mints a slug once and reuses it across respawns (CREW-1320)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-tunnel-'));
  const { spawnFn: spawn1 } = fakeSpawn(new FakeChild());
  syncPassengerTunnels([makePlan('ws-1')], 'h', 2222, '/k', stateDir, new Map(), { apiKeys: KEYS, spawnFn: spawn1 });
  const first = readPersistedTunnel(stateDir, 'ws-1')!;
  assert.match(first.slug!, /^[a-z0-9]{12}$/);
  assert.equal(first.liveSlug, first.slug);

  const { spawnFn: spawn2, calls } = fakeSpawn(new FakeChild());
  syncPassengerTunnels([makePlan('ws-1')], 'h', 2222, '/k', stateDir, new Map(), {
    apiKeys: KEYS, spawnFn: spawn2, isPidAlive: () => false,
  });
  assert.equal(readPersistedTunnel(stateDir, 'ws-1')!.slug, first.slug);
  assert.ok(calls[0]!.args[calls[0]!.args.indexOf('-R') + 1]!.includes(`-slug-${first.slug}-`));
});

test('rotatePersistedSlug() forces a respawn under a new slug even while the old pid is still alive (CREW-1320)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-tunnel-'));
  const { spawnFn: spawn1 } = fakeSpawn(new FakeChild());
  syncPassengerTunnels([makePlan('ws-1')], 'h', 2222, '/k', stateDir, new Map(), { apiKeys: KEYS, spawnFn: spawn1 });
  const before = readPersistedTunnel(stateDir, 'ws-1')!;

  rotatePersistedSlug(stateDir, 'ws-1');
  const { spawnFn: spawn2, calls } = fakeSpawn(new FakeChild());
  syncPassengerTunnels([makePlan('ws-1')], 'h', 2222, '/k', stateDir, new Map(), {
    apiKeys: KEYS, spawnFn: spawn2, isPidAlive: () => true,
  });
  const after = readPersistedTunnel(stateDir, 'ws-1')!;
  assert.notEqual(after.slug, before.slug);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.args[calls[0]!.args.indexOf('-R') + 1]!.includes(`-slug-${after.slug}-`));
});

test('syncPassengerTunnels() carries a registered endpointId across a respawn (CREW-1320)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-tunnel-'));
  const { spawnFn: spawn1 } = fakeSpawn(new FakeChild());
  syncPassengerTunnels([makePlan('ws-1')], 'h', 2222, '/k', stateDir, new Map(), { apiKeys: KEYS, spawnFn: spawn1 });
  updatePersistedTunnel(stateDir, 'ws-1', { endpointId: 'ep-1', registeredKey: 'k1' });

  const { spawnFn: spawn2 } = fakeSpawn(new FakeChild());
  syncPassengerTunnels([makePlan('ws-1')], 'h', 2222, '/k', stateDir, new Map(), {
    apiKeys: KEYS, spawnFn: spawn2, isPidAlive: () => false,
  });
  assert.equal(readPersistedTunnel(stateDir, 'ws-1')!.endpointId, 'ep-1');
});

test('syncPassengerTunnels() starts no tunnel for a workspace with no API key and reports it disconnected (CREW-1320)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-tunnel-'));
  const { spawnFn, calls } = fakeSpawn(new FakeChild());
  const seen: Array<[string, TunnelStatus]> = [];
  syncPassengerTunnels([makePlan('ws-1')], 'h', 2222, '/k', stateDir, new Map(), {
    spawnFn, onStatus: (w, s) => seen.push([w, s]),
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(seen, [['ws-1', 'disconnected']]);
});

test('a torn-down tunnel\'s onStatus carries the removed state, so its endpointId can still be deleted (CREW-1320)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-tunnel-'));
  const { spawnFn } = fakeSpawn(new FakeChild());
  syncPassengerTunnels([makePlan('ws-1')], 'h', 2222, '/k', stateDir, new Map(), { apiKeys: KEYS, spawnFn });
  updatePersistedTunnel(stateDir, 'ws-1', { endpointId: 'ep-1' });
  let info: unknown;
  syncPassengerTunnels([], 'h', 2222, '/k', stateDir, new Map(), {
    isPidAlive: () => false, onStatus: (_w, _s, i) => { info = i; },
  });
  assert.equal((info as { endpointId?: string }).endpointId, 'ep-1');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import {
  sshArgsFor, startTunnel, syncPassengerTunnels, readPersistedTunnel, DEFAULT_SPAWN_OPTIONS,
  type SpawnFn, type TunnelStatus,
} from '../src/tunnel.ts';
import type { ContainerPlan } from '../src/passenger-containers.ts';

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
    relayHost: 'crewd@ships.tablation.dev', workspaceId: 'ws-1', localPort: 28800, privateKeyPath: '/keys/id_ed25519', spawnFn,
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
    relayHost: 'crewd@ships.tablation.dev', workspaceId: 'ws-1', localPort: 28800, privateKeyPath: '/keys/id_ed25519',
  });
  assert.deepEqual(args, [
    '-N',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-i', '/keys/id_ed25519',
    '-R', 'workspace-ws-1:0:127.0.0.1:28800',
    'crewd@ships.tablation.dev',
  ]);
});

test('startTunnel() starts as "connecting" and stays there — no in-process "connected" signal any more (ISSUE-680)', () => {
  const child = new FakeChild();
  const { spawnFn, calls } = fakeSpawn(child);
  const statuses: TunnelStatus[] = [];

  const tunnel = startTunnel({
    relayHost: 'crewd@ships.tablation.dev', workspaceId: 'ws-1', localPort: 28800,
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
    relayHost: 'h', workspaceId: 'ws-1', localPort: 1, privateKeyPath: '/k', spawnFn, onStatus: (s) => statuses.push(s),
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

  const tunnel = startTunnel({ relayHost: 'h', workspaceId: 'ws-1', localPort: 1, privateKeyPath: '/k', spawnFn });
  tunnel.stop();

  assert.ok(killed);
});

function makePlan(workspaceId: string, mountsHash = 'hash-1'): ContainerPlan {
  return {
    workspaceId, containerName: `crew-passenger-${workspaceId}`, port: 28800,
    mounts: [{ hostPath: '/tmp/only', containerPath: '/workspace/only' }], mountsHash,
  };
}

test('syncPassengerTunnels() spawns a new tunnel when nothing is persisted for a planned workspace', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-tunnel-'));
  const child = new FakeChild();
  const { spawnFn, calls } = fakeSpawn(child);

  syncPassengerTunnels([makePlan('ws-1')], 'crewd@ships.tablation.dev', '/keys/id_ed25519', stateDir, { spawnFn });

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

  syncPassengerTunnels([makePlan('ws-1')], 'h', '/k', stateDir, { spawnFn });
  assert.equal(calls.length, 1);

  // Second cycle: same plan, pid reported alive.
  syncPassengerTunnels([makePlan('ws-1')], 'h', '/k', stateDir, { spawnFn, isPidAlive: () => true });
  assert.equal(calls.length, 1, 'should not have spawned a second ssh process');
});

test('syncPassengerTunnels() promotes a still-"connecting" persisted tunnel to "connected" once it has survived a cycle', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-tunnel-'));
  const child = new FakeChild();
  const { spawnFn } = fakeSpawn(child);
  const statuses: Array<[string, TunnelStatus]> = [];

  // First cycle: spawns, settles at "connecting" (no stderr line emitted).
  syncPassengerTunnels([makePlan('ws-1')], 'h', '/k', stateDir, { spawnFn, onStatus: (w, s) => statuses.push([w, s]) });
  assert.equal(readPersistedTunnel(stateDir, 'ws-1')!.status, 'connecting');

  // Second cycle: pid still alive, mounts unchanged -> promoted to connected.
  syncPassengerTunnels([makePlan('ws-1')], 'h', '/k', stateDir, {
    spawnFn, isPidAlive: () => true, onStatus: (w, s) => statuses.push([w, s]),
  });
  assert.equal(readPersistedTunnel(stateDir, 'ws-1')!.status, 'connected');
  assert.ok(statuses.some(([w, s]) => w === 'ws-1' && s === 'connected'));
});

test('syncPassengerTunnels() respawns when a persisted tunnel\'s pid has died', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-tunnel-'));
  const child1 = new FakeChild();
  const { spawnFn: spawn1 } = fakeSpawn(child1);
  syncPassengerTunnels([makePlan('ws-1')], 'h', '/k', stateDir, { spawnFn: spawn1 });

  const child2 = new FakeChild();
  const { spawnFn: spawn2, calls: calls2 } = fakeSpawn(child2);
  syncPassengerTunnels([makePlan('ws-1')], 'h', '/k', stateDir, { spawnFn: spawn2, isPidAlive: () => false });

  assert.equal(calls2.length, 1, 'a dead pid should trigger a respawn');
  assert.equal(readPersistedTunnel(stateDir, 'ws-1')!.pid, child2.pid);
});

test('syncPassengerTunnels() respawns when the container behind an alive tunnel was recreated (mountsHash changed)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-tunnel-'));
  const child1 = new FakeChild();
  const { spawnFn: spawn1 } = fakeSpawn(child1);
  syncPassengerTunnels([makePlan('ws-1', 'hash-1')], 'h', '/k', stateDir, { spawnFn: spawn1 });

  const child2 = new FakeChild();
  const { spawnFn: spawn2, calls: calls2 } = fakeSpawn(child2);
  syncPassengerTunnels([makePlan('ws-1', 'hash-2')], 'h', '/k', stateDir, { spawnFn: spawn2, isPidAlive: () => true });

  assert.equal(calls2.length, 1, 'a changed mountsHash should trigger a respawn');
  assert.equal(readPersistedTunnel(stateDir, 'ws-1')!.mountsHash, 'hash-2');
});

test('syncPassengerTunnels() kills and drops a persisted tunnel whose workspace is no longer planned', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-tunnel-'));
  const child = new FakeChild();
  const { spawnFn } = fakeSpawn(child);
  syncPassengerTunnels([makePlan('ws-1')], 'h', '/k', stateDir, { spawnFn });
  assert.ok(readPersistedTunnel(stateDir, 'ws-1'));

  const statuses: Array<[string, TunnelStatus]> = [];
  syncPassengerTunnels([], 'h', '/k', stateDir, {
    spawnFn, isPidAlive: () => true, onStatus: (w, s) => statuses.push([w, s]),
  });

  assert.equal(readPersistedTunnel(stateDir, 'ws-1'), undefined);
  assert.deepEqual(statuses, [['ws-1', 'disconnected']]);
});

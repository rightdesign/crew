import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseDockerCreatedAt, reapOrphanContainers, reportReaped, checkDisk, diskVerdict, diskFullStop,
  type ReapDeps, type ContainerInfo, type DiskReading, DISK_FULL_KEY, SANDBOX_LEAK_KEY, LEAK_CLEAR_AFTER_MS,
} from '../src/sandbox-hygiene.ts';
import { sandboxLabels } from '../src/runner.ts';
import { openShipAttention } from '../src/ship-attention.ts';
import { Emitter, eventFileFor } from '../src/events.ts';
import { State } from '../src/state.ts';
import type { Ship } from '../src/config.ts';

const NOW = Date.parse('2026-11-03T07:00:00Z');
const MIN = 60_000;
const ctr = (name: string, ageMin: number): ContainerInfo => ({ name, createdMs: NOW - ageMin * MIN });
const A = 'crew-aaaaaaaaaaaaaa';
const B = 'crew-bbbbbbbbbbbbbb';
const C = 'crew-cccccccccccccc';

function deps(over: Partial<Omit<ReapDeps, 'containers'>> & { containers: ContainerInfo[] }): ReapDeps & { removed: string[] } {
  const removed: string[] = [];
  return {
    workspace: 'default', removed,
    containers: async () => over.containers,
    gatewaySandboxes: over.gatewaySandboxes ?? (async () => []),
    liveSandboxes: over.liveSandboxes ?? (() => []),
    remove: async (n) => { removed.push(n); },
    now: () => NOW,
  };
}

test('parseDockerCreatedAt reads docker ps CreatedAt and refuses anything else', () => {
  assert.equal(parseDockerCreatedAt('2026-11-03 06:19:01 +0000 UTC'), Date.parse('2026-11-03T06:19:01Z'));
  assert.equal(parseDockerCreatedAt('2026-11-03 06:19:01 -0800 PST'), Date.parse('2026-11-03T14:19:01Z'));
  assert.equal(parseDockerCreatedAt('yesterday'), null);
});

test('the reaper removes old containers no run and no gateway names, keeps the rest', async () => {
  const d = deps({
    containers: [
      ctr(`openshell-default--${A}`, 30), ctr(`openshell-default--${A}-supervisor`, 30),
      ctr(`openshell-default--${B}`, 30), // live run
      ctr(`openshell-default--${C}`, 30), // gateway knows it
      ctr('openshell-default--crew-dddddddddddddd', 2), // too young
      ctr('tablation-postgres-1', 999), // not a sandbox
      ctr(`openshell-other--${A}`, 99), // another OpenShell workspace
    ],
    liveSandboxes: () => [B], gatewaySandboxes: async () => [C],
  });
  const reaped = await reapOrphanContainers(d);
  assert.deepEqual(d.removed, [`openshell-default--${A}`, `openshell-default--${A}-supervisor`]);
  assert.equal(reaped.length, 2);
});

test('the reaper removes nothing when the gateway cannot be asked', async () => {
  const d = deps({ containers: [ctr(`openshell-default--${A}`, 99)], gatewaySandboxes: async () => null });
  assert.deepEqual(await reapOrphanContainers(d), []);
  assert.deepEqual(d.removed, []);
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-hyg-'));
  const state = new State(dir);
  const emit = new Emitter({ route: 'r', eventFile: eventFileFor(dir), console: () => {} });
  return { state, emit, ship: { name: 's', stateDir: dir } as unknown as Ship };
}

test('reaped containers are counted in attention, accumulate, and clear after an hour of quiet', async () => {
  const f = fixture();
  await reportReaped(f, [{ container: 'x', ageMs: 600_000 }, { container: 'y', ageMs: 600_000 }], NOW);
  await reportReaped(f, [{ container: 'z', ageMs: 600_000 }], NOW + MIN);
  const item = openShipAttention(f.state).find((i) => i.key === SANDBOX_LEAK_KEY)!;
  assert.equal(item.count, 3);
  assert.equal(item.kind, 'sandbox_leak');
  await reportReaped(f, [], NOW + 30 * MIN);
  assert.ok(openShipAttention(f.state).some((i) => i.key === SANDBOX_LEAK_KEY));
  await reportReaped(f, [], NOW + MIN + LEAK_CLEAR_AFTER_MS + MIN);
  assert.ok(!openShipAttention(f.state).some((i) => i.key === SANDBOX_LEAK_KEY));
});

test('diskVerdict: stop at 95, hold the stop until 90, warn from 85', () => {
  assert.equal(diskVerdict(96, false), 'stop');
  assert.equal(diskVerdict(92, true), 'stop');
  assert.equal(diskVerdict(92, false), 'warn');
  assert.equal(diskVerdict(89, true), 'warn');
  assert.equal(diskVerdict(70, false), 'ok');
});

test('a ship at 95% reclaims first, then raises disk_full and refuses new work until space is back', async () => {
  const f = fixture();
  let percent = 97;
  let reclaimed = 0;
  const d = { readings: async (): Promise<DiskReading[]> => [{ path: '/', percent }], reclaim: async () => { reclaimed++; } };
  await checkDisk(f, d);
  assert.equal(reclaimed, 1);
  assert.ok(diskFullStop(f.state)?.includes('97%'));
  percent = 92; // below the line but not below the resume mark
  await checkDisk(f, d);
  assert.ok(diskFullStop(f.state));
  assert.equal(reclaimed, 1, 'an open stop does not reclaim again');
  percent = 80;
  await checkDisk(f, d);
  assert.equal(diskFullStop(f.state), null);
  assert.ok(!openShipAttention(f.state).some((i) => i.key === DISK_FULL_KEY));
});

test('reclaiming enough at the line avoids the stop; 85% only warns', async () => {
  const f = fixture();
  let percent = 96;
  await checkDisk(f, { readings: async () => [{ path: '/', percent }], reclaim: async () => { percent = 60; } });
  assert.equal(diskFullStop(f.state), null);
  assert.equal(openShipAttention(f.state).length, 0);
  await checkDisk(f, { readings: async () => [{ path: '/var/lib/docker', percent: 87 }], reclaim: async () => {} });
  assert.deepEqual(openShipAttention(f.state).map((i) => i.kind), ['disk_pressure']);
  assert.equal(diskFullStop(f.state), null);
});

test('sandboxLabels carry role, ticket and run, and drop the ticket when there is none', () => {
  assert.deepEqual(sandboxLabels({ role: 'dev', ticket: 'CREW-3034', run: 'r-dev-1' }), ['crew.role=dev', 'crew.ticket=CREW-3034', 'crew.run=r-dev-1']);
  assert.deepEqual(sandboxLabels({ role: 'release', run: 'a b/c' }), ['crew.role=release', 'crew.run=a_b_c']);
});

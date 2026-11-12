import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dockerGate, type DockerGateDeps } from '../src/passengers-cycle.ts';
import { DOCKER_DAEMON_KEY } from '../src/ship-attention.ts';
import type { ShipAttentionItem } from '../src/ship-attention.ts';
import { visibleAttention } from '../src/doctor-problems.ts';

function harness(dockerUp: boolean, pathProblem: string | null = null) {
  const calls: string[] = [];
  const raised: string[] = [];
  const cleared: string[] = [];
  const warnings: string[] = [];
  let tunnelArgs: unknown[] | null = null;
  const deps: DockerGateDeps<string> = {
    dockerUp,
    passengerRoutes: ['a/issues', 'b/issues'],
    pathProblem: () => pathProblem,
    warn: (m) => warnings.push(m),
    raise: async (item, route) => { calls.push('raise'); raised.push(`${item.key}@${route}`); },
    clear: (k) => { calls.push('clear'); cleared.push(k); },
    syncTunnels: async (plans, targets, routes) => { calls.push('sync'); tunnelArgs = [plans, targets.size, routes]; },
  };
  return { deps, calls, raised, cleared, warnings, tunnelArgs: () => tunnelArgs };
}

test('Docker down: raises the one item, still syncs tunnels with no container plans, and stops the cycle', async () => {
  const h = harness(false);
  assert.equal(await dockerGate(h.deps), 'handled');
  assert.deepEqual(h.raised, [`${DOCKER_DAEMON_KEY}@a/issues`]);
  assert.deepEqual(h.tunnelArgs(), [[], 0, ['a/issues', 'b/issues']]);
  assert.deepEqual(h.calls, ['raise', 'sync']);
  assert.deepEqual(h.cleared, []);
  assert.equal(h.warnings.length, 1);
});

test('Docker down on a PATH problem names it in the warning', async () => {
  const h = harness(false, 'docker is not on the scheduler PATH');
  await dockerGate(h.deps);
  assert.match(h.warnings[0]!, /docker is not on the scheduler PATH/);
});

test('Docker up: clears the item and lets the cycle proceed without touching tunnels', async () => {
  const h = harness(true);
  assert.equal(await dockerGate(h.deps), 'proceed');
  assert.deepEqual(h.cleared, [DOCKER_DAEMON_KEY]);
  assert.deepEqual(h.calls, ['clear']);
  assert.deepEqual(h.raised, []);
});

test('visibleAttention hides the Docker daemon item only when doctor prints the Docker finding', () => {
  const items: ShipAttentionItem[] = [
    { kind: 'docker_missing', key: DOCKER_DAEMON_KEY, message: 'x', since: 't' },
    { kind: 'hook_missing', key: 'hook_missing:r', message: 'y', since: 't' },
  ];
  assert.deepEqual(visibleAttention(items, true).map((i) => i.key), ['hook_missing:r']);
  assert.equal(visibleAttention(items, false).length, 2);
});

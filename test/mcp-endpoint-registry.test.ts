import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  registerEndpoint, removeEndpoint, probeEndpointAccess, reconcileEndpoint, unregisterEndpoint,
  type EndpointApi, type ReconcileDeps,
} from '../src/mcp-endpoint-registry.ts';
import { readPersistedTunnel, updatePersistedTunnel, syncPassengerTunnels } from '../src/tunnel.ts';
import type { ContainerPlan } from '../src/passenger-containers.ts';

const API_KEY = 'sk_super-secret-route-key';

interface Call { method: string; url: string; body: Record<string, unknown> | undefined; auth: string | null }

/** A fake fetch answering from a queue of statuses, recording every call. */
function fakeApi(statuses: number[], json: unknown = { id: 'ep-new' }): { api: EndpointApi; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...statuses];
  const api: EndpointApi = {
    baseUrl: 'https://tablation.test/', apiKey: API_KEY, userAgent: 'UA',
    fetchFn: async (url, init) => {
      const headers = init?.headers as Record<string, string>;
      calls.push({
        method: init?.method ?? 'GET', url,
        body: init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : undefined,
        auth: headers.Authorization ?? null,
      });
      const status = queue.shift() ?? 200;
      return new Response(status === 204 ? null : JSON.stringify(json), { status });
    },
  };
  return { api, calls };
}

const D = { label: 'Ship: Mac', url: 'https://abc.ships.test/mcp', mcpSecret: 'beef' };

test('registerEndpoint() POSTs a new endpoint with the Bearer-secret header (CREW-1320)', async () => {
  const { api, calls } = fakeApi([201]);
  const out = await registerEndpoint(api, 'ws-1', undefined, D);
  assert.deepEqual(out, { kind: 'ok', endpointId: 'ep-new', action: 'created' });
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.url, 'https://tablation.test/api/workspaces/ws-1/mcp-endpoints');
  assert.deepEqual(calls[0]!.body, { label: 'Ship: Mac', url: D.url, authorizationHeader: 'Bearer beef' });
  assert.equal(calls[0]!.auth, `Bearer ${API_KEY}`);
});

test('registerEndpoint() omits the header when there is no secret on create (CREW-1320)', async () => {
  const { api, calls } = fakeApi([201]);
  await registerEndpoint(api, 'ws-1', undefined, { ...D, mcpSecret: undefined });
  assert.ok(!('authorizationHeader' in calls[0]!.body!));
});

test('registerEndpoint() PATCHes the stored id, clearing a header whose secret went away (CREW-1320)', async () => {
  const { api, calls } = fakeApi([200]);
  const out = await registerEndpoint(api, 'ws-1', 'ep-1', { ...D, mcpSecret: undefined });
  assert.deepEqual(out, { kind: 'ok', endpointId: 'ep-1', action: 'updated' });
  assert.equal(calls[0]!.method, 'PATCH');
  assert.ok(calls[0]!.url.endsWith('/mcp-endpoints/ep-1'));
  assert.equal(calls[0]!.body!.authorizationHeader, null);
});

test('registerEndpoint() re-creates when the stored id 404s (CREW-1320)', async () => {
  const { api, calls } = fakeApi([404, 201]);
  const out = await registerEndpoint(api, 'ws-1', 'ep-gone', D);
  assert.deepEqual(out, { kind: 'ok', endpointId: 'ep-new', action: 'recreated' });
  assert.deepEqual(calls.map((c) => c.method), ['PATCH', 'POST']);
});

test('registerEndpoint() reports 403 as forbidden and a network failure as an error, never throwing (CREW-1320)', async () => {
  assert.deepEqual(await registerEndpoint(fakeApi([403]).api, 'ws-1', undefined, D), { kind: 'forbidden' });
  assert.deepEqual(await registerEndpoint(fakeApi([403]).api, 'ws-1', 'ep-1', D), { kind: 'forbidden' });
  const boom: EndpointApi = { baseUrl: 'https://t', apiKey: API_KEY, fetchFn: async () => { throw new Error('ECONNRESET'); } };
  assert.deepEqual(await registerEndpoint(boom, 'ws-1', undefined, D), { kind: 'error', message: 'ECONNRESET' });
});

test('removeEndpoint() tolerates 404 and surfaces other failures (CREW-1320)', async () => {
  assert.deepEqual(await removeEndpoint(fakeApi([204]).api, 'ws-1', 'ep-1'), { kind: 'ok' });
  assert.deepEqual(await removeEndpoint(fakeApi([404]).api, 'ws-1', 'ep-1'), { kind: 'ok' });
  assert.deepEqual(await removeEndpoint(fakeApi([403]).api, 'ws-1', 'ep-1'), { kind: 'forbidden' });
  assert.equal((await removeEndpoint(fakeApi([500]).api, 'ws-1', 'ep-1')).kind, 'error');
});

test('probeEndpointAccess() distinguishes ok / 403 / other (CREW-1320)', async () => {
  assert.equal(await probeEndpointAccess(fakeApi([200], []).api, 'ws-1'), 'ok');
  assert.equal(await probeEndpointAccess(fakeApi([403]).api, 'ws-1'), 'forbidden');
  assert.deepEqual(await probeEndpointAccess(fakeApi([502]).api, 'ws-1'), { error: '502 ' });
});

function makePlan(workspaceId: string): ContainerPlan {
  return {
    workspaceId, containerName: `c-${workspaceId}`, port: 28800, mountsHash: 'h',
    mounts: [{ hostPath: '/tmp/x', containerPath: '/workspace/x' }],
  } as ContainerPlan;
}

function connectedTunnel(stateDir: string, mcpSecret?: string): void {
  const spawnFn = () => ({ pid: 1, on() {}, unref() {}, kill() {} }) as never;
  syncPassengerTunnels([makePlan('ws-1')], 'h', 2222, '/k', stateDir, new Map(mcpSecret ? [['ws-1', mcpSecret]] : []), {
    apiKeys: new Map([['ws-1', API_KEY]]), spawnFn,
  });
  updatePersistedTunnel(stateDir, 'ws-1', { status: 'connected' });
}

function reconcileDeps(stateDir: string, api: EndpointApi | undefined, warnings: string[]): ReconcileDeps {
  return {
    stateDir, shipName: 'Mac', apiFor: () => api,
    urlFor: (slug) => `https://${slug}.ships.test/mcp`,
    warn: (m) => warnings.push(m),
  };
}

test('reconcileEndpoint() registers once a tunnel is connected and persists the id; unchanged cycles make no call (CREW-1320)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-ep-'));
  connectedTunnel(stateDir, 'beef');
  const { api, calls } = fakeApi([201]);
  const warnings: string[] = [];
  const deps = reconcileDeps(stateDir, api, warnings);

  await reconcileEndpoint('ws-1', deps);
  const st = readPersistedTunnel(stateDir, 'ws-1')!;
  assert.equal(st.endpointId, 'ep-new');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body!.url, `https://${st.slug}.ships.test/mcp`);

  await reconcileEndpoint('ws-1', deps);
  assert.equal(calls.length, 1, 'registration unchanged, so no second call');
});

test('reconcileEndpoint() PATCHes when the slug rotates (CREW-1320)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-ep-'));
  connectedTunnel(stateDir);
  const { api, calls } = fakeApi([201, 200]);
  const deps = reconcileDeps(stateDir, api, []);
  await reconcileEndpoint('ws-1', deps);
  updatePersistedTunnel(stateDir, 'ws-1', { slug: 'zzzzzzzzzzzz' });
  await reconcileEndpoint('ws-1', deps);
  assert.deepEqual(calls.map((c) => c.method), ['POST', 'PATCH']);
  assert.equal(calls[1]!.body!.url, 'https://zzzzzzzzzzzz.ships.test/mcp');
});

test('reconcileEndpoint() skips a tunnel that is not connected (CREW-1320)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-ep-'));
  connectedTunnel(stateDir);
  updatePersistedTunnel(stateDir, 'ws-1', { status: 'connecting' });
  const { api, calls } = fakeApi([201]);
  await reconcileEndpoint('ws-1', reconcileDeps(stateDir, api, []));
  assert.equal(calls.length, 0);
});

test('a 403 registering warns, keeps the tunnel state, and is retried next cycle (CREW-1320)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-ep-'));
  connectedTunnel(stateDir);
  const { api, calls } = fakeApi([403, 201]);
  const warnings: string[] = [];
  const deps = reconcileDeps(stateDir, api, warnings);

  await reconcileEndpoint('ws-1', deps);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /REGISTER_MCP_ENDPOINTS/);
  const st = readPersistedTunnel(stateDir, 'ws-1')!;
  assert.equal(st.status, 'connected');
  assert.equal(st.endpointId, undefined);

  await reconcileEndpoint('ws-1', deps);
  assert.equal(calls.length, 2);
  assert.equal(readPersistedTunnel(stateDir, 'ws-1')!.endpointId, 'ep-new');
});

test('unregisterEndpoint() deletes by stored id and clears it; a failure keeps the id (CREW-1320)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-ep-'));
  connectedTunnel(stateDir);
  updatePersistedTunnel(stateDir, 'ws-1', { endpointId: 'ep-1', registeredKey: 'k' });
  const warnings: string[] = [];

  const bad = fakeApi([500]);
  await unregisterEndpoint('ws-1', readPersistedTunnel(stateDir, 'ws-1'), reconcileDeps(stateDir, bad.api, warnings));
  assert.equal(readPersistedTunnel(stateDir, 'ws-1')!.endpointId, 'ep-1');
  assert.equal(warnings.length, 1);

  const good = fakeApi([404]);
  await unregisterEndpoint('ws-1', readPersistedTunnel(stateDir, 'ws-1'), reconcileDeps(stateDir, good.api, warnings));
  assert.equal(good.calls[0]!.method, 'DELETE');
  assert.equal(readPersistedTunnel(stateDir, 'ws-1')!.endpointId, undefined);
});

test('no warning or error text ever contains the API key or the mcp secret (CREW-1320)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-ep-'));
  connectedTunnel(stateDir, 'beefbeef');
  const warnings: string[] = [];
  for (const status of [403, 500]) {
    await reconcileEndpoint('ws-1', reconcileDeps(stateDir, fakeApi([status]).api, warnings));
  }
  const boom: EndpointApi = { baseUrl: 'https://t', apiKey: API_KEY, fetchFn: async () => { throw new Error('connect failed'); } };
  await reconcileEndpoint('ws-1', reconcileDeps(stateDir, boom, warnings));
  assert.equal(warnings.length, 3);
  for (const w of warnings) {
    assert.ok(!w.includes(API_KEY) && !w.includes('beefbeef'), w);
  }
});

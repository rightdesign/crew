import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionStore, StoredSession } from '@tablation/client';
import type { Route } from '../src/config.ts';
import { mintMissingSeatKeys, resolveSeatKey, seatKeySlug } from '../src/seat-keys.ts';

delete process.env.CREW_API_KEY;

function memoryStore(): SessionStore & { data: Map<string, StoredSession> } {
  const data = new Map<string, StoredSession>();
  return {
    data,
    get: async (h, s) => data.get(`${h}/${s}`),
    set: async (h, s, v) => { data.set(`${h}/${s}`, v); },
    clear: async (h, s) => { data.delete(`${h}/${s}`); },
  };
}

function route(personas: Record<string, string> = { dev: 'agent-dev', qa: 'agent-qa' }): Route {
  return {
    route: 'issues/crew',
    baseUrl: 'https://example.test',
    apiKey: 'ship-key',
    resolved: {
      workspaceId: 'ws-1',
      seats: { dev: 'crew-dev', qa: 'crew-qa', pair: 'crew-pair' },
      agentPersonas: Object.fromEntries(Object.entries(personas).map(([r, agentId]) => [r, { agentId, lastSyncedUpdatedAt: 'x' }])),
    },
  } as unknown as Route;
}

test('resolveSeatKey returns the stored agent key', async () => {
  const store = memoryStore();
  await mintMissingSeatKeys(route(), {
    getStore: () => store,
    fetchImpl: async () => new Response(JSON.stringify({ key: 'sk_agent_dev' }), { status: 201 }),
  });
  const id = await resolveSeatKey(route(), 'dev', () => store);
  assert.deepEqual(id, { kind: 'agent', apiKey: 'sk_agent_dev', agentId: 'agent-dev' });
});

test('resolveSeatKey falls back to the ship key with a reason', async () => {
  const store = memoryStore();
  const id = await resolveSeatKey(route(), 'dev', () => store);
  assert.equal(id.kind, 'ship');
  assert.equal(id.apiKey, 'ship-key');
  const unlinked = await resolveSeatKey(route({}), 'dev', () => store);
  assert.match((unlinked as { reason: string }).reason, /no linked Agents row|no.*Agents row/);
  const pair = await resolveSeatKey(route(), 'pair', () => store);
  assert.equal(pair.kind, 'ship');
  const broken = await resolveSeatKey(route(), 'dev', () => { throw new Error('no keychain'); });
  assert.equal(broken.kind, 'ship');
});

test('mintMissingSeatKeys mints once per linked seat, skips stored keys and pair, uses the ship key', async () => {
  const store = memoryStore();
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get('authorization') });
    return new Response(JSON.stringify({ key: `sk_${calls.length}` }), { status: 201 });
  }) as unknown as typeof fetch;
  const first = await mintMissingSeatKeys(route(), { getStore: () => store, fetchImpl });
  assert.deepEqual(first.map((o) => [o.role, o.action]), [['dev', 'minted'], ['qa', 'minted']]);
  assert.equal(calls[0]!.url, 'https://example.test/api/workspaces/ws-1/agents/agent-dev/api-keys');
  assert.equal(calls[0]!.auth, 'Bearer ship-key');
  assert.ok(store.data.has(`example.test/${seatKeySlug('issues', 'agent-dev')}`));
  const second = await mintMissingSeatKeys(route(), { getStore: () => store, fetchImpl });
  assert.deepEqual(second.map((o) => o.action), ['already_stored', 'already_stored']);
  assert.equal(calls.length, 2);
});

test('a refused mint is reported, stores nothing, and does not throw', async () => {
  const store = memoryStore();
  const out = await mintMissingSeatKeys(route({ dev: 'agent-dev' }), {
    getStore: () => store,
    fetchImpl: async () => new Response('no', { status: 403, statusText: 'Forbidden' }),
  });
  assert.deepEqual(out.map((o) => [o.role, o.action]), [['dev', 'failed'], ['qa', 'no_agent']]);
  assert.equal(store.data.size, 0);
});

test('dryRun mints nothing', async () => {
  const store = memoryStore();
  let called = false;
  await mintMissingSeatKeys(route(), { getStore: () => store, dryRun: true, fetchImpl: async () => { called = true; return new Response('{}'); } });
  assert.equal(called, false);
});

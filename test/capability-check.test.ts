import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCapabilities, describeCapability, missLine } from '../src/capability-check.ts';
import type { Discovered } from '../src/connect.ts';

const BASE = { baseUrl: 'https://example.test', apiKey: 'k', userAgent: 'crew-test' };

function found(role: string | undefined): Discovered {
  return {
    workspaceId: 'ws', workspaceSlug: 'ws', role, projectId: 'proj', crewModelId: 'crew-m', shipsModelId: 'ships-m',
    reposModelId: 'repos-m', models: { issues: 'i', comments: 'c', crew: 'crew-m' }, seats: {}, holds: [], candidates: [], problems: [], provisioning: [],
  };
}

function mockFetch(routes: Record<string, unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const key = new URL(String(input)).pathname;
    return key in routes
      ? new Response(JSON.stringify(routes[key]), { status: 200 })
      : new Response('{}', { status: 404 });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

const ACCESS = (access: string) => ({
  '/api/data-models/crew-m/access': { access },
  '/api/data-models/ships-m/access': { access },
  '/api/data-models/repos-m/access': { access },
});

test('a member key with no project role gets five named misses', async (t) => {
  t.after(mockFetch({ ...ACCESS('NONE'), '/api/projects/proj/capabilities': { MINT_AGENT_KEYS: false } }));
  const items = await checkCapabilities(BASE, found('WORKSPACE_USER'));
  assert.equal(items.length, 5);
  assert.ok(items.every((i) => i.status === 'missing' && i.askFor));
  assert.match(missLine(items[3]!), /Mint agent keys/);
});

test('an admin key gets all ok', async (t) => {
  t.after(mockFetch({ ...ACCESS('DELETE'), '/api/projects/proj/capabilities': { MINT_AGENT_KEYS: true } }));
  const items = await checkCapabilities(BASE, found('WORKSPACE_ADMIN'));
  assert.deepEqual(items.map((i) => i.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
});

test('a member holding the mint capability and table writes misses only the persona sync', async (t) => {
  t.after(mockFetch({ ...ACCESS('WRITE'), '/api/projects/proj/capabilities': { MINT_AGENT_KEYS: true } }));
  const items = await checkCapabilities(BASE, found('WORKSPACE_USER'));
  assert.deepEqual(items.filter((i) => i.status === 'missing').map((i) => i.key), ['sync-personas']);
});

test('an unreadable answer is skipped, not reported as a miss', async (t) => {
  t.after(mockFetch({}));
  const items = await checkCapabilities(BASE, { ...found('WORKSPACE_USER'), shipsModelId: undefined });
  assert.equal(items.find((i) => i.key === 'ships-table')!.status, 'skipped');
  assert.equal(items.find((i) => i.key === 'mint-agent-keys')!.status, 'skipped');
  assert.match(describeCapability(items[1]!), /^skipped/);
});

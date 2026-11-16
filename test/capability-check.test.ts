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

const AGENTS = (names: string[]) => ({
  '/api/data-models/agents': { id: 'agents-m' },
  '/api/data-models/agents-m/records': names.map((name) => ({ name })),
});
const ALL_PERSONAS = ['Developer', 'Design', 'QA', 'Triage', 'Pair'];

test('a member key with no project role gets four named misses and the personas line as info', async (t) => {
  t.after(mockFetch({ ...ACCESS('NONE'), ...AGENTS(ALL_PERSONAS), '/api/projects/proj/capabilities': { MINT_AGENT_KEYS: false } }));
  const items = await checkCapabilities(BASE, found('WORKSPACE_USER'));
  assert.equal(items.length, 5);
  assert.ok(items.slice(0, 4).every((i) => i.status === 'missing' && i.askFor));
  assert.equal(items[4]!.status, 'info');
  assert.match(missLine(items[3]!), /Mint agent keys/);
});

test('an admin key gets all ok', async (t) => {
  t.after(mockFetch({ ...ACCESS('DELETE'), '/api/projects/proj/capabilities': { MINT_AGENT_KEYS: true } }));
  const items = await checkCapabilities(BASE, found('WORKSPACE_ADMIN'));
  assert.deepEqual(items.map((i) => i.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
});

test('a member with personas in the workspace has no miss and no ask-an-admin text', async (t) => {
  t.after(mockFetch({ ...ACCESS('WRITE'), ...AGENTS(ALL_PERSONAS), '/api/projects/proj/capabilities': { MINT_AGENT_KEYS: true } }));
  const items = await checkCapabilities(BASE, found('WORKSPACE_USER'));
  assert.deepEqual(items.filter((i) => i.status === 'missing'), []);
  const line = describeCapability(items[4]!);
  assert.match(line, /^info/);
  assert.doesNotMatch(line, /admin/i);
});

test('a member in a workspace with no persona rows is told an admin must run the sync once', async (t) => {
  t.after(mockFetch({ ...ACCESS('WRITE'), ...AGENTS([]), '/api/projects/proj/capabilities': { MINT_AGENT_KEYS: true } }));
  const items = await checkCapabilities(BASE, found('WORKSPACE_USER'));
  const miss = items.filter((i) => i.status === 'missing');
  assert.deepEqual(miss.map((i) => i.key), ['sync-personas']);
  assert.match(missLine(miss[0]!), /ask a workspace admin for one `crew agents sync` run/);
});

test('an unreadable Agents table is skipped for a member, not a miss', async (t) => {
  t.after(mockFetch({ ...ACCESS('WRITE'), '/api/projects/proj/capabilities': { MINT_AGENT_KEYS: true } }));
  const items = await checkCapabilities(BASE, found('WORKSPACE_USER'));
  assert.equal(items[4]!.status, 'skipped');
});

test('an unreadable answer is skipped, not reported as a miss', async (t) => {
  t.after(mockFetch({}));
  const items = await checkCapabilities(BASE, { ...found('WORKSPACE_USER'), shipsModelId: undefined });
  assert.equal(items.find((i) => i.key === 'ships-table')!.status, 'skipped');
  assert.equal(items.find((i) => i.key === 'mint-agent-keys')!.status, 'skipped');
  assert.match(describeCapability(items[1]!), /^skipped/);
});

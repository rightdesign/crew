import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAgentsSync } from '../src/agents-sync-run.ts';
import { resolvedPathFor, type Route } from '../src/config.ts';

function promptsDir(): string {
  const prompts = mkdtempSync(join(tmpdir(), 'crew-sync-run-'));
  const personas = join(prompts, 'personas');
  mkdirSync(personas, { recursive: true });
  writeFileSync(join(personas, 'common.md'), 'COMMON\n');
  for (const role of ['dev', 'design', 'qa', 'triage', 'pair']) writeFileSync(join(personas, `lane-${role}.md`), `LANE-${role}\n`);
  return prompts;
}

function route(role: string): Route {
  return {
    route: 'issues/test', enabled: true, dir: '/tmp/x', repos: {}, baseUrl: 'https://example.test', apiKey: 'sk_test',
    hooks: {}, labels: {}, release: {}, promptsDir: promptsDir(),
    resolved: { workspaceId: 'ws-1', role, models: { issues: 'i', comments: 'c', crew: 'crew-model' }, seats: {}, operator: 'op', holds: [] },
  } as unknown as Route;
}

function mockFetch(handlers: Record<string, unknown>) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}${url.search}`;
    calls.push(key);
    if (!(key in handlers)) throw new Error(`unmocked request: ${key}`);
    return new Response(JSON.stringify(handlers[key]), { status: 200 });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, calls };
}

test('CREW-2241: a member key syncs read-only: reports missing rows, writes no workspace rows, skips skills', async (t) => {
  const { restore, calls } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': { id: 'agents-model-1', workspaceId: 'ws-1', name: 'Agents', tableName: 'agents' },
    'GET /api/data-models/agents-model-1/records?limit=200': [],
  });
  t.after(restore);
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-sync-state-'));
  const said: string[] = [];
  const run = await runAgentsSync(route('MEMBER'), { stateDir, say: (l) => said.push(l), warn: () => {} });
  assert.equal(run.readOnly, true);
  assert.equal(run.skillResult, undefined);
  assert.ok(run.personaResult.outcomes.every((o) => o.action === 'missing'));
  assert.ok(said.some((l) => /not a workspace admin/.test(l)));
  assert.equal(calls.filter((c) => !c.startsWith('GET')).length, 0);
  // The resolved file records what was (not) linked, merged rather than replaced.
  assert.ok(existsSync(resolvedPathFor(stateDir, 'issues/test')));
  assert.ok('agentPersonas' in JSON.parse(readFileSync(resolvedPathFor(stateDir, 'issues/test'), 'utf8')));
});

test('CREW-2241: dryRun writes no state file', async (t) => {
  const { restore } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': { id: 'agents-model-1', workspaceId: 'ws-1', name: 'Agents', tableName: 'agents' },
    'GET /api/data-models/agents-model-1/records?limit=200': [],
  });
  t.after(restore);
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-sync-state-'));
  await runAgentsSync(route('MEMBER'), { stateDir, dryRun: true, say: () => {}, warn: () => {} });
  assert.equal(existsSync(resolvedPathFor(stateDir, 'issues/test')), false);
});

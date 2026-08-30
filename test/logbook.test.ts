import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { listLogEntries, showLogEntry, LogbookError } from '../src/logbook.ts';
import type { Route } from '../src/config.ts';

function makeRoute(): Route {
  return {
    route: 'issues/test',
    enabled: true,
    dir: '/tmp/does-not-matter',
    repos: {},
    baseUrl: 'https://example.test',
    apiKey: 'sk_test',
    hooks: {},
    labels: {},
    release: {},
    resolved: {
      workspaceId: 'ws-1',
      models: { issues: 'issues-model', comments: 'comments-model', crew: 'crew-model' },
      seats: {},
      operator: 'operator-id',
      holds: [],
    },
  } as unknown as Route;
}

/** Same routing shape as agents.test.ts's own mockFetch — unmocked calls fail loudly. */
function mockFetch(handlers: Record<string, (body: unknown) => { status: number; body: unknown }>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const key = `${method} ${url.pathname}${url.search}`;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const handler = handlers[key];
    if (!handler) throw new Error(`unmocked request: ${key}`);
    const { status, body: respBody } = handler(body);
    return new Response(JSON.stringify(respBody), { status });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; } };
}

const AGENT_LOG_MODEL = { id: 'log-model-1', name: 'Agent Log', tableName: 'agent_log' };
const AGENTS_MODEL = { id: 'agents-model-1', name: 'Agents', tableName: 'agents' };

test('listLogEntries sorts newest-first by started_at', async (t) => {
  const { restore } = mockFetch({
    'GET /api/data-models/agent_log?workspaceId=ws-1': () => ({ status: 200, body: AGENT_LOG_MODEL }),
    'GET /api/data-models/log-model-1/records?limit=20': () => ({
      status: 200,
      body: [
        { id: 'e1', started_at: '2026-08-29T00:00:00Z', outcome: 'success' },
        { id: 'e2', started_at: '2026-08-30T00:00:00Z', outcome: 'error' },
      ],
    }),
  });
  t.after(restore);
  const entries = await listLogEntries(makeRoute());
  assert.deepEqual(entries.map((e) => e.id), ['e2', 'e1']);
});

test('listLogEntries with --role resolves the Agents row by name first, and filters by agent_id', async (t) => {
  const { restore } = mockFetch({
    'GET /api/data-models/agent_log?workspaceId=ws-1': () => ({ status: 200, body: AGENT_LOG_MODEL }),
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records?limit=200': () => ({
      status: 200, body: [{ id: 'row-dev', name: 'Developer' }],
    }),
    'GET /api/data-models/log-model-1/records?limit=20&filters=%5B%7B%22columnName%22%3A%22agent_id%22%2C%22operator%22%3A%22EQ%22%2C%22value%22%3A%22row-dev%22%7D%5D': () =>
      ({ status: 200, body: [{ id: 'e1', started_at: '2026-08-29T00:00:00Z' }] }),
  });
  t.after(restore);
  const entries = await listLogEntries(makeRoute(), { role: 'developer' });
  assert.deepEqual(entries.map((e) => e.id), ['e1']);
});

test('listLogEntries with --role finding no matching persona returns empty rather than an unfiltered list', async (t) => {
  const { restore } = mockFetch({
    'GET /api/data-models/agent_log?workspaceId=ws-1': () => ({ status: 200, body: AGENT_LOG_MODEL }),
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records?limit=200': () => ({ status: 200, body: [] }),
  });
  t.after(restore);
  const entries = await listLogEntries(makeRoute(), { role: 'nope' });
  assert.deepEqual(entries, []);
});

test('showLogEntry with no --prompt does not touch the Agents/history endpoints at all', async (t) => {
  const { restore } = mockFetch({
    'GET /api/data-models/agent_log?workspaceId=ws-1': () => ({ status: 200, body: AGENT_LOG_MODEL }),
    'GET /api/data-models/log-model-1/records/e1': () => ({ status: 200, body: { id: 'e1', outcome: 'success' } }),
  });
  t.after(restore);
  const { entry, reconstruction } = await showLogEntry(makeRoute(), 'e1');
  assert.equal(entry.id, 'e1');
  assert.equal(reconstruction.status, 'not_recorded');
});

test('showLogEntry throws a LogbookError naming the entry id when it does not exist', async (t) => {
  const { restore } = mockFetch({
    'GET /api/data-models/agent_log?workspaceId=ws-1': () => ({ status: 200, body: AGENT_LOG_MODEL }),
    'GET /api/data-models/log-model-1/records/missing': () => ({ status: 404, body: { message: 'not found' } }),
  });
  t.after(restore);
  await assert.rejects(
    showLogEntry(makeRoute(), 'missing', { withPrompt: true }),
    (e: unknown) => e instanceof LogbookError && /missing/.test((e as Error).message),
  );
});

test('showLogEntry --prompt reports not_recorded for a pre-ISSUE-529 entry (no prompt_version)', async (t) => {
  const { restore } = mockFetch({
    'GET /api/data-models/agent_log?workspaceId=ws-1': () => ({ status: 200, body: AGENT_LOG_MODEL }),
    'GET /api/data-models/log-model-1/records/e1': () => ({ status: 200, body: { id: 'e1', agent_id: 'row-dev' } }),
  });
  t.after(restore);
  const { reconstruction } = await showLogEntry(makeRoute(), 'e1', { withPrompt: true });
  assert.equal(reconstruction.status, 'not_recorded');
  assert.match(reconstruction.reason!, /ISSUE-377\/529/);
});

test('showLogEntry --prompt reports exact when the history entry\'s prompt hashes to the recorded prompt_sha', async (t) => {
  const promptBody = 'COMMON\nDEV BRIEF\n';
  const sha = createHash('sha256').update(promptBody).digest('hex');
  const { restore } = mockFetch({
    'GET /api/data-models/agent_log?workspaceId=ws-1': () => ({ status: 200, body: AGENT_LOG_MODEL }),
    'GET /api/data-models/log-model-1/records/e1': () =>
      ({ status: 200, body: { id: 'e1', agent_id: 'row-dev', prompt_version: 'hist-1', prompt_sha: sha } }),
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records/row-dev/history?limit=200': () => ({
      status: 200,
      body: [{ history_id: 'hist-1', changed_at: '2026-08-30T00:00:00Z', prompt: promptBody }],
    }),
  });
  t.after(restore);
  const { reconstruction } = await showLogEntry(makeRoute(), 'e1', { withPrompt: true });
  assert.equal(reconstruction.status, 'exact');
  assert.equal(reconstruction.prompt, promptBody);
});

test('showLogEntry --prompt reports approximate when the hash does not match — the local file diverged from what was synced', async (t) => {
  const { restore } = mockFetch({
    'GET /api/data-models/agent_log?workspaceId=ws-1': () => ({ status: 200, body: AGENT_LOG_MODEL }),
    'GET /api/data-models/log-model-1/records/e1': () =>
      ({ status: 200, body: { id: 'e1', agent_id: 'row-dev', prompt_version: 'hist-1', prompt_sha: 'deadbeef' } }),
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records/row-dev/history?limit=200': () => ({
      status: 200,
      body: [{ history_id: 'hist-1', changed_at: '2026-08-30T00:00:00Z', prompt: 'DIFFERENT CONTENT\n' }],
    }),
  });
  t.after(restore);
  const { reconstruction } = await showLogEntry(makeRoute(), 'e1', { withPrompt: true });
  assert.equal(reconstruction.status, 'approximate');
  assert.match(reconstruction.reason!, /does not match/);
});

test('showLogEntry --prompt reports approximate when the named history entry no longer exists', async (t) => {
  const { restore } = mockFetch({
    'GET /api/data-models/agent_log?workspaceId=ws-1': () => ({ status: 200, body: AGENT_LOG_MODEL }),
    'GET /api/data-models/log-model-1/records/e1': () =>
      ({ status: 200, body: { id: 'e1', agent_id: 'row-dev', prompt_version: 'hist-gone', prompt_sha: 'x' } }),
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records/row-dev/history?limit=200': () => ({ status: 200, body: [] }),
  });
  t.after(restore);
  const { reconstruction } = await showLogEntry(makeRoute(), 'e1', { withPrompt: true });
  assert.equal(reconstruction.status, 'approximate');
  assert.match(reconstruction.reason!, /no longer exists/);
});

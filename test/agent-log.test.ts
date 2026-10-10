import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportAgentRun, type AgentLogTarget } from '../src/agent-log.ts';

/** Wires a fetch mock keyed by exact pathname+method, ignoring host/baseUrl — same shape as connect.test.ts's mockFetch. */
function mockFetch(routes: Record<string, unknown>) {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ key: string; body: unknown }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    calls.push({ key, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (!(key in routes)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = originalFetch; }, calls };
}

const target: AgentLogTarget = {
  baseUrl: 'https://example.test', workspaceId: 'ws-1', apiKey: 'k', userAgent: 'crew-test', agentId: 'agent-1',
};

test('reportAgentRun creates the log row, then flushes its cycles in order against that id', async (t) => {
  const { restore, calls } = mockFetch({
    'POST /api/workspaces/ws-1/agents/log': { id: 'log-1' },
    'POST /api/workspaces/ws-1/agents/log/log-1/cycles': { id: 'cycle-x' },
  });
  t.after(restore);

  const { agentLogId } = await reportAgentRun(target, {
    ticketReference: 'ISSUE-416',
    outcome: 'success',
    startedAt: '2026-08-28T00:00:00.000Z',
    finishedAt: '2026-08-28T00:05:00.000Z',
    cycles: [
      { cycleIndex: 0, occurredAt: '2026-08-28T00:01:00.000Z', thinking: 'first' },
      { cycleIndex: 1, occurredAt: '2026-08-28T00:02:00.000Z', thinking: 'second' },
    ],
  });

  assert.equal(agentLogId, 'log-1');
  assert.equal(calls[0]!.key, 'POST /api/workspaces/ws-1/agents/log');
  assert.deepEqual(calls[0]!.body, {
    agentId: 'agent-1', ticketReference: 'ISSUE-416', outcome: 'success',
    startedAt: '2026-08-28T00:00:00.000Z', finishedAt: '2026-08-28T00:05:00.000Z',
    source: 'client', client: 'crew',
  });
  // Cycles land in order, against the log row's own id — not sent concurrently
  // or out of sequence, since Cycle Index is meaningful order.
  assert.equal(calls.length, 3);
  assert.equal(calls[1]!.key, 'POST /api/workspaces/ws-1/agents/log/log-1/cycles');
  assert.deepEqual(calls[1]!.body, { cycleIndex: 0, occurredAt: '2026-08-28T00:01:00.000Z', thinking: 'first' });
  assert.deepEqual(calls[2]!.body, { cycleIndex: 1, occurredAt: '2026-08-28T00:02:00.000Z', thinking: 'second' });
});

test('a run with no cycles still creates the Agent Log row, and posts no cycles', async (t) => {
  const { restore, calls } = mockFetch({ 'POST /api/workspaces/ws-1/agents/log': { id: 'log-2' } });
  t.after(restore);

  const { agentLogId } = await reportAgentRun(target, {
    outcome: 'error', startedAt: 'a', finishedAt: 'b', cycles: [],
  });
  assert.equal(agentLogId, 'log-2');
  assert.equal(calls.length, 1);
});

test('agentId is omitted from the body when the target has none — a run still reports without one', async (t) => {
  const { restore, calls } = mockFetch({ 'POST /api/workspaces/ws-1/agents/log': { id: 'log-3' } });
  t.after(restore);

  await reportAgentRun({ ...target, agentId: undefined }, {
    outcome: 'success', startedAt: 'a', finishedAt: 'b', cycles: [],
  });
  assert.equal((calls[0]!.body as { agentId?: string }).agentId, undefined);
});

test('reports source: client, model and the token/cost breakdown when the run provides them (ISSUE-376)', async (t) => {
  const { restore, calls } = mockFetch({ 'POST /api/workspaces/ws-1/agents/log': { id: 'log-4' } });
  t.after(restore);

  await reportAgentRun(target, {
    outcome: 'success', startedAt: 'a', finishedAt: 'b', cycles: [],
    model: 'claude-sonnet-5',
    tokensIn: 1200,
    tokensOut: 300,
    cacheReadTokens: 40,
    cacheWriteTokens: 5,
    costUsd: 0.0456,
  });

  assert.deepEqual(calls[0]!.body, {
    agentId: 'agent-1', outcome: 'success', startedAt: 'a', finishedAt: 'b',
    source: 'client', client: 'crew',
    model: 'claude-sonnet-5', tokensIn: 1200, tokensOut: 300,
    cacheReadTokens: 40, cacheWriteTokens: 5, costUsd: 0.0456,
  });
});

test('a non-ok response throws, naming the path and status', async (t) => {
  const { restore } = mockFetch({});
  t.after(restore);

  await assert.rejects(
    () => reportAgentRun(target, { outcome: 'success', startedAt: 'a', finishedAt: 'b', cycles: [] }),
    /\/agents\/log: 404/,
  );
});

test('a 400 on the identity fields retries the row without them, so an older server still gets the run (CREW-1516)', async (t) => {
  const original = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    bodies.push(body);
    if ('harness' in body || 'provider' in body) {
      return new Response(JSON.stringify({ message: 'property harness should not exist' }), { status: 400 });
    }
    return new Response(JSON.stringify({ id: 'log-9' }), { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });

  const { agentLogId } = await reportAgentRun(target, {
    outcome: 'success', startedAt: 'a', finishedAt: 'b', cycles: [], harness: 'claude', provider: 'anthropic',
  });
  assert.equal(agentLogId, 'log-9');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0]!.harness, 'claude');
  assert.equal(bodies[0]!.provider, 'anthropic');
  assert.ok(!('harness' in bodies[1]!) && !('provider' in bodies[1]!));
});

test('a 400 with no identity fields sent is not retried', async (t) => {
  const { restore } = mockFetch({});
  t.after(restore);
  await assert.rejects(() => reportAgentRun(target, { outcome: 'success', startedAt: 'a', finishedAt: 'b', cycles: [] }), /404/);
});

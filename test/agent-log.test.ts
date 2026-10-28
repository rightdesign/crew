import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportAgentRun, counterIncrements, resetCounterColumnCache, queueTicketCounters, replayQueuedTicketCounters, type AgentLogTarget, type CounterColumns } from '../src/agent-log.ts';

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

// --- CREW-2580: per-ticket spend counters -----------------------------------

const counters: CounterColumns = {
  agentRuns: 'agent_runs', tokensIn: 'tokens_in', tokensOut: 'tokens_out',
  cacheReadTokens: 'cache_read_tokens', cacheWriteTokens: 'cache_write_tokens', costUsd: 'cost_usd',
};
const ticketTarget: AgentLogTarget = {
  ...target,
  tickets: { issuesModelId: 'issues-1', keyColumn: 'issue_id', tagColumn: 'issue_tag', counters },
};
const ALL = new Set(Object.values(counters));
const modelOf = (cols: string[]) => ({ fields: cols.map((columnName) => ({ columnName })) });
const spend = { tokensIn: 30, tokensOut: 4026, cacheReadTokens: 1044528, cacheWriteTokens: 82217, costUsd: 0.578 };
const base = { outcome: 'success', startedAt: 'a', finishedAt: 'b', cycles: [] };

test('counterIncrements sends one atomic increment per figure the run reported', () => {
  assert.deepEqual(counterIncrements({ ...base, ...spend }, counters, ALL), {
    agent_runs: { $op: 'increment', value: 1 },
    tokens_in: { $op: 'increment', value: 30 },
    tokens_out: { $op: 'increment', value: 4026 },
    cache_read_tokens: { $op: 'increment', value: 1044528 },
    cache_write_tokens: { $op: 'increment', value: 82217 },
    cost_usd: { $op: 'increment', value: 0.578 },
  });
});

test('counterIncrements omits an unreported figure and a column the table lacks, never writing 0', () => {
  const noCost = counterIncrements({ ...base, ...spend, costUsd: undefined }, counters, ALL);
  assert.equal('cost_usd' in noCost, false);
  const partial = counterIncrements({ ...base, ...spend }, counters, new Set(['agent_runs', 'tokens_in']));
  assert.deepEqual(Object.keys(partial), ['agent_runs', 'tokens_in']);
  assert.deepEqual(counterIncrements({ ...base, ...spend }, counters, new Set()), {});
});

test('a run on a ticket points its Agent Log row at the record and increments the counters', async (t) => {
  resetCounterColumnCache();
  const { restore, calls } = mockFetch({
    'GET /api/data-models/issues-1/records': [{ id: 'rec-9' }],
    'POST /api/workspaces/ws-1/agents/log': { id: 'log-7' },
    'GET /api/data-models/issues-1': modelOf([...ALL, 'issue_id']),
    'PATCH /api/data-models/issues-1/records/rec-9': {},
  });
  t.after(restore);

  const out = await reportAgentRun(ticketTarget, { ...base, ...spend, ticketReference: 'CREW-2580' });
  assert.equal(out.counterWarning, undefined);
  const log = calls.find((c) => c.key === 'POST /api/workspaces/ws-1/agents/log')!.body as Record<string, unknown>;
  assert.equal(log.workItemTable, 'issues-1');
  assert.equal(log.workItemRecordId, 'rec-9');
  const patch = calls.find((c) => c.key.startsWith('PATCH'))!;
  assert.equal(patch.key, 'PATCH /api/data-models/issues-1/records/rec-9');
  assert.deepEqual(patch.body, counterIncrements({ ...base, ...spend }, counters, ALL));
});

test('a run with no ticket reference changes no ticket', async (t) => {
  resetCounterColumnCache();
  const { restore, calls } = mockFetch({ 'POST /api/workspaces/ws-1/agents/log': { id: 'log-8' } });
  t.after(restore);
  await reportAgentRun(ticketTarget, { ...base, ...spend });
  assert.deepEqual(calls.map((c) => c.key), ['POST /api/workspaces/ws-1/agents/log']);
});

test('an Issues table without the columns is written around with no PATCH and no warning', async (t) => {
  resetCounterColumnCache();
  const { restore, calls } = mockFetch({
    'GET /api/data-models/issues-1/records': [{ id: 'rec-9' }],
    'POST /api/workspaces/ws-1/agents/log': { id: 'log-9' },
    'GET /api/data-models/issues-1': modelOf(['issue_id']),
  });
  t.after(restore);
  const out = await reportAgentRun(ticketTarget, { ...base, ...spend, ticketReference: 'ISSUE-1' });
  assert.equal(out.counterWarning, undefined);
  assert.equal(calls.some((c) => c.key.startsWith('PATCH')), false);
});

test('a failed increment comes back as a warning and the report still succeeds', async (t) => {
  resetCounterColumnCache();
  const { restore } = mockFetch({
    'GET /api/data-models/issues-1/records': [{ id: 'rec-9' }],
    'POST /api/workspaces/ws-1/agents/log': { id: 'log-10' },
    'GET /api/data-models/issues-1': modelOf([...ALL]),
  });  // no PATCH route: the mock answers 404
  t.after(restore);
  const out = await reportAgentRun(ticketTarget, { ...base, ...spend, ticketReference: 'ISSUE-1' });
  assert.equal(out.agentLogId, 'log-10');
  assert.match(out.counterWarning ?? '', /could not add run spend to ISSUE-1/);
});

/** A fetch whose PATCH answers with `patchStatus` (switchable mid-test); everything else comes from `routes`. */
function flakyPatch(routes: Record<string, unknown>) {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const state = { patchStatus: 503 };
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    calls.push(key);
    if (key.startsWith('PATCH')) return new Response('{}', { status: state.patchStatus });
    if (!(key in routes)) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = originalFetch; }, calls, state };
}

const quiet = { emit: () => undefined, warn: () => undefined };

test('a 5xx on the counter PATCH is queued on its own and replays exactly once without reposting the row', async (t) => {
  resetCounterColumnCache();
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-counters-'));
  const { restore, calls, state } = flakyPatch({
    'GET /api/data-models/issues-1/records': [{ id: 'rec-9' }],
    'POST /api/workspaces/ws-1/agents/log': { id: 'log-11' },
    'GET /api/data-models/issues-1': modelOf([...ALL]),
  });
  t.after(restore);

  const out = await reportAgentRun(ticketTarget, { ...base, ...spend, ticketReference: 'ISSUE-1' });
  assert.equal(out.agentLogId, 'log-11');
  assert.match(out.counterWarning ?? '', /could not add run spend to ISSUE-1/);
  assert.ok(out.counterRetry);
  const { apiKey: _key, ...bare } = ticketTarget;
  queueTicketCounters(stateDir, 'run-1', { version: 1, route: 'r', role: 'dev', target: bare, write: out.counterRetry, attempts: 0, nextAttemptAt: new Date(0).toISOString() });

  // Still down: it stays queued, backs off, and nothing but the PATCH is tried.
  calls.length = 0;
  assert.equal(await replayQueuedTicketCounters(stateDir, 'r', async () => 'k', quiet, new Date(1000)), 0);
  assert.equal(readdirSync(join(stateDir, 'pending-ticket-counters')).length, 1);
  assert.equal(calls.some((c) => c.startsWith('POST')), false);

  // Back up: sent once, removed, and a second pass sends nothing.
  state.patchStatus = 200;
  const later = new Date(Date.now() + 24 * 3600 * 1000);
  calls.length = 0;
  assert.equal(await replayQueuedTicketCounters(stateDir, 'r', async () => 'k', quiet, later), 1);
  assert.equal(calls.filter((c) => c.startsWith('PATCH')).length, 1);
  assert.equal(calls.some((c) => c.startsWith('POST')), false);
  assert.equal(readdirSync(join(stateDir, 'pending-ticket-counters')).length, 0);
  calls.length = 0;
  assert.equal(await replayQueuedTicketCounters(stateDir, 'r', async () => 'k', quiet, later), 0);
  assert.equal(calls.length, 0);
});

test('a 4xx on the counter PATCH is only a warning, never queued', async (t) => {
  resetCounterColumnCache();
  const { restore, state } = flakyPatch({
    'GET /api/data-models/issues-1/records': [{ id: 'rec-9' }],
    'POST /api/workspaces/ws-1/agents/log': { id: 'log-12' },
    'GET /api/data-models/issues-1': modelOf([...ALL]),
  });
  t.after(restore);
  state.patchStatus = 400;
  const out = await reportAgentRun(ticketTarget, { ...base, ...spend, ticketReference: 'ISSUE-1' });
  assert.match(out.counterWarning ?? '', /400/);
  assert.equal(out.counterRetry, undefined);
});

test('a 5xx on the column probe is queued, and the replay sends only the columns the table has', async (t) => {
  resetCounterColumnCache();
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-counters-'));
  const originalFetch = globalThis.fetch;
  const sent: Array<{ key: string; body: unknown }> = [];
  let modelUp = false;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    if (key === 'GET /api/data-models/issues-1') {
      return modelUp ? new Response(JSON.stringify(modelOf(['agent_runs', 'tokens_in'])), { status: 200 }) : new Response('{}', { status: 502 });
    }
    if (key === 'GET /api/data-models/issues-1/records') return new Response(JSON.stringify([{ id: 'rec-9' }]), { status: 200 });
    if (key === 'POST /api/workspaces/ws-1/agents/log') return new Response(JSON.stringify({ id: 'log-13' }), { status: 200 });
    if (key.startsWith('PATCH')) { sent.push({ key, body: JSON.parse(init!.body as string) }); return new Response('{}', { status: 200 }); }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const out = await reportAgentRun(ticketTarget, { ...base, ...spend, ticketReference: 'ISSUE-1' });
  assert.ok(out.counterRetry);
  assert.equal(sent.length, 0);
  const { apiKey: _key, ...bare } = ticketTarget;
  queueTicketCounters(stateDir, 'run-2', { version: 1, route: 'r', role: 'dev', target: bare, write: out.counterRetry, attempts: 0, nextAttemptAt: new Date(0).toISOString() });

  resetCounterColumnCache();
  modelUp = true;
  assert.equal(await replayQueuedTicketCounters(stateDir, 'r', async () => 'k', quiet, new Date(1000)), 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.body, { agent_runs: { $op: 'increment', value: 1 }, tokens_in: { $op: 'increment', value: 30 } });
});

test('reportAgentRun sends numTurns and prefixTokens when known and omits them otherwise', async (t) => {
  const { restore, calls } = mockFetch({ 'POST /api/workspaces/ws-1/agents/log': { id: 'log-t' } });
  t.after(restore);
  const base = { outcome: 'success', startedAt: '2026-10-28T00:00:00.000Z', finishedAt: '2026-10-28T00:05:00.000Z', cycles: [] };

  await reportAgentRun(target, { ...base, numTurns: 18, prefixTokens: 21000 });
  assert.equal((calls[0]!.body as Record<string, unknown>).numTurns, 18);
  assert.equal((calls[0]!.body as Record<string, unknown>).prefixTokens, 21000);

  await reportAgentRun(target, base);
  const unknown = calls[1]!.body as Record<string, unknown>;
  assert.equal('numTurns' in unknown, false);
  assert.equal('prefixTokens' in unknown, false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTool, BeforeFirstEditTracker } from '../src/tool-classify.ts';
import { beforeFirstEditBody, reportAgentRun, resetCounterColumnCache, type AgentLogTarget } from '../src/agent-log.ts';
import { formatBeforeEdit } from '../src/logbook.ts';

test('classifyTool sorts each harness\'s tools', () => {
  assert.equal(classifyTool('Grep', 'foo'), 'search');
  assert.equal(classifyTool('Glob', '**/*.ts'), 'search');
  assert.equal(classifyTool('Bash', 'rg'), 'search');
  assert.equal(classifyTool('Bash', 'ls'), 'search');
  assert.equal(classifyTool('command', '/usr/bin/grep'), 'search');
  assert.equal(classifyTool('Bash', 'pnpm'), 'other');
  assert.equal(classifyTool('mcp__code__find_symbol', undefined), 'symbol');
  assert.equal(classifyTool('mcp__tablation__records_list', undefined), 'other');
  assert.equal(classifyTool('Edit', 'a.ts'), 'edit');
  assert.equal(classifyTool('file_change', 'a.ts'), 'edit');
  assert.equal(classifyTool('write_file', 'a.ts'), 'edit');
  assert.equal(classifyTool('Read', 'a.ts'), 'other');
  assert.equal(classifyTool(undefined, undefined), 'other');
});

test('three searches and two symbol lookups before the first edit', () => {
  const t = new BeforeFirstEditTracker();
  for (const [tool, target] of [['Grep', 'x'], ['mcp__code__find', undefined], ['Bash', 'rg'], ['mcp__code__refs', undefined], ['Glob', '*']] as const) t.note(tool, target, 1000);
  t.note('Edit', 'a.ts', 8400);
  t.note('Grep', 'later', 9000);   // after the first edit: not counted
  assert.deepEqual(t.result(), { calls: { search: 3, symbol: 2, other: 0 }, edited: true, secondsToFirstEdit: 8 });
});

test('a run that never edits records totals and the flag', () => {
  const t = new BeforeFirstEditTracker();
  t.note('Read', 'a.ts', 10);
  t.note('Grep', 'x', 20);
  assert.deepEqual(t.result(), { calls: { search: 1, symbol: 0, other: 1 }, edited: false });
  assert.match(formatBeforeEdit({ id: 'x', calls_before_edit_search: 1, calls_before_edit_symbol: 0, calls_before_edit_other: 1, edited: false }) ?? '', /no edit/);
  assert.equal(formatBeforeEdit({ id: 'x' }), undefined);
});

const target: AgentLogTarget = { baseUrl: 'https://example.test', workspaceId: 'ws-1', apiKey: 'k', userAgent: 't' };
const run = {
  outcome: 'success', startedAt: 'a', finishedAt: 'b', cycles: [],
  beforeFirstEdit: { calls: { search: 3, symbol: 2, other: 0 }, edited: true, secondsToFirstEdit: 8 },
};

function mock(routes: Record<string, { status?: number; body: unknown }>) {
  const orig = globalThis.fetch;
  const calls: Array<{ key: string; body: unknown }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    calls.push({ key, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const r = routes[key];
    return r ? new Response(JSON.stringify(r.body), { status: r.status ?? 200 }) : new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test('the figures are written only to columns the Agent Log has', async (t) => {
  resetCounterColumnCache();
  const m = mock({
    'POST /api/workspaces/ws-1/agents/log': { body: { id: 'log-1' } },
    'GET /api/data-models/agent_log': { body: { id: 'm1' } },
    'GET /api/data-models/m1': { body: { fields: [{ columnName: 'calls_before_edit_search' }, { columnName: 'calls_before_edit_symbol' }] } },
    'PATCH /api/data-models/m1/records/log-1': { body: {} },
  });
  t.after(m.restore);
  await reportAgentRun(target, run);
  assert.deepEqual(m.calls.find((c) => c.key.startsWith('PATCH'))?.body, { calls_before_edit_search: 3, calls_before_edit_symbol: 2 });
  assert.equal(beforeFirstEditBody(run.beforeFirstEdit).seconds_to_first_edit, 8);
});

test('a workspace without the columns, or a refused write, never fails the report', async (t) => {
  resetCounterColumnCache();
  const m = mock({
    'POST /api/workspaces/ws-1/agents/log': { body: { id: 'log-2' } },
    'GET /api/data-models/agent_log': { body: { id: 'm2' } },
    'GET /api/data-models/m2': { body: { fields: [] } },
  });
  t.after(m.restore);
  assert.equal((await reportAgentRun(target, run)).agentLogId, 'log-2');
  assert.equal(m.calls.some((c) => c.key.startsWith('PATCH')), false);
  const m2 = mock({ 'POST /api/workspaces/ws-1/agents/log': { body: { id: 'log-3' } } });
  t.after(m2.restore);
  assert.equal((await reportAgentRun(target, run)).agentLogId, 'log-3');
});

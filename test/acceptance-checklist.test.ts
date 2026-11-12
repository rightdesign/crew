import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceChecklistBlock, acceptanceBounceComment, ACCEPTANCE_BOUNCED_MARKER } from '../src/handoff-guard.ts';
import { ownRunBanner } from '../src/poll.ts';
import { reportAgentRun, resetCounterColumnCache, type AgentLogTarget } from '../src/agent-log.ts';

// CREW-2970: the ready-to-fill checklist, its bounce text and the bounce counter.
const DESC = '## What\n\nx\n\n## Acceptance\n\n- Runs `crew run --dry-run` and prints "ok".\n- A ticket without the section has no block.\n\n## Context\n\n- not acceptance\n';
const ticket = (description: unknown) => ({ id: 'row-1', issue_id: 'CREW-1', description, inFlight: () => false });
const own = (description: unknown) => ({ ticket: ticket(description), inFlight: () => false });

test('the checklist block carries every line verbatim, backticks and quotes intact', () => {
  const block = acceptanceChecklistBlock(['Runs `crew run --dry-run` and prints "ok".', 'Second']);
  assert.match(block, /^## Acceptance checklist \(copy into your last comment and fill each result\)\n/);
  assert.match(block, /- Runs `crew run --dry-run` and prints "ok"\.: <test, command or manual check, and its result>/);
  assert.match(block, /\n- Second: </);
  assert.equal(acceptanceChecklistBlock([]), '');
});

test('the brief ends its banner with the fenced block for a ticket with an Acceptance section, and not otherwise', () => {
  const withBlock = ownRunBanner(own(DESC));
  assert.match(withBlock, /Your ticket for this run: CREW-1/);
  assert.match(withBlock, /```\n## Acceptance checklist[\s\S]*prints "ok"\.[\s\S]*without the section has no block\.[\s\S]*\n```$/);
  assert.doesNotMatch(withBlock, /not acceptance/);
  assert.doesNotMatch(ownRunBanner(own('## What\n\nnothing')), /Acceptance checklist/);
  assert.doesNotMatch(ownRunBanner(own(undefined)), /```/);
});

test('the bounce comment includes the whole checklist, not only the missing lines', () => {
  const all = ['one', 'two'];
  const out = acceptanceBounceComment(['two'], 'ship', null, all);
  assert.match(out, new RegExp(ACCEPTANCE_BOUNCED_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(out, /Not quoted verbatim:\n- two\n/);
  assert.match(out, /```\n## Acceptance checklist[\s\S]*- one: <[\s\S]*- two: </);
  assert.doesNotMatch(acceptanceBounceComment(['two'], 'ship'), /```/);
});

const target: AgentLogTarget = {
  baseUrl: 'https://example.test', workspaceId: 'ws-1', apiKey: 'k', userAgent: 't',
  tickets: {
    issuesModelId: 'iss', keyColumn: 'issue_id', tagColumn: 'issue_tag',
    counters: { agentRuns: 'agent_runs', tokensIn: 'tokens_in', tokensOut: 'tokens_out', cacheReadTokens: 'cr', cacheWriteTokens: 'cw', costUsd: 'cost' },
  },
};
const run = { ticketReference: 'CREW-1', outcome: 'success', startedAt: 'a', finishedAt: 'b', cycles: [] };

function mock(routes: Record<string, unknown>) {
  const orig = globalThis.fetch;
  const calls: Array<{ key: string; body: unknown }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    calls.push({ key, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return key in routes ? new Response(JSON.stringify(routes[key]), { status: 200 }) : new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

const base = (columns: string[]) => ({
  'POST /api/workspaces/ws-1/agents/log': { id: 'log-1' },
  'GET /api/data-models/iss/records': [{ id: 'row-1' }],
  'GET /api/data-models/agent_log': { id: 'm1' },
  'GET /api/data-models/m1': { fields: columns.map((columnName) => ({ columnName })) },
  'PATCH /api/workspaces/ws-1/agents/log/log-1': {},
  'GET /api/data-models/iss/events': [
    { record_id: 'row-1', event_type: 'bounced', message: `${ACCEPTANCE_BOUNCED_MARKER}\n\nx` },
    { record_id: 'row-1', event_type: 'bounced', message: `${ACCEPTANCE_BOUNCED_MARKER}\n\ny` },
    { record_id: 'row-1', event_type: 'bounced', message: 'Hand-off bounced: not pushed' },
    { record_id: 'row-2', event_type: 'bounced', message: `${ACCEPTANCE_BOUNCED_MARKER}\n\nother ticket` },
  ],
});

test('the run entry records the bounce count through the agents log route', async (t) => {
  resetCounterColumnCache();
  const m = mock(base(['handoff_bounces']));
  t.after(m.restore);
  await reportAgentRun(target, run);
  assert.deepEqual(m.calls.find((c) => c.key === 'PATCH /api/workspaces/ws-1/agents/log/log-1')?.body, { handoffBounces: 2 });
});

test('the bounce count never goes through the records route', async (t) => {
  resetCounterColumnCache();
  const m = mock(base([]));
  t.after(m.restore);
  assert.equal((await reportAgentRun(target, run)).agentLogId, 'log-1');
  assert.equal(m.calls.some((c) => c.key.startsWith('PATCH /api/data-models/m1')), false);
});

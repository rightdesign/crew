import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  syncPersonas, personaDefaultPrompt, currentPersonaPrompt, describeSyncOutcome, describeCrewLink, AgentsSyncError,
  fetchHistoryEntries, fetchDivergedPrompt, fetchSeatAgentModel, fetchSeatPersona,
} from '../src/agents.ts';
import type { Route } from '../src/config.ts';

/** A minimal prompts directory with just the files agents.ts reads — what Route.promptsDir points at. */
function makePromptsDir(overrides: Partial<Record<'common' | 'dev' | 'design' | 'qa' | 'triage' | 'pair', string>> = {}): string {
  const prompts = mkdtempSync(join(tmpdir(), 'crew-agents-'));
  const personas = join(prompts, 'personas');
  mkdirSync(personas, { recursive: true });
  writeFileSync(join(personas, 'common.md'), overrides.common ?? 'COMMON\n');
  for (const role of ['dev', 'design', 'qa', 'triage', 'pair'] as const) {
    writeFileSync(join(personas, `lane-${role}.md`), overrides[role] ?? `LANE-${role.toUpperCase()}\n`);
  }
  return prompts;
}

function makeRoute(
  agentPersonas?: Route['resolved'] extends infer R ? (R extends { agentPersonas?: infer P } ? P : never) : never,
  seats: Partial<Record<'dev' | 'design' | 'qa' | 'triage', string>> = {},
  promptsDir: string = makePromptsDir(),
): Route {
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
    promptsDir,
    resolved: {
      workspaceId: 'ws-1',
      models: { issues: 'issues-model', comments: 'comments-model', crew: 'crew-model' },
      seats,
      operator: 'operator-id',
      holds: [],
      agentPersonas,
    },
  } as unknown as Route;
}

/** Routes fetch calls by `${method} ${pathname}${search}` to a handler; unmatched calls fail loudly instead of 404ing silently. */
function mockFetch(handlers: Record<string, (body: unknown) => { status: number; body: unknown }>) {
  const original = globalThis.fetch;
  const calls: Array<{ key: string; body: unknown; headers: Headers }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const key = `${method} ${url.pathname}${url.search}`;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ key, body, headers: new Headers(init?.headers) });
    const handler = handlers[key];
    if (!handler) throw new Error(`unmocked request: ${key}`);
    const { status, body: respBody } = handler(body);
    return new Response(JSON.stringify(respBody), { status });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, calls };
}

const AGENTS_MODEL = { id: 'agents-model-1', workspaceId: 'ws-1', name: 'Agents', tableName: 'agents' };

test('personaDefaultPrompt concatenates common.md and lane-<role>.md with no separator, matching assemblePrompt', () => {
  const promptsDir = makePromptsDir({ common: 'COMMON\n', dev: 'DEV BRIEF\n' });
  assert.equal(personaDefaultPrompt(promptsDir, 'dev'), 'COMMON\nDEV BRIEF\n');
});

test('personaDefaultPrompt throws a clear AgentsSyncError when a brief is missing', () => {
  const promptsDir = mkdtempSync(join(tmpdir(), 'crew-agents-empty-'));
  assert.throws(() => personaDefaultPrompt(promptsDir, 'dev'), AgentsSyncError);
});

test('personaDefaultPrompt skips common.md for pair — it is not a dev-loop lane', () => {
  const promptsDir = makePromptsDir({ common: 'COMMON\n', pair: 'PAIR BRIEF\n' });
  assert.equal(personaDefaultPrompt(promptsDir, 'pair'), 'PAIR BRIEF\n');
});

test('a workspace with no Agents table yet fails with a message naming ISSUE-465, not a raw 404', async (t) => {
  const { restore } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 404, body: { message: 'not found' } }),
  });
  t.after(restore);
  const route = makeRoute();
  await assert.rejects(
    syncPersonas(route, {}),
    (e: unknown) => e instanceof AgentsSyncError && /ISSUE-465/.test((e as Error).message),
  );
});

test('five missing personas are all created, named and prompted from the local briefs', async (t) => {
  const promptsDir = makePromptsDir();
  const created: Array<{ name: string; prompt: string }> = [];
  const { restore, calls } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records?limit=200': () => ({ status: 200, body: [] }),
    'POST /api/data-models/agents-model-1/records': (body: any) => {
      created.push(body);
      return { status: 200, body: { id: `row-${body.name}`, name: body.name, prompt: body.prompt, updated_at: '2026-08-28T00:00:00Z' } };
    },
  });
  t.after(restore);

  const result = await syncPersonas(makeRoute(undefined, {}, promptsDir), {});

  assert.equal(result.outcomes.length, 5);
  assert.ok(result.outcomes.every((o) => o.action === 'created'));
  assert.deepEqual(created.map((c) => c.name).sort(), ['Design', 'Developer', 'Pair', 'QA', 'Triage']);
  assert.equal(result.agentPersonas.dev?.agentId, 'row-Developer');
  assert.equal(result.agentPersonas.dev?.lastSyncedUpdatedAt, '2026-08-28T00:00:00Z');
  // Nothing writes a persona row through anything but this one path.
  assert.equal(calls.filter((c) => c.key.startsWith('PATCH')).length, 0);
});

test('ISSUE-377/529: a freshly-created row\'s newest history entry is cached as historyId, for a later run\'s prompt_version', async (t) => {
  const promptsDir = makePromptsDir();
  const { restore } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records?limit=200': () => ({ status: 200, body: [] }),
    'POST /api/data-models/agents-model-1/records': (body: any) =>
      ({ status: 200, body: { id: `row-${body.name}`, name: body.name, prompt: body.prompt, updated_at: '2026-08-28T00:00:00Z' } }),
    'GET /api/data-models/agents-model-1/records/row-Developer/history?limit=1': () =>
      ({ status: 200, body: [{ history_id: 'hist-dev-1', changed_at: '2026-08-28T00:00:00Z' }] }),
    'GET /api/data-models/agents-model-1/records/row-Design/history?limit=1': () => ({ status: 200, body: [] }),
    'GET /api/data-models/agents-model-1/records/row-QA/history?limit=1': () => ({ status: 200, body: [] }),
    'GET /api/data-models/agents-model-1/records/row-Triage/history?limit=1': () => ({ status: 200, body: [] }),
  });
  t.after(restore);

  const result = await syncPersonas(makeRoute(undefined, {}, promptsDir), {});
  assert.equal(result.agentPersonas.dev?.historyId, 'hist-dev-1');
  // An empty history response is not an error — just nothing to cache yet.
  assert.equal(result.agentPersonas.design?.historyId, undefined);
});

test('fetchHistoryEntries throws (rather than swallowing) a non-2xx response — showLogEntry needs to tell "lookup failed" apart from "no rows"', async (t) => {
  const { restore } = mockFetch({
    'GET /api/data-models/agents-model-1/records/row-1/history?limit=50': () => ({ status: 500, body: { message: 'boom' } }),
  });
  t.after(restore);
  await assert.rejects(
    fetchHistoryEntries(makeRoute(), 'agents-model-1', 'row-1', undefined),
    AgentsSyncError,
  );
});

test('dry run reports what it would create but performs no POST', async (t) => {
  const { restore, calls } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records?limit=200': () => ({ status: 200, body: [] }),
  });
  t.after(restore);
  const result = await syncPersonas(makeRoute(), { dryRun: true });
  assert.ok(result.outcomes.every((o) => o.action === 'created'));
  assert.equal(calls.filter((c) => c.key.startsWith('POST')).length, 0);
});

test('a row whose content already matches the local default is left alone and just re-anchors the cache', async (t) => {
  const promptsDir = makePromptsDir();
  const defaultPrompt = personaDefaultPrompt(promptsDir, 'dev');
  const { restore, calls } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records?limit=200': () => ({
      status: 200,
      body: ['Developer', 'Design', 'QA', 'Triage', 'Pair'].map((name) => ({
        id: `row-${name}`, name,
        prompt: name === 'Developer' ? defaultPrompt : `${name} placeholder`,
        updated_at: '2026-01-01T00:00:00Z',
      })),
    }),
  });
  t.after(restore);

  const result = await syncPersonas(makeRoute(undefined, {}, promptsDir), {});
  const dev = result.outcomes.find((o) => o.role === 'dev')!;
  assert.equal(dev.action, 'unchanged');
  assert.equal(result.agentPersonas.dev?.lastSyncedUpdatedAt, '2026-01-01T00:00:00Z');
  assert.equal(calls.filter((c) => c.key.startsWith('PATCH')).length, 0);
});

test('a differing row with no cached baseline is reported diverged and never overwritten — crew cannot prove it wrote the current content', async (t) => {
  const promptsDir = makePromptsDir();
  const { restore, calls } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records?limit=200': () => ({
      status: 200,
      body: ['Developer', 'Design', 'QA', 'Triage', 'Pair'].map((name) => ({
        id: `row-${name}`, name, prompt: 'someone typed this directly into the app', updated_at: '2026-01-01T00:00:00Z',
      })),
    }),
  });
  t.after(restore);

  const result = await syncPersonas(makeRoute(undefined, {}, promptsDir), {}); // no agentPersonas cache passed in
  assert.ok(result.outcomes.every((o) => o.action === 'diverged'));
  assert.equal(calls.filter((c) => c.key.startsWith('PATCH')).length, 0);
  assert.match(describeSyncOutcome(result.outcomes[0]!), /HAS LOCAL EDITS/);
});

test('a row matching crew\'s own last-synced updated_at is pushed forward when the local default has changed since', async (t) => {
  const promptsDir = makePromptsDir({ dev: 'NEW DEV BRIEF\n' });
  let patchedBody: unknown;
  const { restore, calls } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records?limit=200': () => ({
      status: 200,
      body: [
        { id: 'row-Developer', name: 'Developer', prompt: 'COMMON\nOLD DEV BRIEF\n', updated_at: '2026-01-01T00:00:00Z' },
        { id: 'row-Design', name: 'Design', prompt: personaDefaultPrompt(promptsDir, 'design'), updated_at: '2026-01-01T00:00:00Z' },
        { id: 'row-QA', name: 'QA', prompt: personaDefaultPrompt(promptsDir, 'qa'), updated_at: '2026-01-01T00:00:00Z' },
        { id: 'row-Triage', name: 'Triage', prompt: personaDefaultPrompt(promptsDir, 'triage'), updated_at: '2026-01-01T00:00:00Z' },
        { id: 'row-Pair', name: 'Pair', prompt: personaDefaultPrompt(promptsDir, 'pair'), updated_at: '2026-01-01T00:00:00Z' },
      ],
    }),
    // Content check (CREW-1055): the current prompt must match crew's
    // last-synced history entry before it pushes an update.
    'GET /api/data-models/agents-model-1/records/row-Developer/history?limit=50': () => ({
      status: 200,
      body: [{ history_id: 'hist-1', changed_at: '2026-01-01T00:00:00Z', prompt: 'COMMON\nOLD DEV BRIEF\n' }],
    }),
    'PATCH /api/data-models/agents-model-1/records/row-Developer': (body) => {
      patchedBody = body;
      return { status: 200, body: { id: 'row-Developer', name: 'Developer', prompt: (body as any).prompt, updated_at: '2026-01-02T00:00:00Z' } };
    },
    'GET /api/data-models/agents-model-1/records/row-Developer/history?limit=1': () => ({
      status: 200,
      body: [{ history_id: 'hist-2', changed_at: '2026-01-02T00:00:00Z', prompt: 'COMMON\nNEW DEV BRIEF\n' }],
    }),
  });
  t.after(restore);

  const route = makeRoute(
    { dev: { agentId: 'row-Developer', lastSyncedUpdatedAt: '2026-01-01T00:00:00Z', historyId: 'hist-1' } } as any,
    {},
    promptsDir,
  );
  const result = await syncPersonas(route, {});
  const dev = result.outcomes.find((o) => o.role === 'dev')!;
  assert.equal(dev.action, 'updated');
  assert.deepEqual(patchedBody, { prompt: 'COMMON\nNEW DEV BRIEF\n' });
  // The CAS target is the row's live `updated_at`, not the stale cached
  // baseline — an unrelated column change since the last sync must not
  // trip a false StaleWriteError.
  const patchCall = calls.find((c) => c.key.startsWith('PATCH'))!;
  assert.equal(patchCall.headers.get('X-Expected-Updated-At'), '2026-01-01T00:00:00Z');
  assert.equal(result.agentPersonas.dev?.lastSyncedUpdatedAt, '2026-01-02T00:00:00Z');
  assert.equal(result.agentPersonas.dev?.historyId, 'hist-2');
});

test('a stale-write 409 (someone edited between the list and the patch) is reported diverged, not thrown', async (t) => {
  const promptsDir = makePromptsDir({ dev: 'NEW DEV BRIEF\n' });
  const { restore } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records?limit=200': () => ({
      status: 200,
      body: [
        { id: 'row-Developer', name: 'Developer', prompt: 'COMMON\nOLD DEV BRIEF\n', updated_at: '2026-01-01T00:00:00Z' },
        { id: 'row-Design', name: 'Design', prompt: personaDefaultPrompt(promptsDir, 'design'), updated_at: '2026-01-01T00:00:00Z' },
        { id: 'row-QA', name: 'QA', prompt: personaDefaultPrompt(promptsDir, 'qa'), updated_at: '2026-01-01T00:00:00Z' },
        { id: 'row-Triage', name: 'Triage', prompt: personaDefaultPrompt(promptsDir, 'triage'), updated_at: '2026-01-01T00:00:00Z' },
        { id: 'row-Pair', name: 'Pair', prompt: personaDefaultPrompt(promptsDir, 'pair'), updated_at: '2026-01-01T00:00:00Z' },
      ],
    }),
    'GET /api/data-models/agents-model-1/records/row-Developer/history?limit=50': () => ({
      status: 200,
      body: [{ history_id: 'hist-1', changed_at: '2026-01-01T00:00:00Z', prompt: 'COMMON\nOLD DEV BRIEF\n' }],
    }),
    'PATCH /api/data-models/agents-model-1/records/row-Developer': () => ({ status: 409, body: { message: 'stale' } }),
  });
  t.after(restore);

  const route = makeRoute(
    { dev: { agentId: 'row-Developer', lastSyncedUpdatedAt: '2026-01-01T00:00:00Z', historyId: 'hist-1' } } as any,
    {},
    promptsDir,
  );
  const result = await syncPersonas(route, {});
  const dev = result.outcomes.find((o) => o.role === 'dev')!;
  assert.equal(dev.action, 'diverged');
  // The cache stays untouched — the caller must not persist a "synced" state that never happened.
  assert.equal(result.agentPersonas.dev?.lastSyncedUpdatedAt, '2026-01-01T00:00:00Z');
});

const CREW_MODEL_NO_FIELD = { id: 'crew-model', workspaceId: 'ws-1', name: 'Crew', tableName: 'crew', fields: [] };
const CREW_MODEL_WITH_FIELD = {
  id: 'crew-model',
  workspaceId: 'ws-1',
  name: 'Crew',
  tableName: 'crew',
  fields: [
    {
      id: 'field-1',
      columnName: 'agent_id',
      name: 'Agent',
      fieldType: { id: 'agents-ref-type', kind: 'REFERENCE', targetModelId: 'agents-model-1', isMultiple: false },
    },
  ],
};
const FIELD_TYPES = [
  { id: 'agents-ref-type', kind: 'REFERENCE', targetModelId: 'agents-model-1', isMultiple: false },
  { id: 'agents-ref-multi-type', kind: 'REFERENCE', targetModelId: 'agents-model-1', isMultiple: true },
  { id: 'issues-ref-type', kind: 'REFERENCE', targetModelId: 'issues-model', isMultiple: false },
];

/** All five Agents rows already in sync, so every role resolves an `agentId` with no prompt writes. */
function unchangedAgentsRowsHandler(promptsDir: string) {
  return () => ({
    status: 200,
    body: (['dev', 'design', 'qa', 'triage', 'pair'] as const).map((role) => ({
      id: `row-${role}`,
      name: { dev: 'Developer', design: 'Design', qa: 'QA', triage: 'Triage', pair: 'Pair' }[role],
      prompt: personaDefaultPrompt(promptsDir, role),
      updated_at: '2026-01-01T00:00:00Z',
    })),
  });
}

test('a workspace with no Agent field yet gets one created, then every seated role is linked', async (t) => {
  const promptsDir = makePromptsDir();
  let fieldCreateBody: unknown;
  const patched: Record<string, unknown> = {};
  const { restore } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records?limit=200': unchangedAgentsRowsHandler(promptsDir),
    'GET /api/data-models/crew-model': () => ({ status: 200, body: CREW_MODEL_NO_FIELD }),
    'GET /api/workspaces/ws-1/field-types': () => ({ status: 200, body: FIELD_TYPES }),
    'POST /api/data-models/crew-model/fields': (body) => { fieldCreateBody = body; return { status: 201, body: { columnName: 'agent_id' } }; },
    'GET /api/data-models/crew-model/records/seat-dev': () => ({ status: 200, body: { id: 'seat-dev' } }),
    'GET /api/data-models/crew-model/records/seat-design': () => ({ status: 200, body: { id: 'seat-design' } }),
    'GET /api/data-models/crew-model/records/seat-qa': () => ({ status: 200, body: { id: 'seat-qa' } }),
    'GET /api/data-models/crew-model/records/seat-triage': () => ({ status: 200, body: { id: 'seat-triage' } }),
    'PATCH /api/data-models/crew-model/records/seat-dev': (body) => { patched['dev'] = body; return { status: 200, body: {} }; },
    'PATCH /api/data-models/crew-model/records/seat-design': (body) => { patched['design'] = body; return { status: 200, body: {} }; },
    'PATCH /api/data-models/crew-model/records/seat-qa': (body) => { patched['qa'] = body; return { status: 200, body: {} }; },
    'PATCH /api/data-models/crew-model/records/seat-triage': (body) => { patched['triage'] = body; return { status: 200, body: {} }; },
  });
  t.after(restore);

  const route = makeRoute(undefined, { dev: 'seat-dev', design: 'seat-design', qa: 'seat-qa', triage: 'seat-triage' }, promptsDir);
  const result = await syncPersonas(route, {});

  assert.deepEqual(fieldCreateBody, {
    name: 'Agent',
    columnName: 'agent_id',
    fieldTypeId: 'agents-ref-type',
    description: "The Agents-table row backing this seat's persona — set by `crew agents sync` (ISSUE-416), never edited by hand.",
  });
  assert.deepEqual(patched, {
    dev: { agent_id: 'row-dev' }, design: { agent_id: 'row-design' }, qa: { agent_id: 'row-qa' }, triage: { agent_id: 'row-triage' },
  });
  // pair has no configured seat, so it resolves 'no_seat' — only the four seated roles link.
  assert.ok(result.crewLinks.filter((o) => o.role !== 'pair').every((o) => o.action === 'linked'));
  assert.equal(result.crewLinks.find((o) => o.role === 'pair')!.action, 'no_seat');
  assert.equal(describeCrewLink(result.crewLinks.find((o) => o.role === 'dev')!), 'Developer: Crew row now references its Agents row');
});

test('an existing Agent field is reused (no field-types lookup, no POST), and an already-correct seat is left alone', async (t) => {
  const promptsDir = makePromptsDir();
  let patchCalled = false;
  const { restore } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records?limit=200': unchangedAgentsRowsHandler(promptsDir),
    'GET /api/data-models/crew-model': () => ({ status: 200, body: CREW_MODEL_WITH_FIELD }),
    'GET /api/data-models/crew-model/records/seat-dev': () => ({ status: 200, body: { id: 'seat-dev', agent_id: 'row-dev' } }),
    'PATCH /api/data-models/crew-model/records/seat-dev': () => { patchCalled = true; return { status: 200, body: {} }; },
  });
  t.after(restore);

  const route = makeRoute(undefined, { dev: 'seat-dev' }, promptsDir);
  const result = await syncPersonas(route, {});

  assert.equal(patchCalled, false);
  const dev = result.crewLinks.find((o) => o.role === 'dev')!;
  assert.equal(dev.action, 'already_linked');
  assert.equal(describeCrewLink(dev), 'Developer: Crew row already references its Agents row');
});

test('roles with no configured seat are reported no_seat and never touch the Crew table', async (t) => {
  const promptsDir = makePromptsDir();
  const { restore } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records?limit=200': unchangedAgentsRowsHandler(promptsDir),
  });
  t.after(restore);

  const route = makeRoute(undefined, {}, promptsDir); // no seats configured at all
  const result = await syncPersonas(route, {});

  assert.equal(result.crewLinks.length, 5);
  assert.ok(result.crewLinks.every((o) => o.action === 'no_seat'));
});

test('a seated role whose persona diverged this pass is reported persona_diverged, not no_seat, and never touches the Crew table', async (t) => {
  const promptsDir = makePromptsDir();
  const { restore } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records?limit=200': () => ({
      status: 200,
      body: [
        { id: 'row-Developer', name: 'Developer', prompt: 'COMMON\nOLD DEV BRIEF\n', updated_at: '2026-01-01T00:00:00Z' },
        { id: 'row-Design', name: 'Design', prompt: personaDefaultPrompt(promptsDir, 'design'), updated_at: '2026-01-01T00:00:00Z' },
        { id: 'row-QA', name: 'QA', prompt: personaDefaultPrompt(promptsDir, 'qa'), updated_at: '2026-01-01T00:00:00Z' },
        { id: 'row-Triage', name: 'Triage', prompt: personaDefaultPrompt(promptsDir, 'triage'), updated_at: '2026-01-01T00:00:00Z' },
        { id: 'row-Pair', name: 'Pair', prompt: personaDefaultPrompt(promptsDir, 'pair'), updated_at: '2026-01-01T00:00:00Z' },
      ],
    }),
  });
  t.after(restore);

  // No cached baseline for dev's row, so it resolves 'diverged' — no
  // agentId for that role — while a seat IS configured for it.
  const route = makeRoute(undefined, { dev: 'seat-dev' }, promptsDir);
  const result = await syncPersonas(route, {});

  const dev = result.outcomes.find((o) => o.role === 'dev')!;
  assert.equal(dev.action, 'diverged');
  const devLink = result.crewLinks.find((o) => o.role === 'dev')!;
  assert.equal(devLink.action, 'persona_diverged');
  assert.equal(
    describeCrewLink(devLink),
    "Developer: persona has local edits and was not synced this pass — skipped linking until it's resolved",
  );
});

test('dry run never touches the Crew table', async (t) => {
  const promptsDir = makePromptsDir();
  const { restore } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records?limit=200': unchangedAgentsRowsHandler(promptsDir),
  });
  t.after(restore);

  const route = makeRoute(undefined, { dev: 'seat-dev' }, promptsDir);
  const result = await syncPersonas(route, { dryRun: true });

  assert.deepEqual(result.crewLinks, []);
});

test('fetchDivergedPrompt returns undefined when a role has never been synced (no cached agentId)', async (t) => {
  const { restore } = mockFetch({});
  t.after(restore);

  const route = makeRoute(undefined, { dev: 'seat-dev' });
  const prompt = await fetchDivergedPrompt(route, 'dev', {});

  assert.equal(prompt, undefined);
});

test('fetchDivergedPrompt returns undefined when the row still matches the local template', async (t) => {
  const promptsDir = makePromptsDir();
  const { restore } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records/row-dev': () => ({
      status: 200,
      body: { id: 'row-dev', name: 'Developer', prompt: personaDefaultPrompt(promptsDir, 'dev'), updated_at: '2026-01-01T00:00:00Z' },
    }),
  });
  t.after(restore);

  const route = makeRoute({ dev: { agentId: 'row-dev', lastSyncedUpdatedAt: '2026-01-01T00:00:00Z' } }, { dev: 'seat-dev' }, promptsDir);
  const prompt = await fetchDivergedPrompt(route, 'dev', {});

  assert.equal(prompt, undefined);
});

test('fetchDivergedPrompt returns the live text when a workspace admin edited the row directly', async (t) => {
  const promptsDir = makePromptsDir();
  const { restore } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records/row-dev': () => ({
      status: 200,
      body: { id: 'row-dev', name: 'Developer', prompt: 'CUSTOM ADMIN PROMPT\n', updated_at: '2026-02-01T00:00:00Z' },
    }),
  });
  t.after(restore);

  const route = makeRoute({ dev: { agentId: 'row-dev', lastSyncedUpdatedAt: '2026-01-01T00:00:00Z' } }, { dev: 'seat-dev' }, promptsDir);
  const prompt = await fetchDivergedPrompt(route, 'dev', {});

  assert.equal(prompt, 'CUSTOM ADMIN PROMPT\n');
});

test('ISSUE-1382: a row crew wrote on an earlier sync, now stale because the local file moved on, does NOT override the local file', async (t) => {
  const promptsDir = makePromptsDir({ common: 'COMMON v2\n' });
  const staleCrewCopy = 'COMMON v1\nLANE-DEV\n';
  const { restore } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records/row-dev': () => ({
      status: 200,
      body: { id: 'row-dev', name: 'Developer', prompt: staleCrewCopy, updated_at: '2026-02-01T00:00:00Z' },
    }),
    // The history entry crew cached at its last write holds the same text the row still has.
    'GET /api/data-models/agents-model-1/records/row-dev/history?limit=50': () => ({
      status: 200,
      body: [{ history_id: 'hist-dev-1', changed_at: '2026-02-01T00:00:00Z', prompt: staleCrewCopy }],
    }),
  });
  t.after(restore);

  const route = makeRoute(
    { dev: { agentId: 'row-dev', lastSyncedUpdatedAt: '2026-02-01T00:00:00Z', historyId: 'hist-dev-1' } },
    { dev: 'seat-dev' },
    promptsDir,
  );
  const prompt = await fetchDivergedPrompt(route, 'dev', {});

  assert.equal(prompt, undefined);
});

test('ISSUE-1382: a row edited after crew\'s last write still overrides the local file', async (t) => {
  const promptsDir = makePromptsDir({ common: 'COMMON v2\n' });
  const { restore } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records/row-dev': () => ({
      status: 200,
      body: { id: 'row-dev', name: 'Developer', prompt: 'ADMIN EDIT\n', updated_at: '2026-03-01T00:00:00Z' },
    }),
    // crew's last write was the stale copy; the admin has since changed it.
    'GET /api/data-models/agents-model-1/records/row-dev/history?limit=50': () => ({
      status: 200,
      body: [{ history_id: 'hist-dev-1', changed_at: '2026-02-01T00:00:00Z', prompt: 'COMMON v1\nLANE-DEV\n' }],
    }),
  });
  t.after(restore);

  const route = makeRoute(
    { dev: { agentId: 'row-dev', lastSyncedUpdatedAt: '2026-02-01T00:00:00Z', historyId: 'hist-dev-1' } },
    { dev: 'seat-dev' },
    promptsDir,
  );
  const prompt = await fetchDivergedPrompt(route, 'dev', {});

  assert.equal(prompt, 'ADMIN EDIT\n');
});

test('fetchDivergedPrompt falls back to undefined rather than throwing when the tracker is unreachable', async (t) => {
  const { restore } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 404, body: { message: 'not found' } }),
  });
  t.after(restore);

  const route = makeRoute({ dev: { agentId: 'row-dev', lastSyncedUpdatedAt: '2026-01-01T00:00:00Z' } }, { dev: 'seat-dev' });
  const prompt = await fetchDivergedPrompt(route, 'dev', {});

  assert.equal(prompt, undefined);
});

test('fetchDivergedPrompt falls back to the seat\'s own Crew.agent_id when no sync has ever cached one (ISSUE-611)', async (t) => {
  const { restore } = mockFetch({
    'GET /api/data-models/crew-model/records/seat-dev': () => ({ status: 200, body: { id: 'seat-dev', agent_id: 'row-dev' } }),
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records/row-dev': () => ({
      status: 200,
      body: { id: 'row-dev', name: 'Developer', prompt: 'LINKED SEAT PROMPT\n', updated_at: '2026-02-01T00:00:00Z' },
    }),
  });
  t.after(restore);

  // No `agentPersonas` cache — `crew connect` provisioned the seat and
  // linked it (ISSUE-610), but `crew agents sync` has never run here.
  const route = makeRoute(undefined, { dev: 'seat-dev' });
  const prompt = await fetchDivergedPrompt(route, 'dev', {});

  assert.equal(prompt, 'LINKED SEAT PROMPT\n');
});

test('fetchDivergedPrompt returns undefined when the seat\'s Crew row has no agent_id yet', async (t) => {
  const { restore } = mockFetch({
    'GET /api/data-models/crew-model/records/seat-dev': () => ({ status: 200, body: { id: 'seat-dev', agent_id: null } }),
  });
  t.after(restore);

  const route = makeRoute(undefined, { dev: 'seat-dev' });
  const prompt = await fetchDivergedPrompt(route, 'dev', {});

  assert.equal(prompt, undefined);
});

test('fetchSeatAgentModel returns undefined when nothing has ever linked this role to an Agent row', async (t) => {
  const { restore } = mockFetch({});
  t.after(restore);

  const route = makeRoute(undefined, {});
  const model = await fetchSeatAgentModel(route, 'dev', {});

  assert.equal(model, undefined);
});

test('fetchSeatAgentModel reads the linked Agent row\'s model via the cached agentId from crew agents sync', async (t) => {
  const { restore } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records/row-dev': () => ({
      status: 200,
      body: { id: 'row-dev', name: 'Developer', prompt: 'X', model: 'claude-opus-5', updated_at: '2026-02-01T00:00:00Z' },
    }),
  });
  t.after(restore);

  const route = makeRoute({ dev: { agentId: 'row-dev', lastSyncedUpdatedAt: '2026-01-01T00:00:00Z' } }, { dev: 'seat-dev' });
  const model = await fetchSeatAgentModel(route, 'dev', {});

  assert.equal(model, 'claude-opus-5');
});

test('fetchSeatAgentModel falls back to the seat\'s own Crew.agent_id, same as fetchDivergedPrompt (ISSUE-611)', async (t) => {
  const { restore } = mockFetch({
    'GET /api/data-models/crew-model/records/seat-dev': () => ({ status: 200, body: { id: 'seat-dev', agent_id: 'row-dev' } }),
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records/row-dev': () => ({
      status: 200,
      body: { id: 'row-dev', name: 'Developer', prompt: 'X', model: 'claude-sonnet-5', updated_at: '2026-02-01T00:00:00Z' },
    }),
  });
  t.after(restore);

  const route = makeRoute(undefined, { dev: 'seat-dev' });
  const model = await fetchSeatAgentModel(route, 'dev', {});

  assert.equal(model, 'claude-sonnet-5');
});

test('fetchSeatAgentModel returns undefined when the linked Agent row has no model set', async (t) => {
  const { restore } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records/row-dev': () => ({
      status: 200,
      body: { id: 'row-dev', name: 'Developer', prompt: 'X', updated_at: '2026-02-01T00:00:00Z' },
    }),
  });
  t.after(restore);

  const route = makeRoute({ dev: { agentId: 'row-dev', lastSyncedUpdatedAt: '2026-01-01T00:00:00Z' } }, { dev: 'seat-dev' });
  const model = await fetchSeatAgentModel(route, 'dev', {});

  assert.equal(model, undefined);
});

test('fetchSeatPersona reads tier and vendor beside model; unknown tiers and blank vendors read as absent (CREW-1515)', async (t) => {
  const row = (extra: Record<string, unknown>) => () => ({
    status: 200,
    body: { id: 'row-dev', name: 'Developer', prompt: 'X', updated_at: '2026-02-01T00:00:00Z', ...extra },
  });
  const route = makeRoute({ dev: { agentId: 'row-dev', lastSyncedUpdatedAt: '2026-01-01T00:00:00Z' } }, { dev: 'seat-dev' });
  const cases: Array<[Record<string, unknown>, unknown]> = [
    [{ model: 'claude-opus-5', tier: 'deep', vendor: 'anthropic' }, { model: 'claude-opus-5', tier: 'deep', vendor: 'anthropic' }],
    [{ tier: 'Light', vendor: null }, { tier: 'light' }],
    [{ tier: 'huge', vendor: '' }, undefined],
    [{ tier: null }, undefined],
  ];
  for (const [fields, want] of cases) {
    const { restore } = mockFetch({
      'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
      'GET /api/data-models/agents-model-1/records/row-dev': row(fields),
    });
    try {
      assert.deepEqual(await fetchSeatPersona(route, 'dev', {}), want);
    } finally {
      restore();
    }
  }
});

test('currentPersonaPrompt falls back to the local default when there is nothing to compare against yet', async (t) => {
  const promptsDir = makePromptsDir({ pair: 'PAIR BRIEF\n' });
  const { restore } = mockFetch({});
  t.after(restore);

  // No cached agentId for 'pair' — `crew agents sync` has never run for this route.
  const route = makeRoute(undefined, {}, promptsDir);
  const prompt = await currentPersonaPrompt(route, 'pair', {});

  assert.equal(prompt, 'PAIR BRIEF\n');
});

test('currentPersonaPrompt returns a workspace admin\'s live edit over the local default', async (t) => {
  const promptsDir = makePromptsDir({ pair: 'PAIR BRIEF\n' });
  const { restore } = mockFetch({
    'GET /api/data-models/agents?workspaceId=ws-1': () => ({ status: 200, body: AGENTS_MODEL }),
    'GET /api/data-models/agents-model-1/records/row-pair': () => ({
      status: 200,
      body: { id: 'row-pair', name: 'Pair', prompt: 'CUSTOM PAIR PROMPT\n', updated_at: '2026-02-01T00:00:00Z' },
    }),
  });
  t.after(restore);

  const route = makeRoute(
    { pair: { agentId: 'row-pair', lastSyncedUpdatedAt: '2026-01-01T00:00:00Z' } } as any,
    {},
    promptsDir,
  );
  const prompt = await currentPersonaPrompt(route, 'pair', {});

  assert.equal(prompt, 'CUSTOM PAIR PROMPT\n');
});

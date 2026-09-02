import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncSkills, parseSkillFile, describeSkillSyncOutcome, SkillSyncError } from '../src/skills.ts';
import type { Route } from '../src/config.ts';

/** A minimal prompts directory with just the skills/ files skills.ts reads — what Route.promptsDir points at. */
function makePromptsDir(skills: Record<string, { name: string; description: string; prompt: string }> = {}): string {
  const prompts = mkdtempSync(join(tmpdir(), 'crew-skills-'));
  const dir = join(prompts, 'skills');
  mkdirSync(dir, { recursive: true });
  for (const [file, s] of Object.entries(skills)) {
    writeFileSync(join(dir, file), `---\nname: ${s.name}\ndescription: ${s.description}\n---\n${s.prompt}`);
  }
  return prompts;
}

function makeRoute(
  agentSkills?: Record<string, { skillId: string; lastSyncedUpdatedAt: string }>,
  promptsDir: string = makePromptsDir({ 'grill-me.md': { name: 'Grill-Me', description: 'Interview an Epic.', prompt: 'BODY\n' } }),
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
      seats: {},
      operator: 'operator-id',
      holds: [],
      agentSkills,
    },
  } as unknown as Route;
}

/** Routes fetch calls by `${method} ${pathname}${search}` to a handler; unmatched calls fail loudly instead of 404ing silently. */
function mockFetch(handlers: Record<string, (body: unknown) => { status: number; body: unknown }>) {
  const original = globalThis.fetch;
  const calls: Array<{ key: string; body: unknown }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const key = `${method} ${url.pathname}${url.search}`;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ key, body });
    const handler = handlers[key];
    if (!handler) throw new Error(`unmocked request: ${key}`);
    const { status, body: respBody } = handler(body);
    return new Response(JSON.stringify(respBody), { status });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, calls };
}

const SKILLS_MODEL = { id: 'skills-model-1', workspaceId: 'ws-1', name: 'Agent Skills', tableName: 'agent_skills' };

test('parseSkillFile splits frontmatter from the prompt body', () => {
  const dir = makePromptsDir({ 'grill-me.md': { name: 'Grill-Me', description: 'desc', prompt: 'BODY LINE\n' } });
  const parsed = parseSkillFile(join(dir, 'skills', 'grill-me.md'));
  assert.deepEqual(parsed, {
    name: 'Grill-Me', description: 'desc', prompt: 'BODY LINE\n', file: join(dir, 'skills', 'grill-me.md'),
  });
});

test('parseSkillFile throws SkillSyncError with no frontmatter block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-skills-empty-'));
  writeFileSync(join(dir, 'bare.md'), 'no frontmatter here\n');
  assert.throws(() => parseSkillFile(join(dir, 'bare.md')), SkillSyncError);
});

test('parseSkillFile throws when name or description is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-skills-partial-'));
  writeFileSync(join(dir, 'partial.md'), '---\nname: Only-Name\n---\nBODY\n');
  assert.throws(() => parseSkillFile(join(dir, 'partial.md')), SkillSyncError);
});

test('a workspace with no Agent Skills table yet fails with a clear message, not a raw 404', async (t) => {
  const { restore } = mockFetch({
    'GET /api/data-models/agent_skills?workspaceId=ws-1': () => ({ status: 404, body: { message: 'not found' } }),
  });
  t.after(restore);
  await assert.rejects(
    syncSkills(makeRoute(), {}),
    (e: unknown) => e instanceof SkillSyncError && /Agent Skills table/.test((e as Error).message),
  );
});

test('a missing skill is created, named and prompted from the local file', async (t) => {
  const promptsDir = makePromptsDir({ 'grill-me.md': { name: 'Grill-Me', description: 'Interview an Epic.', prompt: 'BODY\n' } });
  const created: Array<{ name: string; description: string; prompt: string }> = [];
  const { restore, calls } = mockFetch({
    'GET /api/data-models/agent_skills?workspaceId=ws-1': () => ({ status: 200, body: SKILLS_MODEL }),
    'GET /api/data-models/skills-model-1/records?limit=200': () => ({ status: 200, body: [] }),
    'POST /api/data-models/skills-model-1/records': (body: any) => {
      created.push(body);
      return { status: 200, body: { id: 'row-grill-me', name: body.name, description: body.description, prompt: body.prompt, updated_at: '2026-08-28T00:00:00Z' } };
    },
  });
  t.after(restore);

  const result = await syncSkills(makeRoute(undefined, promptsDir), {});

  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0]!.action, 'created');
  assert.deepEqual(created[0], { name: 'Grill-Me', description: 'Interview an Epic.', prompt: 'BODY\n' });
  assert.equal(result.agentSkills['Grill-Me']?.skillId, 'row-grill-me');
  assert.equal(calls.filter((c) => c.key.startsWith('PATCH')).length, 0);
});

test('dry run reports what it would create but performs no POST', async (t) => {
  const { restore, calls } = mockFetch({
    'GET /api/data-models/agent_skills?workspaceId=ws-1': () => ({ status: 200, body: SKILLS_MODEL }),
    'GET /api/data-models/skills-model-1/records?limit=200': () => ({ status: 200, body: [] }),
  });
  t.after(restore);
  const result = await syncSkills(makeRoute(), { dryRun: true });
  assert.equal(result.outcomes[0]!.action, 'created');
  assert.equal(calls.filter((c) => c.key.startsWith('POST')).length, 0);
});

test('a row whose content already matches the local file is left alone and just re-anchors the cache', async (t) => {
  const promptsDir = makePromptsDir({ 'grill-me.md': { name: 'Grill-Me', description: 'Interview an Epic.', prompt: 'BODY\n' } });
  const { restore, calls } = mockFetch({
    'GET /api/data-models/agent_skills?workspaceId=ws-1': () => ({ status: 200, body: SKILLS_MODEL }),
    'GET /api/data-models/skills-model-1/records?limit=200': () => ({
      status: 200,
      body: [{ id: 'row-grill-me', name: 'Grill-Me', description: 'Interview an Epic.', prompt: 'BODY\n', updated_at: '2026-01-01T00:00:00Z' }],
    }),
  });
  t.after(restore);

  const result = await syncSkills(makeRoute(undefined, promptsDir), {});
  assert.equal(result.outcomes[0]!.action, 'unchanged');
  assert.equal(result.agentSkills['Grill-Me']?.lastSyncedUpdatedAt, '2026-01-01T00:00:00Z');
  assert.equal(calls.filter((c) => c.key.startsWith('PATCH')).length, 0);
});

test('a differing row with no cached baseline is reported diverged and never overwritten', async (t) => {
  const promptsDir = makePromptsDir({ 'grill-me.md': { name: 'Grill-Me', description: 'Interview an Epic.', prompt: 'NEW BODY\n' } });
  const { restore, calls } = mockFetch({
    'GET /api/data-models/agent_skills?workspaceId=ws-1': () => ({ status: 200, body: SKILLS_MODEL }),
    'GET /api/data-models/skills-model-1/records?limit=200': () => ({
      status: 200,
      body: [{ id: 'row-grill-me', name: 'Grill-Me', description: 'someone typed this directly into the app', prompt: 'EDITED BODY\n', updated_at: '2026-01-01T00:00:00Z' }],
    }),
  });
  t.after(restore);

  const result = await syncSkills(makeRoute(undefined, promptsDir), {}); // no agentSkills cache passed in
  assert.equal(result.outcomes[0]!.action, 'diverged');
  assert.equal(calls.filter((c) => c.key.startsWith('PATCH')).length, 0);
  assert.match(describeSkillSyncOutcome(result.outcomes[0]!), /HAS LOCAL EDITS/);
});

test('a row matching crew\'s own last-synced updated_at is pushed forward when the local file has changed since', async (t) => {
  const promptsDir = makePromptsDir({ 'grill-me.md': { name: 'Grill-Me', description: 'Interview an Epic.', prompt: 'NEW BODY\n' } });
  let patchedBody: unknown;
  const { restore } = mockFetch({
    'GET /api/data-models/agent_skills?workspaceId=ws-1': () => ({ status: 200, body: SKILLS_MODEL }),
    'GET /api/data-models/skills-model-1/records?limit=200': () => ({
      status: 200,
      body: [{ id: 'row-grill-me', name: 'Grill-Me', description: 'Interview an Epic.', prompt: 'OLD BODY\n', updated_at: '2026-01-01T00:00:00Z' }],
    }),
    'PATCH /api/data-models/skills-model-1/records/row-grill-me': (body) => {
      patchedBody = body;
      return { status: 200, body: { id: 'row-grill-me', name: 'Grill-Me', description: (body as any).description, prompt: (body as any).prompt, updated_at: '2026-01-02T00:00:00Z' } };
    },
  });
  t.after(restore);

  const route = makeRoute({ 'Grill-Me': { skillId: 'row-grill-me', lastSyncedUpdatedAt: '2026-01-01T00:00:00Z' } }, promptsDir);
  const result = await syncSkills(route, {});
  assert.equal(result.outcomes[0]!.action, 'updated');
  assert.deepEqual(patchedBody, { description: 'Interview an Epic.', prompt: 'NEW BODY\n' });
  assert.equal(result.agentSkills['Grill-Me']?.lastSyncedUpdatedAt, '2026-01-02T00:00:00Z');
});

test('a stale-write 409 (someone edited between the list and the patch) is reported diverged, not thrown', async (t) => {
  const promptsDir = makePromptsDir({ 'grill-me.md': { name: 'Grill-Me', description: 'Interview an Epic.', prompt: 'NEW BODY\n' } });
  const { restore } = mockFetch({
    'GET /api/data-models/agent_skills?workspaceId=ws-1': () => ({ status: 200, body: SKILLS_MODEL }),
    'GET /api/data-models/skills-model-1/records?limit=200': () => ({
      status: 200,
      body: [{ id: 'row-grill-me', name: 'Grill-Me', description: 'Interview an Epic.', prompt: 'OLD BODY\n', updated_at: '2026-01-01T00:00:00Z' }],
    }),
    'PATCH /api/data-models/skills-model-1/records/row-grill-me': () => ({ status: 409, body: { message: 'stale' } }),
  });
  t.after(restore);

  const route = makeRoute({ 'Grill-Me': { skillId: 'row-grill-me', lastSyncedUpdatedAt: '2026-01-01T00:00:00Z' } }, promptsDir);
  const result = await syncSkills(route, {});
  assert.equal(result.outcomes[0]!.action, 'diverged');
  // The cache stays untouched — the caller must not persist a "synced" state that never happened.
  assert.equal(result.agentSkills['Grill-Me']?.lastSyncedUpdatedAt, '2026-01-01T00:00:00Z');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover, listWorkspaces, renderConnection, type Discovered } from '../src/connect.ts';

/** Wires a fetch mock keyed by exact pathname+query, ignoring host/baseUrl. */
function mockFetch(routes: Record<string, unknown>) {
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${url.pathname}${url.search}`;
    seen.push(key);
    if (!(key in routes)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = originalFetch; }, seen };
}

const BASE = { baseUrl: 'https://example.test', apiKey: 'k', userAgent: 'crew-test' };

test('discover() resolves the workspace by slug, not by echoing the input as its id', async (t) => {
  const { restore } = mockFetch({
    '/api/workspaces/issues': { id: 'ws-uuid-1', name: 'Issue Tracker' },
    '/api/auth/me?workspaceId=ws-uuid-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/bar?workspaceId=ws-uuid-1': { id: 'proj-1', name: 'Bar' },
    '/api/data-models?projectId=proj-1': [
      { id: 'issues-model', name: 'Issues' },
      { id: 'comments-model', name: 'Comments' },
      { id: 'crew-model', name: 'Crew' },
    ],
    '/api/data-models/crew-model/records?limit=200': [],
  });
  t.after(restore);

  const found = await discover({ ...BASE, workspace: 'issues', project: 'bar' });
  assert.equal(found.workspaceId, 'ws-uuid-1');
  assert.equal(found.workspaceName, 'Issue Tracker');
  assert.equal(found.projectId, 'proj-1');
});

test('a project name (not a slug) still resolves, falling back to a case-insensitive list match', async (t) => {
  const { restore } = mockFetch({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_USER' },
    // The slug-shaped lookup 404s (route absent from this mock's table) —
    // "Issues" is a display name, not a slug.
    '/api/projects?workspaceId=ws-1': [{ id: 'proj-9', name: 'Issues' }],
    '/api/data-models?projectId=proj-9': [{ id: 'i', name: 'Issues' }],
    '/api/data-models/undefined/records?limit=200': [],
  });
  t.after(restore);

  const found = await discover({ ...BASE, workspace: 'issues', project: 'Issues' });
  assert.equal(found.projectId, 'proj-9');
  assert.equal(found.projectName, 'Issues');
});

test('no project given, exactly one qualifies: it is picked without asking', async (t) => {
  const { restore } = mockFetch({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_USER' },
    '/api/projects?workspaceId=ws-1': [
      { id: 'p-issues', name: 'Issues', slug: 'issues-proj' },
      { id: 'p-marketing', name: 'Marketing', slug: 'marketing' },
    ],
    '/api/data-models?projectId=p-issues': [
      { id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'm', name: 'Crew' },
    ],
    '/api/data-models?projectId=p-marketing': [{ id: 'pages', name: 'Pages' }],
    '/api/data-models/m/records?limit=200': [],
  });
  t.after(restore);

  const found = await discover({ ...BASE, workspace: 'issues' });
  assert.equal(found.projectId, 'p-issues');
  assert.equal(found.projectOptions, undefined);
  assert.ok(!found.problems.some((p) => p.includes('qualif')), 'no ambiguity/qualification problem expected');
});

test('no project given, more than one qualifies: refused as an ambiguity, not guessed', async (t) => {
  const { restore } = mockFetch({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_USER' },
    '/api/projects?workspaceId=ws-1': [
      { id: 'p-a', name: 'Team A', slug: 'team-a' },
      { id: 'p-b', name: 'Team B', slug: 'team-b' },
    ],
    '/api/data-models?projectId=p-a': [{ id: 'i', name: 'Issues' }],
    '/api/data-models?projectId=p-b': [{ id: 'i', name: 'Issues' }],
  });
  t.after(restore);

  const found = await discover({ ...BASE, workspace: 'issues' });
  assert.equal(found.projectId, undefined);
  assert.equal(found.projectOptions?.length, 2);
  assert.ok(found.problems.some((p) => p.includes('team-a') && p.includes('team-b')));
});

test('no project qualifies: an admin is told they can install a template', async (t) => {
  const { restore } = mockFetch({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects?workspaceId=ws-1': [{ id: 'p-a', name: 'Marketing' }],
    '/api/data-models?projectId=p-a': [{ id: 'pages', name: 'Pages' }],
  });
  t.after(restore);

  const found = await discover({ ...BASE, workspace: 'issues' });
  assert.equal(found.projectId, undefined);
  assert.ok(found.problems.some((p) => /install an Issues-tracker template/.test(p)));
});

test('no project qualifies: a plain member is told to ask an admin, not offered install', async (t) => {
  const { restore } = mockFetch({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_USER' },
    '/api/projects?workspaceId=ws-1': [{ id: 'p-a', name: 'Marketing' }],
    '/api/data-models?projectId=p-a': [{ id: 'pages', name: 'Pages' }],
  });
  t.after(restore);

  const found = await discover({ ...BASE, workspace: 'issues' });
  assert.ok(found.problems.some((p) => /ask a workspace admin/.test(p)));
  assert.ok(!found.problems.some((p) => /install an Issues-tracker template/.test(p)));
});

test('discover() carries the resolved workspace and project slugs, not just their display names', async (t) => {
  const { restore } = mockFetch({
    '/api/workspaces/issues': { id: 'ws-uuid-1', slug: 'issues', name: 'Issue Tracker' },
    '/api/auth/me?workspaceId=ws-uuid-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/bar?workspaceId=ws-uuid-1': { id: 'proj-1', slug: 'bar', name: 'Bar' },
    '/api/data-models?projectId=proj-1': [
      { id: 'issues-model', name: 'Issues' },
      { id: 'comments-model', name: 'Comments' },
      { id: 'crew-model', name: 'Crew' },
    ],
    '/api/data-models/crew-model/records?limit=200': [],
  });
  t.after(restore);

  const found = await discover({ ...BASE, workspace: 'issues', project: 'bar' });
  assert.equal(found.workspaceSlug, 'issues');
  assert.equal(found.projectSlug, 'bar');
});

test('discover() auto-matches operator to the hold whose email matches this key\'s own identity', async (t) => {
  const { restore } = mockFetch({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN', email: 'brad@example.test' },
    '/api/projects/bar?workspaceId=ws-1': { id: 'proj-1', name: 'Bar' },
    '/api/data-models?projectId=proj-1': [
      { id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'crew-model', name: 'Crew' },
    ],
    '/api/data-models/crew-model/records?limit=200': [
      { id: 'seat-dev', name: 'Developer' },
      { id: 'hold-pair', name: 'Pair agent', email: 'pair@example.test' },
      { id: 'hold-brad', name: 'Brad C.', email: 'brad@example.test' },
    ],
  });
  t.after(restore);

  const found = await discover({ ...BASE, workspace: 'issues', project: 'bar' });
  assert.equal(found.operator, 'hold-brad');
});

test('discover() leaves operator unset when no hold email matches (or two do)', async (t) => {
  const { restore } = mockFetch({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN', email: 'nobody@example.test' },
    '/api/projects/bar?workspaceId=ws-1': { id: 'proj-1', name: 'Bar' },
    '/api/data-models?projectId=proj-1': [
      { id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'crew-model', name: 'Crew' },
    ],
    '/api/data-models/crew-model/records?limit=200': [
      { id: 'hold-pair', name: 'Pair agent', email: 'pair@example.test' },
      { id: 'hold-brad', name: 'Brad C.', email: 'brad@example.test' },
    ],
  });
  t.after(restore);

  const found = await discover({ ...BASE, workspace: 'issues', project: 'bar' });
  assert.equal(found.operator, undefined);
  assert.equal(found.holds.length, 2);
});

test('listWorkspaces() reads /auth/my-workspaces, not the admin-only /workspaces list', async (t) => {
  const { restore, seen } = mockFetch({
    '/api/auth/my-workspaces': {
      workspaces: [
        { slug: 'issues', name: 'Issue Tracker', role: 'WORKSPACE_ADMIN' },
        { slug: 'paradium', name: 'Paradium', role: 'WORKSPACE_USER' },
      ],
      totalCount: 2,
    },
  });
  t.after(restore);

  const found = await listWorkspaces(BASE);
  assert.deepEqual(found, [
    { slug: 'issues', name: 'Issue Tracker', role: 'WORKSPACE_ADMIN' },
    { slug: 'paradium', name: 'Paradium', role: 'WORKSPACE_USER' },
  ]);
  assert.deepEqual(seen, ['/api/auth/my-workspaces']);
});

test('renderConnection() no longer prints a resolved: block — those ids go to the state file', () => {
  const d: Discovered = {
    workspaceId: 'ws-1', workspaceSlug: 'issues', workspaceName: 'Issue Tracker',
    projectId: 'p-1', projectSlug: 'issues', projectName: 'Issues',
    models: { issues: 'i', comments: 'c', crew: 'm' }, seats: {}, holds: [], problems: [],
  };
  const block = renderConnection(d, 'issues/issues', '/tmp/synthesis');
  assert.ok(!block.includes('resolved:'));
  assert.ok(block.includes('route: issues/issues'));
});

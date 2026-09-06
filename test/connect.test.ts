import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  discover, listWorkspaces, renderConnection, type Discovered,
  listLibraryTemplates, previewTemplateInstall, installTemplate,
} from '../src/connect.ts';

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
  assert.equal(found.offerTemplateInstall, true);
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
  assert.equal(found.offerTemplateInstall, false);
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
  // "Pair agent" is claimed as the pair seat, not left as a hold — see the
  // dedicated pair-matching test below.
  assert.equal(found.holds.length, 1);
});

test('discover() best-effort-matches a "pair" Crew row into seats.pair, and drops it from holds', async (t) => {
  const { restore } = mockFetch({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/bar?workspaceId=ws-1': { id: 'proj-1', name: 'Bar' },
    '/api/data-models?projectId=proj-1': [
      { id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'crew-model', name: 'Crew' },
    ],
    '/api/data-models/crew-model/records?limit=200': [
      { id: 'hold-pair', name: 'Pair agent' },
      { id: 'hold-brad', name: 'Brad C.' },
    ],
  });
  t.after(restore);

  const found = await discover({ ...BASE, workspace: 'issues', project: 'bar' });
  assert.equal(found.seats.pair, 'hold-pair');
  assert.deepEqual(found.holds.map((h) => h.id), ['hold-brad']);
});

test('discover() reports no problem when no "pair" Crew row exists — it is optional, unlike the four polled seats', async (t) => {
  const { restore } = mockFetch({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/bar?workspaceId=ws-1': { id: 'proj-1', name: 'Bar' },
    '/api/data-models?projectId=proj-1': [
      { id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'crew-model', name: 'Crew' },
    ],
    '/api/data-models/crew-model/records?limit=200': [
      { id: 'hold-brad', name: 'Brad C.' },
    ],
  });
  t.after(restore);

  const found = await discover({ ...BASE, workspace: 'issues', project: 'bar' });
  assert.equal(found.seats.pair, undefined);
  assert.ok(!found.problems.some((p) => p.includes('pair')));
});

test('discover() flags a status CHOICE value the default contract does not name (ISSUE-467)', async (t) => {
  const { restore } = mockFetch({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/bar?workspaceId=ws-1': { id: 'proj-1', name: 'Bar' },
    '/api/data-models?projectId=proj-1': [
      { id: 'issues-model', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'crew-model', name: 'Crew' },
    ],
    '/api/data-models/crew-model/records?limit=200': [],
    '/api/data-models/issues-model': {
      fields: [
        {
          columnName: 'status',
          fieldType: {
            choiceOptions: [
              { value: 'new', label: 'New', position: 0 },
              { value: 'accepted', label: 'Approved', position: 1 },
              { value: 'closed_escalated', label: 'Escalated', position: 2 },
              { value: 'draft', label: 'Draft', position: 3 },
            ],
          },
        },
      ],
    },
  });
  t.after(restore);

  const found = await discover({ ...BASE, workspace: 'issues', project: 'bar' });
  assert.deepEqual(
    found.unrecognizedStatuses,
    [{ value: 'closed_escalated', label: 'Escalated', position: 2 }, { value: 'draft', label: 'Draft', position: 3 }],
  );
});

test('discover() reports no unrecognized statuses when every value matches DEFAULT_CONTRACT', async (t) => {
  const { restore } = mockFetch({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/bar?workspaceId=ws-1': { id: 'proj-1', name: 'Bar' },
    '/api/data-models?projectId=proj-1': [
      { id: 'issues-model', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'crew-model', name: 'Crew' },
    ],
    '/api/data-models/crew-model/records?limit=200': [],
    '/api/data-models/issues-model': {
      fields: [
        { columnName: 'status', fieldType: { choiceOptions: [{ value: 'new', position: 0 }, { value: 'verified', position: 1 }] } },
      ],
    },
  });
  t.after(restore);

  const found = await discover({ ...BASE, workspace: 'issues', project: 'bar' });
  assert.deepEqual(found.unrecognizedStatuses, []);
});

test('discover() leaves unrecognizedStatuses undefined rather than failing the whole connect when the Issues model cannot be read', async (t) => {
  const { restore } = mockFetch({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/bar?workspaceId=ws-1': { id: 'proj-1', name: 'Bar' },
    '/api/data-models?projectId=proj-1': [
      { id: 'issues-model', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'crew-model', name: 'Crew' },
    ],
    '/api/data-models/crew-model/records?limit=200': [],
    // No '/api/data-models/issues-model' route registered — mockFetch 404s it.
  });
  t.after(restore);

  const found = await discover({ ...BASE, workspace: 'issues', project: 'bar' });
  assert.equal(found.unrecognizedStatuses, undefined);
  assert.equal(found.projectId, 'proj-1');
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

test('listLibraryTemplates() returns the published templates as-is', async (t) => {
  const { restore } = mockFetch({
    '/api/library-templates': [{ id: 'tpl-1', name: 'Issues' }],
  });
  t.after(restore);

  const templates = await listLibraryTemplates(BASE);
  assert.deepEqual(templates, [{ id: 'tpl-1', name: 'Issues' }]);
});

test('previewTemplateInstall() reads the diff for the given template/workspace pair', async (t) => {
  const { restore } = mockFetch({
    '/api/library-templates/tpl-1/install-preview?workspaceId=ws-1': {
      hasUnresolvedConflicts: true,
      dataModels: { conflicts: [{ name: 'Issues', tableName: 'issues' }] },
      fieldTypes: { conflicts: [] },
    },
  });
  t.after(restore);

  const preview = await previewTemplateInstall(BASE, 'tpl-1', 'ws-1');
  assert.equal(preview.hasUnresolvedConflicts, true);
  assert.equal(preview.dataModels.conflicts[0]?.name, 'Issues');
});

test('installTemplate() POSTs workspaceId (and projectName when given) and returns the new project', async (t) => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response(JSON.stringify({ project: { id: 'p-new', slug: 'issues-2', name: 'Issues' } }), { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const installed = await installTemplate(BASE, 'tpl-1', 'ws-1', 'Issues');
  assert.deepEqual(installed, { project: { id: 'p-new', slug: 'issues-2', name: 'Issues' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, 'POST');
  assert.ok(calls[0]!.url.endsWith('/api/library-templates/tpl-1/install'));
  assert.deepEqual(calls[0]!.body, { workspaceId: 'ws-1', projectName: 'Issues' });
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

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

/**
 * Same idea as `mockFetch`, but also records the method and (parsed) body of
 * every call, and lets a route's response depend on the method — POST
 * `.../records` (create) and GET `.../records?limit=200` (list) share a
 * pathname but never a query string, so a plain `mockFetch` route table
 * already disambiguates them; this is only for tests that need to assert
 * *what* got written, not just that a lookup happened.
 */
function mockFetchCalls(routes: Record<string, unknown>) {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ method: string; key: string; body: unknown }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${url.pathname}${url.search}`;
    const method = init?.method ?? 'GET';
    calls.push({ method, key, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (!(key in routes)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = originalFetch; }, calls };
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

test('no project given: a project installed from crew.issues is picked by source-template identifier, even if renamed/reslugged, with no ambiguity prompt even when another project also qualifies', async (t) => {
  const { restore } = mockFetch({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_USER' },
    '/api/projects?workspaceId=ws-1': [
      { id: 'p-tracker', name: 'Our Tracker', slug: 'our-tracker', sourceTemplateId: 'crew.issues' },
      { id: 'p-other', name: 'Other Issues-Shaped Project', slug: 'other', sourceTemplateId: null },
    ],
    '/api/data-models?projectId=p-tracker': [
      { id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'm', name: 'Crew' },
    ],
    '/api/data-models?projectId=p-other': [{ id: 'i', name: 'Issues' }],
    '/api/data-models/m/records?limit=200': [],
  });
  t.after(restore);

  const found = await discover({ ...BASE, workspace: 'issues' });
  assert.equal(found.projectId, 'p-tracker');
  assert.equal(found.projectOptions, undefined);
});

test('no project given: falls back to slug `issues` when no project carries the source-template identifier', async (t) => {
  const { restore } = mockFetch({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_USER' },
    '/api/projects?workspaceId=ws-1': [
      { id: 'p-issues', name: 'Issues', slug: 'issues' },
      { id: 'p-other', name: 'Other', slug: 'other' },
    ],
    '/api/data-models?projectId=p-issues': [
      { id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'm', name: 'Crew' },
    ],
    '/api/data-models/m/records?limit=200': [],
  });
  t.after(restore);

  const found = await discover({ ...BASE, workspace: 'issues' });
  assert.equal(found.projectId, 'p-issues');
});

test('no project given: a slug-`issues` project missing required tables falls through to the ordinary qualifying-project search, not a hard failure', async (t) => {
  const { restore } = mockFetch({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_USER' },
    '/api/projects?workspaceId=ws-1': [
      { id: 'p-issues', name: 'Issues', slug: 'issues' },
      { id: 'p-real', name: 'Real Tracker', slug: 'real-tracker' },
    ],
    '/api/data-models?projectId=p-issues': [{ id: 'pages', name: 'Pages' }],
    '/api/data-models?projectId=p-real': [
      { id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'm', name: 'Crew' },
    ],
    '/api/data-models/m/records?limit=200': [],
  });
  t.after(restore);

  const found = await discover({ ...BASE, workspace: 'issues' });
  assert.equal(found.projectId, 'p-real');
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

test('discover() with no `ship` given never provisions — same workspace-wide, unscoped search as before (ISSUE-610)', async (t) => {
  const { restore, calls } = mockFetchCalls({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/bar?workspaceId=ws-1': { id: 'proj-1', name: 'Bar' },
    '/api/data-models?projectId=proj-1': [
      { id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'crew-model', name: 'Crew' },
      { id: 'ships-model', name: 'Ships' },
    ],
    '/api/data-models/crew-model/records?limit=200': [{ id: 'seat-dev', name: 'Developer agent' }],
  });
  t.after(restore);

  const found = await discover({ ...BASE, workspace: 'issues', project: 'bar' });
  assert.equal(found.seats.dev, 'seat-dev');
  assert.deepEqual(found.provisioning, []);
  assert.ok(!calls.some((c) => c.method === 'POST' || c.method === 'PATCH'), 'no writes without `ship`');
});

test('discover() creates the Ships row when this ship has no row yet, and reports it in provisioning (ISSUE-610)', async (t) => {
  const { restore, calls } = mockFetchCalls({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/bar?workspaceId=ws-1': { id: 'proj-1', name: 'Bar' },
    '/api/data-models?projectId=proj-1': [
      { id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'crew-model', name: 'Crew' },
      { id: 'ships-model', name: 'Ships' },
    ],
    '/api/data-models/ships-model/records?limit=200': [],
    '/api/data-models/ships-model/records': { id: 'ship-new' },
    '/api/data-models/crew-model/records?limit=200': [
      { id: 'seat-dev', name: 'Developer agent', ship_id: 'ship-new' },
      { id: 'seat-design', name: 'Design agent', ship_id: 'ship-new' },
      { id: 'seat-qa', name: 'QA agent', ship_id: 'ship-new' },
      { id: 'seat-triage', name: 'Triage agent', ship_id: 'ship-new' },
    ],
  });
  t.after(restore);

  const found = await discover({
    ...BASE, workspace: 'issues', project: 'bar', ship: { name: "Brad's MacBook", platform: 'macos' },
  });
  assert.equal(found.seats.dev, 'seat-dev');
  assert.ok(found.provisioning.some((p) => p.includes('created Ships row')));
  const createShip = calls.find((c) => c.method === 'POST' && c.key === '/api/data-models/ships-model/records');
  assert.deepEqual(createShip?.body, { name: "Brad's MacBook", platform: 'macos', host_passengers: false });
});

test('discover() stamps host_passengers on a newly-created Ships row when this route\'s config says true (ISSUE-644)', async (t) => {
  const { restore, calls } = mockFetchCalls({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/bar?workspaceId=ws-1': { id: 'proj-1', name: 'Bar' },
    '/api/data-models?projectId=proj-1': [
      { id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'crew-model', name: 'Crew' },
      { id: 'ships-model', name: 'Ships' },
    ],
    '/api/data-models/ships-model/records?limit=200': [],
    '/api/data-models/ships-model/records': { id: 'ship-new' },
    '/api/data-models/crew-model/records?limit=200': [],
    '/api/data-models/crew-model/records': { id: 'seat-new' },
  });
  t.after(restore);

  await discover({
    ...BASE, workspace: 'issues', project: 'bar',
    ship: { name: "Brad's MacBook", platform: 'macos', hostPassengers: true },
  });
  const createShip = calls.find((c) => c.method === 'POST' && c.key === '/api/data-models/ships-model/records');
  assert.deepEqual(createShip?.body, { name: "Brad's MacBook", platform: 'macos', host_passengers: true });
});

test('discover() PATCHes host_passengers onto an existing Ships row when it disagrees with this route\'s config (ISSUE-644)', async (t) => {
  const { restore, calls } = mockFetchCalls({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/bar?workspaceId=ws-1': { id: 'proj-1', name: 'Bar' },
    '/api/data-models?projectId=proj-1': [
      { id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'crew-model', name: 'Crew' },
      { id: 'ships-model', name: 'Ships' },
    ],
    '/api/data-models/ships-model/records?limit=200': [
      { id: 'ship-1', name: "Brad's MacBook", host_passengers: false },
    ],
    '/api/data-models/ships-model/records/ship-1': { id: 'ship-1' },
    '/api/data-models/crew-model/records?limit=200': [],
    '/api/data-models/crew-model/records': { id: 'seat-new' },
  });
  t.after(restore);

  const found = await discover({
    ...BASE, workspace: 'issues', project: 'bar',
    ship: { name: "Brad's MacBook", hostPassengers: true },
  });
  assert.ok(found.provisioning.some((p) => p.includes('synced host_passengers=true')));
  const patchShip = calls.find((c) => c.method === 'PATCH' && c.key === '/api/data-models/ships-model/records/ship-1');
  assert.deepEqual(patchShip?.body, { host_passengers: true });
});

test('discover() leaves an existing Ships row alone when host_passengers already matches this route\'s config (ISSUE-644)', async (t) => {
  const { restore, calls } = mockFetchCalls({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/bar?workspaceId=ws-1': { id: 'proj-1', name: 'Bar' },
    '/api/data-models?projectId=proj-1': [
      { id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'crew-model', name: 'Crew' },
      { id: 'ships-model', name: 'Ships' },
    ],
    '/api/data-models/ships-model/records?limit=200': [
      { id: 'ship-1', name: "Brad's MacBook", host_passengers: true },
    ],
    '/api/data-models/crew-model/records?limit=200': [],
    '/api/data-models/crew-model/records': { id: 'seat-new' },
  });
  t.after(restore);

  const found = await discover({
    ...BASE, workspace: 'issues', project: 'bar',
    ship: { name: "Brad's MacBook", hostPassengers: true },
  });
  assert.ok(!found.provisioning.some((p) => p.includes('host_passengers')));
  assert.ok(!calls.some((c) => c.method === 'PATCH' && c.key.includes('/ships-model/records/')));
});

test('discover() PATCHes ssh_public_key onto an existing Ships row when it disagrees with what this ship holds (ISSUE-553)', async (t) => {
  const { restore, calls } = mockFetchCalls({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/bar?workspaceId=ws-1': { id: 'proj-1', name: 'Bar' },
    '/api/data-models?projectId=proj-1': [
      { id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'crew-model', name: 'Crew' },
      { id: 'ships-model', name: 'Ships' },
    ],
    '/api/data-models/ships-model/records?limit=200': [
      { id: 'ship-1', name: "Brad's MacBook", ssh_public_key: 'ssh-ed25519 OLD crew-ship' },
    ],
    '/api/data-models/ships-model/records/ship-1': { id: 'ship-1' },
    '/api/data-models/crew-model/records?limit=200': [],
    '/api/data-models/crew-model/records': { id: 'seat-new' },
  });
  t.after(restore);

  const found = await discover({
    ...BASE, workspace: 'issues', project: 'bar',
    ship: { name: "Brad's MacBook", sshPublicKey: 'ssh-ed25519 NEW crew-ship' },
  });
  assert.ok(found.provisioning.some((p) => p.includes('synced ssh_public_key')));
  const patchShip = calls.find((c) => c.method === 'PATCH' && c.key === '/api/data-models/ships-model/records/ship-1');
  assert.deepEqual(patchShip?.body, { ssh_public_key: 'ssh-ed25519 NEW crew-ship' });
});

test('discover() leaves ssh_public_key alone when this ship offers none (e.g. ssh-keygen unavailable) — never clobbers a working key with nothing (ISSUE-553)', async (t) => {
  const { restore, calls } = mockFetchCalls({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/bar?workspaceId=ws-1': { id: 'proj-1', name: 'Bar' },
    '/api/data-models?projectId=proj-1': [
      { id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'crew-model', name: 'Crew' },
      { id: 'ships-model', name: 'Ships' },
    ],
    '/api/data-models/ships-model/records?limit=200': [
      { id: 'ship-1', name: "Brad's MacBook", ssh_public_key: 'ssh-ed25519 EXISTING crew-ship' },
    ],
    '/api/data-models/crew-model/records?limit=200': [],
    '/api/data-models/crew-model/records': { id: 'seat-new' },
  });
  t.after(restore);

  const found = await discover({
    ...BASE, workspace: 'issues', project: 'bar',
    ship: { name: "Brad's MacBook" },
  });
  assert.ok(!found.provisioning.some((p) => p.includes('ssh_public_key')));
  assert.ok(!calls.some((c) => c.method === 'PATCH' && c.key.includes('/ships-model/records/')));
});

test('discover() claims a pre-existing, unscoped Crew row for this ship rather than creating a duplicate (ISSUE-610)', async (t) => {
  const { restore, calls } = mockFetchCalls({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/bar?workspaceId=ws-1': { id: 'proj-1', name: 'Bar' },
    '/api/data-models?projectId=proj-1': [
      { id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'crew-model', name: 'Crew' },
      { id: 'ships-model', name: 'Ships' },
    ],
    '/api/data-models/ships-model/records?limit=200': [{ id: 'ship-1', name: "Brad's MacBook" }],
    '/api/data-models/crew-model/records?limit=200': [
      // No ship_id — this is the single-machine-era row the ticket's own
      // framing describes; claiming it (not duplicating it) is the point.
      { id: 'seat-dev', name: 'Developer agent' },
      { id: 'hold-brad', name: 'Brad C.' },
    ],
    '/api/data-models/crew-model/records/seat-dev': { id: 'seat-dev', ship_id: 'ship-1' },
    // design/qa/triage have no row at all in this fixture — each gets
    // created fresh, same as the dedicated "creates a new row" test below.
    '/api/data-models/crew-model/records': { id: 'seat-new' },
  });
  t.after(restore);

  const found = await discover({
    ...BASE, workspace: 'issues', project: 'bar', ship: { name: "Brad's MacBook" },
  });
  assert.equal(found.seats.dev, 'seat-dev');
  assert.ok(found.provisioning.some((p) => p.includes('claimed existing Crew row for the dev seat')));
  const claim = calls.find((c) => c.method === 'PATCH' && c.key === '/api/data-models/crew-model/records/seat-dev');
  assert.deepEqual(claim?.body, { ship_id: 'ship-1' });
  // design/qa/triage have no row at all in this fixture (only "dev" was
  // seeded) — created fresh rather than left unresolved, same as the
  // dedicated "creates a new row" test.
  assert.ok(found.provisioning.some((p) => p === 'created Crew row for the design seat'));
});

test('discover() creates a new, ship-scoped Crew row for a lane with no row at all, linked to its Agents-table persona (ISSUE-610)', async (t) => {
  const { restore, calls } = mockFetchCalls({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/bar?workspaceId=ws-1': { id: 'proj-1', name: 'Bar' },
    '/api/data-models?projectId=proj-1': [
      { id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'crew-model', name: 'Crew' },
      { id: 'ships-model', name: 'Ships' },
    ],
    '/api/data-models/ships-model/records?limit=200': [{ id: 'ship-1', name: "Brad's MacBook" }],
    '/api/data-models/agents?workspaceId=ws-1': { id: 'agents-model' },
    '/api/data-models/agents-model/records?limit=200': [{ id: 'agent-dev', name: 'Developer' }],
    '/api/data-models/crew-model/records?limit=200': [],
    '/api/data-models/crew-model/records': { id: 'seat-dev-new' },
  });
  t.after(restore);

  const found = await discover({
    ...BASE, workspace: 'issues', project: 'bar', ship: { name: "Brad's MacBook" },
  });
  assert.equal(found.seats.dev, 'seat-dev-new');
  assert.ok(found.provisioning.some((p) => p === 'created Crew row for the dev seat'));
  const createCrew = calls.find((c) => c.method === 'POST' && c.key === '/api/data-models/crew-model/records');
  assert.deepEqual(createCrew?.body, { name: 'Developer agent', ship_id: 'ship-1', agent_id: 'agent-dev' });
});

test('discover() skips all provisioning on a dry run — writes nothing, falls back to the unscoped search (ISSUE-610)', async (t) => {
  const { restore, calls } = mockFetchCalls({
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/bar?workspaceId=ws-1': { id: 'proj-1', name: 'Bar' },
    '/api/data-models?projectId=proj-1': [
      { id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'crew-model', name: 'Crew' },
      { id: 'ships-model', name: 'Ships' },
    ],
    '/api/data-models/crew-model/records?limit=200': [{ id: 'seat-dev', name: 'Developer agent' }],
  });
  t.after(restore);

  const found = await discover({
    ...BASE, workspace: 'issues', project: 'bar', ship: { name: "Brad's MacBook" }, dryRun: true,
  });
  assert.equal(found.seats.dev, 'seat-dev');
  assert.deepEqual(found.provisioning, []);
  assert.ok(!calls.some((c) => c.method === 'POST' || c.method === 'PATCH'), 'dry run writes nothing');
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
    '/api/library-templates': [{ id: 'tpl-1', name: 'Issues', identifier: 'crew.issues' }],
  });
  t.after(restore);

  const templates = await listLibraryTemplates(BASE);
  assert.deepEqual(templates, [{ id: 'tpl-1', name: 'Issues', identifier: 'crew.issues' }]);
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
    models: { issues: 'i', comments: 'c', crew: 'm' }, seats: {}, holds: [], problems: [], provisioning: [],
  };
  const block = renderConnection(d, 'issues/issues', '/tmp/synthesis');
  assert.ok(!block.includes('resolved:'));
  assert.ok(block.includes('route: issues/issues'));
});

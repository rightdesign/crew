import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tracker } from '../src/tracker.ts';
import type { Route } from '../src/config.ts';

function makeRoute(opts: { shipsModelId?: string; reposModelId?: string; areaModelId?: string } = {}): Route {
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
      models: { issues: 'issues-model-id', comments: 'comments-model-id', crew: 'crew-model-id' },
      seats: {},
      operator: 'operator-id',
      holds: [],
      shipsModelId: opts.shipsModelId,
      reposModelId: opts.reposModelId,
      areaModelId: opts.areaModelId,
    },
  } as unknown as Route;
}

test('terminalTickets() sorts by updatedAt descending, so a truncated page still holds the most-recently-closed tickets', async (t) => {
  const requests: URL[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    requests.push(new URL(input instanceof Request ? input.url : String(input)));
    return new Response(JSON.stringify([]), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const tracker = new Tracker(makeRoute(), { userAgent: 'crew-test' });
  await tracker.terminalTickets();

  assert.equal(requests.length, 1);
  const sortParam = requests[0]!.searchParams.get('sort');
  assert.ok(sortParam, 'expected a sort query param on the terminalTickets() request');
  assert.deepEqual(JSON.parse(sortParam), [{ columnName: 'updated_at', direction: 'desc' }]);
});

test('setCrewStatus(working, ticketId) patches status, the ticket reference, and a timestamp', async (t) => {
  const bodies: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    bodies.push({ url: input instanceof Request ? input.url : String(input), body: init?.body ? JSON.parse(init.body as string) : undefined });
    return new Response(JSON.stringify({ id: 'member-1' }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const tracker = new Tracker(makeRoute(), { userAgent: 'crew-test' });
  await tracker.setCrewStatus('member-1', 'working', 'ticket-uuid-1');

  assert.equal(bodies.length, 1);
  assert.ok(bodies[0]!.url.includes('crew-model-id/records/member-1'));
  const body = bodies[0]!.body as Record<string, unknown>;
  assert.equal(body.status, 'working');
  assert.equal(body.current_issue_id, 'ticket-uuid-1');
  assert.ok(typeof body.status_updated_at === 'string' && body.status_updated_at.length > 0);
});

test('setCrewStatus(idle) with no ticket id leaves current_issue_id untouched — it reads as "last worked", not cleared', async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    bodies.push(init?.body ? JSON.parse(init.body as string) : {});
    return new Response(JSON.stringify({ id: 'member-1' }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const tracker = new Tracker(makeRoute(), { userAgent: 'crew-test' });
  await tracker.setCrewStatus('member-1', 'idle');

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.status, 'idle');
  assert.equal('current_issue_id' in bodies[0]!, false);
});

test('beatShip() is a no-op when the workspace has no Ships table', async (t) => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify([]), { status: 200 }); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const tracker = new Tracker(makeRoute(), { userAgent: 'crew-test' });
  await tracker.beatShip("Brad's Mac");

  assert.equal(calls, 0, 'no Ships table means nothing to list or patch');
});

test('beatShip() is a no-op when no row (or more than one) matches this ship\'s name', async (t) => {
  const originalFetch = globalThis.fetch;
  let patched = false;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.method === 'PATCH' || url.includes('/records/')) patched = true;
    return new Response(JSON.stringify([{ id: 'ship-1', name: 'Someone Else\'s Mac' }]), { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const tracker = new Tracker(makeRoute({ shipsModelId: 'ships-model-id' }), { userAgent: 'crew-test' });
  await tracker.beatShip("Brad's Mac");

  assert.equal(patched, false, 'an unmatched ship name must not write to a row that isn\'t this ship\'s');
});

test('beatShip() patches last_seen/host/pid on this ship\'s own row, leaving engaged fields alone', async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.body) bodies.push(JSON.parse(init.body as string));
    if (url.includes('/records/ship-1')) return new Response(JSON.stringify({ id: 'ship-1' }), { status: 200 });
    return new Response(JSON.stringify([{ id: 'ship-1', name: "Brad's Mac" }]), { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const tracker = new Tracker(makeRoute({ shipsModelId: 'ships-model-id' }), { userAgent: 'crew-test' });
  await tracker.beatShip("Brad's Mac");

  assert.equal(bodies.length, 1);
  assert.ok(typeof bodies[0]!.last_seen === 'string' && bodies[0]!.last_seen);
  assert.ok(typeof bodies[0]!.host === 'string' && bodies[0]!.host);
  assert.equal(bodies[0]!.pid, process.pid);
  assert.equal('engaged' in bodies[0]!, false, 'a plain heartbeat must not touch engagement state');
});

test('beatEngaged() marks the ship engaged, naming the route, ticket and since-when', async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.body) bodies.push(JSON.parse(init.body as string));
    if (url.includes('/records/ship-1')) return new Response(JSON.stringify({ id: 'ship-1' }), { status: 200 });
    return new Response(JSON.stringify([{ id: 'ship-1', name: "Brad's Mac" }]), { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const tracker = new Tracker(makeRoute({ shipsModelId: 'ships-model-id' }), { userAgent: 'crew-test' });
  await tracker.beatEngaged("Brad's Mac", 'synthesis', 'ticket-uuid-1');

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.engaged, true);
  assert.equal(bodies[0]!.engaged_connection, 'synthesis');
  assert.equal(bodies[0]!.engaged_ticket_id, 'ticket-uuid-1');
  assert.ok(typeof bodies[0]!.engaged_since === 'string' && bodies[0]!.engaged_since);
});

test('beatIdle() clears engagement back to idle', async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.body) bodies.push(JSON.parse(init.body as string));
    if (url.includes('/records/ship-1')) return new Response(JSON.stringify({ id: 'ship-1' }), { status: 200 });
    return new Response(JSON.stringify([{ id: 'ship-1', name: "Brad's Mac" }]), { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const tracker = new Tracker(makeRoute({ shipsModelId: 'ships-model-id' }), { userAgent: 'crew-test' });
  await tracker.beatIdle("Brad's Mac");

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.engaged, false);
  assert.equal(bodies[0]!.engaged_since, null);
  assert.equal(bodies[0]!.engaged_connection, null);
  assert.equal(bodies[0]!.engaged_ticket_id, null);
});

test('repoRow() is undefined when the workspace has no Repos table', async (t) => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls++; return new Response('{}', { status: 200 }); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const tracker = new Tracker(makeRoute(), { userAgent: 'crew-test' });
  assert.equal(await tracker.repoRow('repo-1'), undefined);
  assert.equal(calls, 0);
});

test('repoRow() returns the row, project_id included', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: 'repo-1', project_id: 'proj-1' }), { status: 200 })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const tracker = new Tracker(makeRoute({ reposModelId: 'repos-model-id' }), { userAgent: 'crew-test' });
  assert.deepEqual(await tracker.repoRow('repo-1'), { id: 'repo-1', project_id: 'proj-1' });
});

test('repoRow() is undefined, not thrown, when the row is gone', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const tracker = new Tracker(makeRoute({ reposModelId: 'repos-model-id' }), { userAgent: 'crew-test' });
  assert.equal(await tracker.repoRow('repo-1'), undefined);
});

test('projectRow() is undefined when the workspace has no Projects table', async (t) => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls++; return new Response('{}', { status: 200 }); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const tracker = new Tracker(makeRoute(), { userAgent: 'crew-test' });
  assert.equal(await tracker.projectRow('proj-1'), undefined);
  assert.equal(calls, 0);
});

test('projectRow() returns the row, issue_prefix included', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: 'proj-1', issue_prefix: 'CREW' }), { status: 200 })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const tracker = new Tracker(makeRoute({ areaModelId: 'projects-model-id' }), { userAgent: 'crew-test' });
  assert.deepEqual(await tracker.projectRow('proj-1'), { id: 'proj-1', issue_prefix: 'CREW' });
});

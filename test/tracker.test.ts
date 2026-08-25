import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tracker } from '../src/tracker.ts';
import type { Connection } from '../src/config.ts';

function makeConnection(): Connection {
  return {
    name: 'test',
    enabled: true,
    workspace: 'issues',
    dir: '/tmp/does-not-matter',
    repos: {},
    platform: 'any',
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
    },
  } as unknown as Connection;
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

  const tracker = new Tracker(makeConnection(), { userAgent: 'crew-test' });
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

  const tracker = new Tracker(makeConnection(), { userAgent: 'crew-test' });
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

  const tracker = new Tracker(makeConnection(), { userAgent: 'crew-test' });
  await tracker.setCrewStatus('member-1', 'idle');

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.status, 'idle');
  assert.equal('current_issue_id' in bodies[0]!, false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionStore, StoredSession } from '@tablation/client';
import type { Route } from '../src/config.ts';
import { seatKeySlug } from '../src/seat-keys.ts';
import { isForbiddenError, probeIssuesRead, probeSeatReads, seatForbiddenItem, SEAT_NO_READ_REMEDY } from '../src/seat-read-probe.ts';

delete process.env.CREW_API_KEY;

function route(): Route {
  return {
    route: 'issues/crew',
    baseUrl: 'https://example.test',
    apiKey: 'ship-key',
    resolved: {
      workspaceId: 'ws-1',
      models: { issues: 'issues-model', comments: 'c', crew: 'cr' },
      seats: { dev: 'crew-dev', qa: 'crew-qa' },
      agentPersonas: { dev: { agentId: 'agent-dev', lastSyncedUpdatedAt: 'x' }, qa: { agentId: 'agent-qa', lastSyncedUpdatedAt: 'x' } },
    },
  } as unknown as Route;
}

function store(): SessionStore {
  const data = new Map<string, StoredSession>();
  data.set('example.test/' + seatKeySlug('issues', 'agent-dev'), { apiKey: 'sk_dev' } as StoredSession);
  return { get: async (h, s) => data.get(`${h}/${s}`), set: async () => {}, clear: async () => {} };
}

test('probeIssuesRead maps 200 ok, 403 forbidden, 500 unknown, and hits the Issues records URL', async () => {
  const urls: string[] = [];
  const mk = (status: number) => async (u: string | URL | Request) => { urls.push(String(u)); return new Response('{}', { status }); };
  assert.equal((await probeIssuesRead(route(), 'k', { fetchImpl: mk(200) as typeof fetch })).state, 'ok');
  assert.equal((await probeIssuesRead(route(), 'k', { fetchImpl: mk(403) as typeof fetch })).state, 'forbidden');
  const u = await probeIssuesRead(route(), 'k', { fetchImpl: mk(500) as typeof fetch });
  assert.equal(u.state, 'unknown');
  assert.equal(urls[0], 'https://example.test/api/workspaces/ws-1/data-models/issues-model/records?limit=1');
  assert.equal((await probeIssuesRead(route(), 'k', { fetchImpl: (async () => { throw new Error('down'); }) as typeof fetch })).state, 'unknown');
});

test('probeSeatReads probes only seats with their own agent key', async () => {
  const keys: string[] = [];
  const r = await probeSeatReads(route(), {
    getStore: store,
    fetchImpl: (async (_u: string, init: RequestInit) => { keys.push((init.headers as Record<string, string>).Authorization!); return new Response('{}', { status: 403 }); }) as unknown as typeof fetch,
  });
  assert.deepEqual(r, [{ role: 'dev', state: 'forbidden' }]);
  assert.deepEqual(keys, ['Bearer sk_dev']);
});

test('isForbiddenError recognises the client status and the message form', () => {
  assert.ok(isForbiddenError(Object.assign(new Error('x'), { status: 403 })));
  assert.ok(isForbiddenError(new Error('GET /data-models/x/records -> 403: No READ access to this model')));
  assert.ok(!isForbiddenError(new Error('HTTP 500')));
});

test('seatForbiddenItem carries the remedy under a stable key', () => {
  const i = seatForbiddenItem();
  assert.equal(i.kind, 'seat_forbidden');
  assert.ok(i.message.includes(SEAT_NO_READ_REMEDY));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionStore, StoredSession } from '@tablation/client';
import type { Route } from '../src/config.ts';
import { seatKeySlug } from '../src/seat-keys.ts';
import { forbiddenDetail, remedyFor, describeSeatTables, isForbiddenError, probeIssuesRead, probeSeatReads, seatForbiddenItem, SEAT_NO_READ_REMEDY } from '../src/seat-read-probe.ts';

delete process.env.CREW_API_KEY;

function route(): Route {
  return {
    route: 'issues/crew',
    baseUrl: 'https://example.test',
    apiKey: 'ship-key',
    resolved: {
      workspaceId: 'ws-1',
      shipsModelId: 'ships-model',
      locksModelId: 'locks-model',
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
  assert.equal(urls[0], 'https://example.test/api/data-models/issues-model/records?limit=1');
  assert.equal((await probeIssuesRead(route(), 'k', { fetchImpl: (async () => { throw new Error('down'); }) as typeof fetch })).state, 'unknown');
});

test('probeSeatReads probes only seats with their own agent key', async () => {
  const keys: string[] = [];
  const r = await probeSeatReads(route(), {
    getStore: store,
    fetchImpl: (async (_u: string, init: RequestInit) => { keys.push((init.headers as Record<string, string>).Authorization!); return new Response('{}', { status: 403 }); }) as unknown as typeof fetch,
  });
  assert.equal(r.length, 1);
  assert.equal(r[0]!.role, 'dev');
  assert.equal(r[0]!.state, 'forbidden');
  assert.deepEqual(r[0]!.tables.map((t) => `${t.table}:${t.state}`), ['Issues:forbidden', 'Comments:forbidden', 'Crew:forbidden', 'Ships:forbidden']);
  assert.deepEqual(keys, Array(4).fill('Bearer sk_dev'));
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

const SHIPS_403 = new Error('PATCH /data-models/ships-model/records/r1 -> 403: No WRITE access to this model');

test('forbiddenDetail extracts method, table and verb from the client error', () => {
  const d = forbiddenDetail(new Error('PATCH /data-models/crew-model/records/r1 -> 403: No WRITE access to this model'), { resolved: { models: { issues: 'i', comments: 'c', crew: 'crew-model' } } } as unknown as Route);
  assert.deepEqual(d, { method: 'PATCH', path: '/data-models/crew-model/records/r1', table: 'Crew', verb: 'WRITE' });
});

test('a WRITE refusal on Ships names Ships, PATCH and the grant, not the re-mint text', () => {
  const i = seatForbiddenItem(new Date(), SHIPS_403, route());
  assert.ok(i.message.includes('PATCH'));
  assert.ok(i.message.includes('PATCH Ships -> 403 No WRITE access'));
  assert.ok(i.message.includes('grant WRITE on Ships'));
  assert.ok(!i.message.includes('ships-model'));
  assert.ok(!i.message.includes('re-mint'));
});

test('READ refusal on Issues keeps the project-role remedy; other tables get a grant remedy', () => {
  assert.equal(remedyFor({ table: 'Issues', verb: 'READ' }), SEAT_NO_READ_REMEDY);
  assert.equal(remedyFor({ table: 'Comments', verb: 'READ' }), 'grant READ on Comments to the agent role');
  const i = seatForbiddenItem(new Date(), new Error('GET /data-models/issues-model/records -> 403: No READ access to this model'), route());
  assert.ok(i.message.includes('re-mint'));
});

test('describeSeatTables lists each probed table', () => {
  assert.equal(
    describeSeatTables('dev', [{ table: 'Issues', state: 'ok' }, { table: 'Crew', state: 'forbidden' }, { table: 'Comments', state: 'unknown', detail: 'HTTP 500' }]),
    'seat read:        dev: Issues ok, Crew 403, Comments error (HTTP 500)',
  );
});

test('forbiddenDetail names Locks from the route and falls back to the id for an unknown table', () => {
  assert.equal(forbiddenDetail(new Error('PATCH /data-models/locks-model/records/r -> 403: No WRITE access to this model'), route()).table, 'Locks');
  assert.equal(forbiddenDetail(new Error('PATCH /data-models/zzz/records/r -> 403: No WRITE access to this model'), route()).table, 'table zzz');
});

test('probeSeatReads probes Ships when the route has a Ships table', async () => {
  const urls: string[] = [];
  const res = await probeSeatReads(route(), { getStore: store, fetchImpl: (async (u: string) => { urls.push(u); return new Response('[]', { status: u.includes('ships-model') ? 403 : 200 }); }) as unknown as typeof fetch });
  assert.ok(urls.some((u) => u.includes('/api/data-models/ships-model/records')));
  assert.deepEqual(res[0]?.tables.find((t) => t.table === 'Ships')?.state, 'forbidden');
});

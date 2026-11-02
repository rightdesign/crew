import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionStore, StoredSession } from '@tablation/client';
import type { Route } from '../src/config.ts';
import { seatKeySlug } from '../src/seat-keys.ts';
import { HandoffTranscriptTracker } from '../src/handoff-transcript.ts';
import { clear, upsert } from '../src/ship-attention.ts';
import {
  refusedIssueFields, probeSeatWrites, seatWriteStillRefused, seatCannotWriteItem, seatCannotWriteKey, seatCannotWriteMessage,
} from '../src/seat-read-probe.ts';

delete process.env.CREW_API_KEY;

function route(): Route {
  return {
    route: 'issues/crew', baseUrl: 'https://example.test', apiKey: 'ship-key',
    resolved: {
      workspaceId: 'ws-1', shipsModelId: 'ships-model', locksModelId: 'locks-model',
      models: { issues: 'issues-model', comments: 'c', crew: 'crew-model' },
      seats: { dev: 'crew-dev' },
      agentPersonas: { dev: { agentId: 'agent-dev', lastSyncedUpdatedAt: 'x' } },
    },
  } as unknown as Route;
}
function store(): SessionStore {
  const data = new Map<string, StoredSession>();
  data.set('example.test/' + seatKeySlug('issues', 'agent-dev'), { apiKey: 'sk_dev' } as StoredSession);
  return { get: async (h, s) => data.get(`${h}/${s}`), set: async () => {}, clear: async () => {} };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
/** Answers `/field-access` with `issues` and `/access` with `other`. */
const fetcher = (issues: Record<string, string>, other: string): typeof fetch =>
  (async (u: string) => (String(u).endsWith('/field-access') ? json({ fields: issues }) : json({ access: other }))) as unknown as typeof fetch;

test('refusedIssueFields names hand-off columns below WRITE and ignores absent ones', () => {
  assert.deepEqual(refusedIssueFields({ fields: { status: 'READ', assignee_id: 'WRITE', title: 'READ', commit_sha: 'NONE' } }), ['status', 'commit_sha']);
  assert.deepEqual(refusedIssueFields({ fields: { status: 'DELETE' } }), []);
  assert.deepEqual(refusedIssueFields(null), []);
});

test('a seat role with READ on status is forbidden and named; WRITE passes', async () => {
  const bad = await probeSeatWrites(route(), { getStore: store, fetchImpl: fetcher({ status: 'READ', assignee_id: 'READ' }, 'WRITE') });
  assert.equal(bad.length, 1);
  assert.equal(bad[0]!.state, 'forbidden');
  assert.equal(seatCannotWriteMessage('dev', bad[0]!.tables), 'dev agent key cannot write Issues (status, assignee_id)');
  const good = await probeSeatWrites(route(), { getStore: store, fetchImpl: fetcher({ status: 'WRITE' }, 'WRITE') });
  assert.equal(good[0]!.state, 'ok');
});

test('READ on Crew or Ships is a refusal naming the table; a 5xx is undecided', async () => {
  const r = await probeSeatWrites(route(), { getStore: store, fetchImpl: fetcher({ status: 'WRITE' }, 'READ') });
  assert.match(seatCannotWriteMessage('dev', r[0]!.tables), /Crew, Ships, Locks/);
  const u = await probeSeatWrites(route(), { getStore: store, fetchImpl: (async () => new Response('x', { status: 500 })) as unknown as typeof fetch });
  assert.equal(u[0]!.state, 'unknown');
});

test('seatWriteStillRefused: held while refused or undecided, released once WRITE', async () => {
  assert.equal(await seatWriteStillRefused(route(), 'dev', { getStore: store, fetchImpl: fetcher({ status: 'READ' }, 'WRITE') }), true);
  assert.equal(await seatWriteStillRefused(route(), 'dev', { getStore: store, fetchImpl: (async () => { throw new Error('down'); }) as unknown as typeof fetch }), true);
  assert.equal(await seatWriteStillRefused(route(), 'dev', { getStore: store, fetchImpl: fetcher({ status: 'WRITE' }, 'WRITE') }), false);
});

test('attention item lifecycle: one item per role, kept since, cleared by key', () => {
  const a = seatCannotWriteItem('dev', 'No WRITE access to "status"', '2026-11-02T00:00:00Z');
  assert.equal(a.key, seatCannotWriteKey('dev'));
  assert.equal(a.kind, 'seat_cannot_write');
  const again = upsert([a], seatCannotWriteItem('dev', 'other', '2026-11-02T01:00:00Z'));
  assert.equal(again.length, 1);
  assert.equal(again[0]!.since, '2026-11-02T00:00:00Z');
  assert.deepEqual(clear(again, seatCannotWriteKey('dev')), []);
});

const use = (id: string, input: unknown) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__tablation__records_controller_update', input }] } });
const res = (id: string, content: string, is_error = true) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content }] } });
const patch = { recordId: 'r1', body: { status: 'fixed' } };

test('transcript: a 403 on the status write is forbidden, not pending, and a later success clears it', () => {
  const t = new HandoffTranscriptTracker();
  for (const l of [use('a', patch), res('a', 'PATCH /records/r1 -> 403: No WRITE access to "status"')]) t.feed(l);
  assert.deepEqual(t.forbidden(), { ticketRecordId: 'r1', detail: 'No WRITE access to "status"' });
  assert.equal(t.pending(), null);
  assert.equal(t.handoffLanded(), false);
  for (const l of [use('b', patch), res('b', '{"id":"r1"}', false)]) t.feed(l);
  assert.equal(t.forbidden(), null);
  assert.equal(t.handoffLanded(), true);
});

test('transcript: a 502 is not forbidden', () => {
  const t = new HandoffTranscriptTracker();
  for (const l of [use('a', patch), res('a', 'HTTP 502 Bad Gateway')]) t.feed(l);
  assert.equal(t.forbidden(), null);
});

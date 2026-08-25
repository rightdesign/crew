import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StaleWriteError } from '@tablation/client';
import { acquireBoardLock, type LockRecordsClient } from '../src/board-lock.ts';

const MODEL = 'locks-model';
// `board-lock.ts` judges staleness against the real wall clock, so "fresh"
// fixtures must be relative to it too, not a fixed date in the past.
const NOW = new Date().toISOString();
const TTL = 20 * 60 * 1000;

/** A single Locks row, CAS-checked the way the real API does. */
let writeCounter = 0;

interface FakeRow { id: string; scope: string; holder?: string | null; updated_at: string }

/** No row for any scope — the "table exists but nothing provisioned" and "no table at all" cases both look like this to `acquireBoardLock`. */
function emptyClient(): LockRecordsClient {
  return {
    list: async () => [],
    update: async () => { throw new Error('no such record'); },
  };
}

function fakeClient(row: FakeRow) {
  const calls: Array<{ recordId: string; body: Record<string, unknown>; expectedUpdatedAt?: string }> = [];
  const client: LockRecordsClient = {
    async list(_modelId, params) {
      const filters = JSON.parse(params?.filters ?? '[]');
      const wantScope = filters[0]?.value;
      return row.scope === wantScope ? [row] : [];
    },
    async update(_modelId, recordId, body, expectedUpdatedAt) {
      calls.push({ recordId, body, expectedUpdatedAt });
      if (row.id !== recordId) throw new Error('no such record');
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== row.updated_at) {
        throw new StaleWriteError({ conflict: true });
      }
      row.holder = body.holder as string;
      // A distinct, still-valid timestamp per write, the same way a real
      // `updated_at` changes on every write — reusing NOW here would let a
      // second, stale writer's `expectedUpdatedAt` (captured before the
      // first write landed) match by coincidence instead of genuinely
      // reading the new value.
      row.updated_at = new Date(Date.now() + (++writeCounter)).toISOString();
      return { ...row };
    },
  };
  return { client, calls, row };
}

test('no Locks table configured — treated as free, release is a no-op', async () => {
  const got = await acquireBoardLock(emptyClient(), undefined, 'synthesis/crew', 'shipA:1', TTL);
  assert.equal(got.ok, true);
  if (got.ok) await got.release();   // must not throw
});

test('scope has no provisioned row — treated as free', async () => {
  const got = await acquireBoardLock(emptyClient(), MODEL, 'synthesis/crew', 'shipA:1', TTL);
  assert.equal(got.ok, true);
});

test('a free row (empty holder) is claimed via CAS', async () => {
  const { client, calls, row } = fakeClient({ id: 'r1', scope: 'synthesis/crew', holder: '', updated_at: NOW });
  const got = await acquireBoardLock(client, MODEL, 'synthesis/crew', 'shipA:1', TTL);
  assert.equal(got.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.expectedUpdatedAt, NOW);
  assert.equal(row.holder, 'shipA:1');
});

test('a fresh claim by another ship is reported as held, not raced', async () => {
  const { client, calls } = fakeClient({ id: 'r1', scope: 'synthesis/crew', holder: 'shipB:2', updated_at: NOW });
  const got = await acquireBoardLock(client, MODEL, 'synthesis/crew', 'shipA:1', TTL);
  assert.equal(got.ok, false);
  if (!got.ok) {
    assert.equal(got.reason, 'held');
    assert.equal(got.heldBy, 'shipB:2');
  }
  assert.equal(calls.length, 0);   // never even attempted the write
});

test('the same ship reclaiming its own live claim succeeds (a re-run after a crash before release)', async () => {
  const { client, row } = fakeClient({ id: 'r1', scope: 'synthesis/crew', holder: 'shipA:1', updated_at: NOW });
  const got = await acquireBoardLock(client, MODEL, 'synthesis/crew', 'shipA:1', TTL);
  assert.equal(got.ok, true);
  assert.equal(row.holder, 'shipA:1');
});

test('a claim older than the TTL is stale and another ship may take it over', async () => {
  const staleAt = new Date(Date.now() - TTL - 1000).toISOString();
  const { client, row } = fakeClient({ id: 'r1', scope: 'synthesis/crew', holder: 'shipB:2', updated_at: staleAt });
  const got = await acquireBoardLock(client, MODEL, 'synthesis/crew', 'shipA:1', TTL);
  assert.equal(got.ok, true);
  assert.equal(row.holder, 'shipA:1');
});

test('two ships racing the same free row — the loser sees a conflict, not a double claim', async () => {
  const { client, row } = fakeClient({ id: 'r1', scope: 'synthesis/crew', holder: '', updated_at: NOW });
  const first = await acquireBoardLock(client, MODEL, 'synthesis/crew', 'shipA:1', TTL);
  assert.equal(first.ok, true);
  // shipB reads the row before shipA's write lands — same stale `updated_at`.
  const stubbornClient: LockRecordsClient = {
    list: async () => [{ ...row, holder: '', updated_at: NOW }],
    update: client.update,
  };
  const second = await acquireBoardLock(stubbornClient, MODEL, 'synthesis/crew', 'shipB:2', TTL);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, 'contended');
  assert.equal(row.holder, 'shipA:1');   // shipA's claim stands
});

test('release clears the holder via its own CAS', async () => {
  const { client, row } = fakeClient({ id: 'r1', scope: 'synthesis/crew', holder: '', updated_at: NOW });
  const got = await acquireBoardLock(client, MODEL, 'synthesis/crew', 'shipA:1', TTL);
  assert.equal(got.ok, true);
  if (got.ok) await got.release();
  assert.equal(row.holder, '');
});

test('a release that fails (row deleted, network) does not throw — a stale claim just outlives its TTL', async () => {
  const { client, row } = fakeClient({ id: 'r1', scope: 'synthesis/crew', holder: '', updated_at: NOW });
  const got = await acquireBoardLock(client, MODEL, 'synthesis/crew', 'shipA:1', TTL);
  assert.equal(got.ok, true);
  row.id = 'gone';   // simulate the row vanishing before release
  if (got.ok) await assert.doesNotReject(got.release());
});

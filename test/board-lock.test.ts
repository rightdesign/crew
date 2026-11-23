import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StaleWriteError } from '@tablation/client';
import {
  acquireBoardLock, acquireOrCreateBoardLock, ensureLockRows, lockRowState, type LockRecordsClient, type LockProvisionClient,
} from '../src/board-lock.ts';

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
  if (got.ok) assert.equal(got.exclusion, 'off');   // callers log this (CREW-1399)
  if (got.ok) await got.release();   // must not throw
});

test('scope has no row in an existing Locks table — an error, not a silent downgrade (CREW-1384)', async () => {
  const got = await acquireBoardLock(emptyClient(), MODEL, 'synthesis/crew', 'shipA:1', TTL);
  assert.equal(got.ok, false);
  if (!got.ok) assert.equal(got.reason, 'missing');
});

/** An in-memory Locks table; `onCreate` lets a test interleave another ship's create. */
function fakeTable(rows: Array<{ id: string; scope: string; holder?: string; created_at: string; updated_at: string }>) {
  let n = 0;
  const table: LockProvisionClient & { rows: typeof rows; onCreate?: () => void } = {
    rows,
    async list(_m, params) {
      const want = JSON.parse(params?.filters ?? '[]')[0]?.value;
      return table.rows.filter((r) => r.scope === want).slice(0, params?.limit ?? 100);
    },
    async create(_m, body) {
      const row = {
        id: `new-${++n}`, scope: String(body.scope), holder: String(body.holder ?? ''),
        created_at: new Date(Date.now() + n).toISOString(), updated_at: NOW,
      };
      table.rows.push(row);
      table.onCreate?.();
      return row;
    },
    async remove(_m, id) { table.rows = table.rows.filter((r) => r.id !== id); },
  };
  return table;
}

test('ensureLockRows creates a missing row once and leaves an existing one alone (CREW-1384)', async () => {
  const t = fakeTable([{ id: 'old', scope: 'ws/proj/a', holder: 'shipB:9', created_at: NOW, updated_at: NOW }]);
  const made = await ensureLockRows(t, MODEL, ['ws/proj/a', 'ws/proj/b']);
  assert.deepEqual(made, ['ws/proj/b']);
  assert.equal(t.rows.filter((r) => r.scope === 'ws/proj/a').length, 1);
  assert.equal(t.rows.find((r) => r.scope === 'ws/proj/a')?.holder, 'shipB:9', 'a held row is never touched');
  assert.deepEqual(await ensureLockRows(t, MODEL, ['ws/proj/a', 'ws/proj/b']), [], 'idempotent');
  assert.equal(t.rows.length, 2);
});

test('ensureLockRows: two ships creating at once leave exactly one row, and only the earliest keeps it (CREW-1384)', async () => {
  const t = fakeTable([]);
  // The other ship's row lands between our existence check and our create, and is older.
  t.onCreate = () => {
    t.onCreate = undefined;
    t.rows.unshift({ id: 'rival', scope: 'ws/proj/a', holder: '', created_at: '2000-01-01T00:00:00.000Z', updated_at: NOW });
  };
  const made = await ensureLockRows(t, MODEL, ['ws/proj/a']);
  assert.deepEqual(made, [], 'the loser did not create the surviving row');
  assert.deepEqual(t.rows.map((r) => r.id), ['rival']);
});

test('lockRowState reports missing, free and held rows', async () => {
  const t = fakeTable([{ id: 'h', scope: 's/held', holder: 'shipA:1', created_at: NOW, updated_at: NOW },
    { id: 'f', scope: 's/free', holder: '', created_at: NOW, updated_at: NOW }]);
  assert.deepEqual(await lockRowState(t, MODEL, 's/none'), { exists: false });
  assert.deepEqual(await lockRowState(t, MODEL, 's/free'), { exists: true });
  assert.equal((await lockRowState(t, MODEL, 's/held')).holder, 'shipA:1');
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

test('release lands even when the row was touched after the claim', async () => {
  const { client, row } = fakeClient({ id: 'r', scope: 's', holder: '', updated_at: NOW });
  const got = await acquireBoardLock(client, MODEL, 's', 'shipA:1', TTL);
  assert.equal(got.ok, true);
  row.updated_at = new Date(Date.now() + 5000).toISOString();   // someone bumped it
  if (got.ok) await got.release();
  assert.equal(row.holder, '');
});

test('release failure is logged, not thrown', async () => {
  const f = fakeClient({ id: 'r', scope: 's', holder: '', updated_at: NOW });
  const warns: string[] = [];
  const got = await acquireBoardLock(f.client, MODEL, 's', 'shipA:1', TTL, { warn: (m) => warns.push(m) });
  f.client.update = async () => { throw new Error('boom'); };
  if (got.ok) await got.release();
  assert.match(warns[0] ?? '', /lock release failed.*boom/);
});

test('this ship\'s claim by a dead pid is reclaimed; a live pid and another ship are not', async () => {
  const dead = fakeClient({ id: 'r', scope: 's', holder: 'shipA:999999999', updated_at: NOW });
  assert.equal((await acquireBoardLock(dead.client, MODEL, 's', 'shipA:1', TTL)).ok, true);
  const live = fakeClient({ id: 'r', scope: 's', holder: `shipA:${process.pid}`, updated_at: NOW });
  assert.equal((await acquireBoardLock(live.client, MODEL, 's', 'shipA:1', TTL)).ok, false);
  const other = fakeClient({ id: 'r', scope: 's', holder: 'shipB:999999999', updated_at: NOW });
  assert.equal((await acquireBoardLock(other.client, MODEL, 's', 'shipA:1', TTL)).ok, false);
});

// CREW-3870: a live release renews its lock; only a dead one loses it.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a release running past the lifetime keeps the lock and another ship sees it held (CREW-3870)', async () => {
  const f = fakeClient({ id: 'r1', scope: 's', holder: '', updated_at: NOW });
  const ttl = 60;
  const a = await acquireBoardLock(f.client, MODEL, 's', 'shipA:1', ttl, {}, 15);
  assert.equal(a.ok, true);
  await sleep(ttl * 3);   // three lifetimes: unrenewed, the row would be stale
  const b = await acquireBoardLock(f.client, MODEL, 's', 'shipB:2', ttl);
  assert.deepEqual(b.ok ? null : [b.reason, b.heldBy], ['held', 'shipA:1']);
  if (a.ok) { assert.equal(await a.stillHeld(), true); await a.release(); }
});

test('a killed release stops renewing and another ship can take the lock after the lifetime (CREW-3870)', async () => {
  const f = fakeClient({ id: 'r1', scope: 's', holder: 'shipA:1', updated_at: new Date(Date.now() - 1000).toISOString() });
  // No timer ever ran for this holder (its process is gone), so the row just ages.
  const b = await acquireBoardLock(f.client, MODEL, 's', 'shipB:2', 5000);
  assert.equal(b.ok, false);
  const c = await acquireBoardLock(f.client, MODEL, 's', 'shipB:2', 100, {}, 1000);
  assert.equal(c.ok, true);   // 1s old row is past a 100ms lifetime
  if (c.ok) await c.release();
});

test('a failed renewal is logged and the next one is attempted (CREW-3870)', async () => {
  const f = fakeClient({ id: 'r1', scope: 's', holder: '', updated_at: NOW });
  const warns: string[] = [];
  const a = await acquireBoardLock(f.client, MODEL, 's', 'shipA:1', TTL, { warn: (m) => warns.push(m) }, 60_000);
  assert.ok(a.ok);
  if (!a.ok) return;
  const realUpdate = f.client.update;
  f.client.update = async () => { throw new Error('tracker unreachable'); };
  await a.renew();
  assert.ok(warns.some((w) => /renewal failed.*tracker unreachable/.test(w)));
  f.client.update = realUpdate;
  const before = f.calls.length;
  await a.renew();
  assert.equal(f.calls.length, before + 1);
  assert.equal(await a.stillHeld(), true);
  await a.release();
});

test('a lock taken over by another holder is reported as no longer held (CREW-3870)', async () => {
  const f = fakeClient({ id: 'r1', scope: 's', holder: '', updated_at: NOW });
  const warns: string[] = [];
  const a = await acquireBoardLock(f.client, MODEL, 's', 'shipA:1', TTL, { warn: (m) => warns.push(m) }, 60_000);
  assert.ok(a.ok);
  if (!a.ok) return;
  f.row.holder = 'shipB:2';
  f.row.updated_at = new Date(Date.now() + 5000).toISOString();
  assert.equal(await a.stillHeld(), false);
  await a.release();
  assert.equal(f.row.holder, 'shipB:2');   // not ours to clear
});

test('release stops the renewal timer, so no write follows it (CREW-3870)', async () => {
  const f = fakeClient({ id: 'r1', scope: 's', holder: '', updated_at: NOW });
  const a = await acquireBoardLock(f.client, MODEL, 's', 'shipA:1', TTL, {}, 10);
  assert.ok(a.ok);
  if (!a.ok) return;
  await sleep(45);
  assert.ok(f.calls.length > 1);   // claim + renewals
  await a.release();
  const after = f.calls.length;
  await sleep(50);
  assert.equal(f.calls.length, after);
});

/** A full in-memory Locks table (list, create, remove and CAS update) for the create-on-missing path (CREW-4026). */
function lockTable(rows: Array<{ id: string; scope: string; holder?: string; created_at: string; updated_at: string }> = [], prefix = 'n') {
  let n = 0;
  const t = {
    rows,
    creates: 0,
    createError: undefined as (Error & { status?: number }) | undefined,
    onCreate: undefined as (() => void) | undefined,
    async list(_m: string, params?: { filters?: string; limit?: number }) {
      const want = JSON.parse(params?.filters ?? '[]')[0]?.value;
      return t.rows.filter((r) => r.scope === want).slice(0, params?.limit ?? 100);
    },
    async create(_m: string, body: Record<string, unknown>) {
      if (t.createError) throw t.createError;
      t.creates++;
      const row = {
        id: `${prefix}-${++n}`, scope: String(body.scope), holder: String(body.holder ?? ''),
        created_at: new Date(Date.now() + n).toISOString(), updated_at: new Date().toISOString(),
      };
      t.rows.push(row);
      t.onCreate?.();
      return row;
    },
    async remove(_m: string, id: string) { t.rows = t.rows.filter((r) => r.id !== id); },
    async update(_m: string, id: string, body: Record<string, unknown>, expected?: string) {
      const row = t.rows.find((r) => r.id === id);
      if (!row) throw new Error('no such record');
      if (expected !== undefined && expected !== row.updated_at) throw new StaleWriteError({ conflict: true });
      row.holder = String(body.holder);
      row.updated_at = new Date(Date.now() + (++writeCounter)).toISOString();
      return { ...row };
    },
  };
  return t;
}

test('CREW-4026: a missing row is created exactly once, then claimed', async () => {
  const t = lockTable();
  const got = await acquireOrCreateBoardLock(t, MODEL, 'ws/proj/a', 'shipA:1', TTL);
  assert.ok(got.ok);
  if (got.ok) { assert.equal(got.created, true); assert.equal(got.exclusion, 'taken'); await got.release(); }
  assert.equal(t.rows.length, 1);
  assert.equal(t.creates, 1);
  const again = await acquireOrCreateBoardLock(t, MODEL, 'ws/proj/a', 'shipA:1', TTL);
  assert.ok(again.ok);
  if (again.ok) { assert.equal(again.created, false); await again.release(); }
  assert.equal(t.creates, 1, 'an existing row is never created again');
});

test('CREW-4026: no Locks table means exclusion off and nothing created', async () => {
  const t = lockTable();
  const got = await acquireOrCreateBoardLock(t, undefined, 'ws/proj/a', 'shipA:1', TTL);
  assert.ok(got.ok);
  if (got.ok) assert.equal(got.exclusion, 'off');
  assert.equal(t.creates, 0);
});

test('CREW-4026: two ships creating at once end with one row and one holder', async () => {
  // Both see "missing"; each ship's row is created inside the other's window, so both rows exist at once.
  const shared = lockTable();
  const rowsBefore: string[] = [];
  let injected = false;
  shared.onCreate = () => {
    if (injected) return;
    injected = true;
    // The rival's row lands just after ours is created, and is OLDER than it.
    shared.rows.push({ id: 'rival', scope: 'ws/proj/a', holder: '', created_at: '2000-01-01T00:00:00.000Z', updated_at: new Date().toISOString() });
    rowsBefore.push(...shared.rows.map((r) => r.id));
  };
  const a = await acquireOrCreateBoardLock(shared, MODEL, 'ws/proj/a', 'shipA:1', TTL);
  assert.equal(rowsBefore.length, 2, 'both rows existed at once');
  // The rival ship now starts the same release against the surviving row.
  const b = await acquireOrCreateBoardLock(shared, MODEL, 'ws/proj/a', 'shipB:2', TTL);
  assert.equal(shared.rows.length, 1);
  assert.equal(shared.rows[0]?.id, 'rival', 'the earliest row survives');
  const holders = [a, b].filter((r) => r.ok);
  assert.equal(holders.length, 1, 'exactly one ship holds the scope');
  const loser = [a, b].find((r) => !r.ok);
  assert.ok(loser && !loser.ok && (loser.reason === 'held' || loser.reason === 'contended'));
  for (const h of holders) if (h.ok) await h.release();
});

test('CREW-4026: with two rows, acquire and lockRowState both act on the earliest', async () => {
  const t = lockTable([
    { id: 'z-late', scope: 's', holder: '', created_at: '2026-02-01T00:00:00.000Z', updated_at: NOW },
    { id: 'a-early', scope: 's', holder: 'shipB:2', created_at: '2026-01-01T00:00:00.000Z', updated_at: NOW },
  ]);
  assert.equal((await lockRowState(t, MODEL, 's')).holder, 'shipB:2');
  const got = await acquireBoardLock(t, MODEL, 's', 'shipA:1', TTL);
  assert.equal(got.ok, false);
  if (!got.ok) assert.equal(got.heldBy, 'shipB:2', 'saw the earliest row, not whichever listed first');
  assert.equal(t.rows.find((r) => r.id === 'z-late')?.holder, '');
});

test('CREW-4026: a refused create is reported with its cause and never claims', async () => {
  const t = lockTable();
  t.createError = Object.assign(new Error('forbidden'), { status: 403 });
  const got = await acquireOrCreateBoardLock(t, MODEL, 's', 'shipA:1', TTL);
  assert.equal(got.ok, false);
  if (!got.ok && got.reason === 'create_refused') { assert.equal(got.cause, 'forbidden'); assert.match(got.error, /forbidden/); }
  else assert.fail('expected create_refused');
  t.createError = Object.assign(new Error('boom'), { status: 500 });
  const other = await acquireOrCreateBoardLock(t, MODEL, 's', 'shipA:1', TTL);
  if (!other.ok && other.reason === 'create_refused') assert.equal(other.cause, 'error');
  else assert.fail('expected create_refused');
  assert.equal(t.rows.length, 0);
});

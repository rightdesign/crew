import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ensureMachineId, machineIdPathFor, matchShipRows } from '../src/machine-id.ts';
import { discover } from '../src/connect.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('ensureMachineId hashes the raw id, caches it, and never re-reads once cached (ISSUE-2249)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mid-'));
  const id = ensureMachineId(dir, { read: () => 'RAW-UUID' });
  assert.equal(id, sha('RAW-UUID'));
  assert.ok(!readFileSync(machineIdPathFor(dir), 'utf8').includes('RAW-UUID'), 'raw id is never written');
  assert.equal(ensureMachineId(dir, { read: () => { throw new Error('should not re-read'); } }), id);
});

test('ensureMachineId: --machine-id override is hashed and never cached; no raw id yields undefined', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mid-'));
  assert.equal(ensureMachineId(dir, { override: 'container-1', read: () => 'RAW' }), sha('container-1'));
  assert.equal(ensureMachineId(dir, { read: () => undefined }), undefined);
  writeFileSync(machineIdPathFor(dir), 'garbage\n');
  assert.equal(ensureMachineId(dir, { read: () => 'RAW' }), sha('RAW'), 'a corrupt cache is rebuilt');
});

test('matchShipRows prefers the machine id, falls back to name, and probes the column (ISSUE-2249)', () => {
  const rows = [{ id: 'a', name: 'Old', machine_id: 'M1' }, { id: 'b', name: 'Other', machine_id: null }];
  assert.deepEqual(matchShipRows(rows, 'New', 'M1'), { rows: [rows[0]], by: 'machine_id', hasColumn: true });
  assert.equal(matchShipRows(rows, 'Other', 'M2').by, 'name');
  assert.equal(matchShipRows([{ name: 'X' }], 'X', 'M1').hasColumn, false);
});

function mockCalls(routes: Record<string, unknown>) {
  const original = globalThis.fetch;
  const calls: Array<{ method: string; key: string; body: unknown }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${url.pathname}${url.search}`;
    calls.push({ method: init?.method ?? 'GET', key, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (!(key in routes)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, calls };
}

const BASE = { baseUrl: 'https://example.test', apiKey: 'k', userAgent: 'crew-test' };
const SEATS = (ship: string) => [
  { id: 'seat-dev', name: 'Developer agent', ship_id: ship }, { id: 'seat-design', name: 'Design agent', ship_id: ship },
  { id: 'seat-qa', name: 'QA agent', ship_id: ship }, { id: 'seat-triage', name: 'Triage agent', ship_id: ship },
  { id: 'rel', name: 'Release agent', ship_id: ship },
];

function routes(ships: unknown[], withColumn: boolean, shipForSeats: string) {
  return {
    '/api/workspaces/issues': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/bar?workspaceId=ws-1': { id: 'proj-1', name: 'Bar' },
    '/api/data-models?projectId=proj-1': [
      { id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'crew-model', name: 'Crew' }, { id: 'ships-model', name: 'Ships' },
    ],
    '/api/data-models/ships-model': { fields: [{ columnName: 'name' }, ...(withColumn ? [{ columnName: 'machine_id' }] : [])] },
    '/api/data-models/ships-model/records?limit=200': ships,
    '/api/data-models/ships-model/records': { id: 'ship-new' },
    '/api/data-models/crew-model/records?limit=200': SEATS(shipForSeats),
  };
}

test('discover() matches the Ships row by machine id when the hostname drifted: no second row, name kept (ISSUE-2249)', async (t) => {
  const { restore, calls } = mockCalls({
    ...routes([{ id: 'ship-1', name: 'Old Name', machine_id: 'M1', host_passengers: false }], true, 'ship-1'),
    '/api/data-models/ships-model/records/ship-1': { id: 'ship-1' },
  });
  t.after(restore);
  const found = await discover({ ...BASE, workspace: 'issues', project: 'bar', ship: { name: 'New Name', machineId: 'M1' } });
  assert.equal(found.shipRow?.id, 'ship-1');
  assert.equal(found.shipRow?.matchedBy, 'machine_id');
  assert.equal(found.shipRow?.name, 'Old Name');
  assert.ok(found.provisioning.some((p) => p.includes('row\'s name is kept')));
  assert.ok(!calls.some((c) => c.method === 'POST' && c.key === '/api/data-models/ships-model/records'), 'no second row');
  const patch = calls.find((c) => c.method === 'PATCH' && c.key.endsWith('/ship-1'));
  assert.ok(patch && !('name' in (patch.body as object)) && 'last_seen' in (patch.body as object));
});

test('discover() matches by name and writes the machine id onto the row (ISSUE-2249)', async (t) => {
  const { restore, calls } = mockCalls({
    ...routes([{ id: 'ship-1', name: 'Box', machine_id: null }], true, 'ship-1'),
    '/api/data-models/ships-model/records/ship-1': { id: 'ship-1' },
  });
  t.after(restore);
  const found = await discover({ ...BASE, workspace: 'issues', project: 'bar', ship: { name: 'Box', machineId: 'M1' } });
  assert.equal(found.shipRow?.matchedBy, 'name');
  assert.deepEqual(calls.find((c) => c.method === 'PATCH' && c.key.endsWith('/ship-1'))?.body, { machine_id: 'M1' });
});

test('discover() gives two machines with the same hostname two rows (ISSUE-2249)', async (t) => {
  const { restore, calls } = mockCalls(routes([{ id: 'ship-1', name: 'Box', machine_id: 'OTHER' }], true, 'ship-new'));
  t.after(restore);
  const found = await discover({ ...BASE, workspace: 'issues', project: 'bar', ship: { name: 'Box', machineId: 'M1' } });
  assert.equal(found.shipRow?.action, 'created');
  const create = calls.find((c) => c.method === 'POST' && c.key === '/api/data-models/ships-model/records');
  assert.equal((create?.body as { machine_id?: string }).machine_id, 'M1');
});

test('discover() without the machine_id column behaves exactly as before and never sends the field (ISSUE-2249)', async (t) => {
  const { restore, calls } = mockCalls({
    ...routes([{ id: 'ship-1', name: 'Box' }], false, 'ship-1'),
    '/api/data-models/ships-model/records/ship-1': { id: 'ship-1' },
  });
  t.after(restore);
  const found = await discover({ ...BASE, workspace: 'issues', project: 'bar', ship: { name: 'Box', machineId: 'M1' } });
  assert.equal(found.shipRow?.matchedBy, 'name');
  assert.ok(!calls.some((c) => c.method !== 'GET' && JSON.stringify(c.body ?? {}).includes('machine_id')));
});

test('discover() dry run writes nothing even with a machine id (ISSUE-2249)', async (t) => {
  const { restore, calls } = mockCalls(routes([], true, 'ship-new'));
  t.after(restore);
  await discover({ ...BASE, workspace: 'issues', project: 'bar', dryRun: true, ship: { name: 'Box', machineId: 'M1' } });
  assert.ok(!calls.some((c) => c.method === 'POST' || c.method === 'PATCH'));
});

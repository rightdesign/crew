import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolvedPathFor } from '../src/config.ts';
import {
  ShipNameError, planNameSync, reconcileShipName, setShipNameInYaml, shipNameOfYaml, validateShipName,
} from '../src/ship-name.ts';
import type { ShipRow } from '../src/tracker.ts';

const ROUTE = 'ws/proj';
const YAML = '# my crew\nship:\n  name: Old # the box\n  platform: macos\nroutes: []\n';

/** A machine's whole world: crew.yaml, a resolved file, and an in-memory Ships table. */
function world(o: { yamlName: string; rowName: string; lastSynced?: string; machineColumn?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'shipname-'));
  const configFile = join(dir, 'crew.yaml');
  writeFileSync(configFile, YAML.replace('Old', o.yamlName));
  const resolved = resolvedPathFor(dir, ROUTE);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, JSON.stringify({ workspaceId: 'w', ...(o.lastSynced ? { shipName: o.lastSynced } : {}) }));
  const row: ShipRow = o.machineColumn === false ? { id: 'r1', name: o.rowName } : { id: 'r1', name: o.rowName, machine_id: 'M1' };
  const rows: ShipRow[] = [row, o.machineColumn === false ? { id: 'r2', name: 'Other' } : { id: 'r2', name: 'Other', machine_id: 'M2' }];
  const events: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
  const emit = {
    emit: (message: string, x?: { data?: Record<string, unknown> }) => { events.push({ level: 'info', message, data: x?.data }); },
    warn: (message: string, x?: { data?: Record<string, unknown> }) => { events.push({ level: 'warn', message, data: x?.data }); },
  };
  const ship = { name: o.yamlName };
  const run = (extra: { readOnly?: boolean; rename?: (id: string, name: string) => Promise<void> } = {}) => reconcileShipName({
    route: ROUTE, configFile, stateDir: dir, ship, machineId: 'M1', rows: async () => rows,
    rename: extra.rename ?? (async (id, name) => { rows.find((r) => r.id === id)!.name = name; }),
    emit, readOnly: extra.readOnly,
  });
  const synced = () => (JSON.parse(readFileSync(resolved, 'utf8')) as { shipName?: string }).shipName;
  return { run, rows, events, ship, configFile, synced };
}

test('validateShipName trims and rejects empty or control characters', () => {
  assert.equal(validateShipName("  Brad's MacBook "), "Brad's MacBook");
  assert.throws(() => validateShipName('   '), ShipNameError);
  assert.throws(() => validateShipName('a\nb'), ShipNameError);
});

test('planNameSync: the three-way rule', () => {
  assert.deepEqual(planNameSync('A', 'A', 'A'), { drift: 'none', action: 'none' });
  assert.deepEqual(planNameSync('A', 'B', 'A'), { drift: 'row', action: 'adopt' });
  assert.deepEqual(planNameSync('B', 'A', 'A'), { drift: 'local', action: 'push' });
  assert.deepEqual(planNameSync('B', 'C', 'A'), { drift: 'both', action: 'row-wins' });
  assert.deepEqual(planNameSync('B', 'C', undefined), { drift: 'both', action: 'row-wins' }, 'no baseline: the row wins');
});

test('setShipNameInYaml keeps comments', () => {
  const out = setShipNameInYaml(YAML, 'New');
  assert.match(out, /# my crew/);
  assert.match(out, /name: New # the box/);
  assert.equal(shipNameOfYaml(out), 'New');
});

test('row renamed in the table: crew.yaml adopts it, one ship_renamed event', async () => {
  const w = world({ yamlName: 'Old', rowName: 'Studio', lastSynced: 'Old' });
  const r = await w.run();
  assert.equal(r.action, 'adopt');
  assert.equal(shipNameOfYaml(readFileSync(w.configFile, 'utf8')), 'Studio');
  assert.match(readFileSync(w.configFile, 'utf8'), /# my crew/);
  assert.equal(w.ship.name, 'Studio');
  assert.equal(w.synced(), 'Studio');
  assert.deepEqual(w.events.map((e) => [e.level, e.data?.event, e.data?.from, e.data?.to]), [['info', 'ship_renamed', 'Old', 'Studio']]);
  assert.equal((await w.run()).action, 'none', 'a second pass is quiet');
  assert.equal(w.events.length, 1);
});

test('crew.yaml edited by hand: the row takes the new name', async () => {
  const w = world({ yamlName: 'Hand', rowName: 'Old', lastSynced: 'Old' });
  const r = await w.run();
  assert.equal(r.action, 'push');
  assert.equal(w.rows[0]!.name, 'Hand');
  assert.equal(w.rows[1]!.name, 'Other', 'only this machine\'s row');
  assert.equal(w.synced(), 'Hand');
  assert.equal(w.events[0]!.data?.event, 'ship_renamed');
});

test('both changed: the Ships row wins and a warning names both values', async () => {
  const w = world({ yamlName: 'Hand', rowName: 'Studio', lastSynced: 'Old' });
  const r = await w.run();
  assert.equal(r.action, 'row-wins');
  assert.equal(shipNameOfYaml(readFileSync(w.configFile, 'utf8')), 'Studio');
  assert.equal(w.rows[0]!.name, 'Studio');
  assert.equal(w.events[0]!.level, 'warn');
  assert.match(w.events[0]!.message, /Hand.*Studio/);
});

test('no machine_id column: nothing is compared or written', async () => {
  const w = world({ yamlName: 'Hand', rowName: 'Old', lastSynced: 'Old', machineColumn: false });
  const r = await w.run();
  assert.equal(r.status, 'unsupported');
  assert.equal(w.rows[0]!.name, 'Old');
  assert.equal(w.synced(), 'Old');
  assert.deepEqual(w.events, []);
});

test('readOnly reports drift and writes nothing', async () => {
  const w = world({ yamlName: 'Old', rowName: 'Studio', lastSynced: 'Old' });
  const r = await w.run({ readOnly: true });
  assert.equal(r.drift, 'row');
  assert.equal(r.rowName, 'Studio');
  assert.equal(shipNameOfYaml(readFileSync(w.configFile, 'utf8')), 'Old');
  assert.equal(w.synced(), 'Old');
});

test('a refused row write warns and leaves the baseline alone', async () => {
  const w = world({ yamlName: 'Hand', rowName: 'Old', lastSynced: 'Old' });
  const r = await w.run({ rename: async () => { throw new Error('403 forbidden'); } });
  assert.equal(r.status, 'refused');
  assert.equal(w.synced(), 'Old', 'retried next pass');
  assert.equal(w.events[0]!.level, 'warn');
});

test('first sync with agreeing names records the baseline', async () => {
  const w = world({ yamlName: 'Same', rowName: 'Same' });
  await w.run();
  assert.equal(w.synced(), 'Same');
  assert.deepEqual(w.events, []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TablationApiError } from '@tablation/client';
import {
  belowFloor, compareVersions, sentVersion, checkCrewFloor, isUpgradeRequired, raiseFromUpgradeRequired, CREW_OUTDATED_KEY,
} from '../src/crew-floor.ts';
import { openShipAttention } from '../src/ship-attention.ts';
import { Emitter } from '../src/events.ts';
import { State } from '../src/state.ts';
import type { Route, Ship } from '../src/config.ts';

const ship = { userAgent: 'Mozilla/5.0 CrewAgent/0.61.0' } as Ship;
const route = { route: 'r', hooks: {} } as unknown as Route; // the notify hook only reads route.hooks
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-floor-'));
  return { state: new State(dir), emit: new Emitter({ file: join(dir, 'events.jsonl'), cycle: 'c' } as never) };
};

test('compareVersions orders numerically, not lexically', () => {
  assert.ok(compareVersions('0.9.0', '0.10.0')! < 0);
  assert.equal(compareVersions('1.2.3', 'v1.2.3'), 0);
  assert.equal(compareVersions('x', '1.0.0'), null);
});

test('belowFloor: no floor or an unreadable one never stops a ship', () => {
  assert.equal(belowFloor('0.61.0', null), false);
  assert.equal(belowFloor('0.61.0', 'garbage'), false);
  assert.equal(belowFloor('0.61.0', '0.61.0'), false);
  assert.equal(belowFloor('0.61.0', '0.62.0'), true);
});

test('sentVersion reads the CrewAgent marker, null for a custom agent string', () => {
  assert.equal(sentVersion(ship), '0.61.0');
  assert.equal(sentVersion({ userAgent: 'curl/8' } as Ship), null);
});

test('checkCrewFloor raises once below the floor, stops picking, and clears when met', async () => {
  const { state, emit } = fresh();
  const o = { state, emit, route, ship };
  const msg = await checkCrewFloor(o, { read: async () => '0.70.0' });
  assert.match(msg!, /0\.61\.0.*0\.70\.0/);
  assert.equal(openShipAttention(state).filter((i) => i.key === CREW_OUTDATED_KEY).length, 1);
  await checkCrewFloor(o, { read: async () => '0.70.0' });
  assert.equal(openShipAttention(state).filter((i) => i.key === CREW_OUTDATED_KEY).length, 1);
  // an unreadable floor keeps the stop
  assert.ok(await checkCrewFloor(o, { read: async () => undefined }));
  assert.equal(await checkCrewFloor(o, { read: async () => '0.61.0' }), null);
  assert.equal(openShipAttention(state).length, 0);
});

test('a floor at or below the running version changes nothing', async () => {
  const { state, emit } = fresh();
  assert.equal(await checkCrewFloor({ state, emit, route, ship }, { read: async () => null }), null);
  assert.equal(openShipAttention(state).length, 0);
});

test('a 426 raises the item once and names the required version', async () => {
  const { state, emit } = fresh();
  const err = new TablationApiError('Upgrade Required: crew 0.80.0 is required, 0.61.0 sent', 426, {});
  assert.ok(isUpgradeRequired(err));
  assert.equal(isUpgradeRequired(new TablationApiError('x', 500, {})), false);
  await raiseFromUpgradeRequired({ state, emit, ship }, err);
  await raiseFromUpgradeRequired({ state, emit, ship }, err);
  const items = openShipAttention(state);
  assert.equal(items.length, 1);
  assert.match(items[0]!.message, /0\.80\.0/);
});

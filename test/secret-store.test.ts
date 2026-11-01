import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Route } from '../src/config.ts';
import { crewifyStoreError, describeKeyStore, FileSessionStore, keysDir, osStoreReachable, resolveStoreKind } from '../src/secret-store.ts';
import { mintMissingSeatKeys, resolveSeatKey } from '../src/seat-keys.ts';

delete process.env.CREW_API_KEY;

const session = { apiKey: 'sk_abc', workspaceId: 'w', identityId: 'i', createdAt: 'now' };

test('file store round-trips, uses owner-only permissions and clears', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'crew-keys-')), 'keys');
  const s = new FileSessionStore(dir);
  assert.equal(await s.get('h', 'ws#agent:1'), undefined);
  await s.set('h', 'ws#agent:1', session);
  assert.deepEqual(await s.get('h', 'ws#agent:1'), session);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(await s.get('h', 'ws#agent:2'), undefined);
  await s.clear('h', 'ws#agent:1');
  assert.equal(await s.get('h', 'ws#agent:1'), undefined);
  assert.deepEqual(s.writable(), { ok: true });
});

test('auto picks the file store only on Linux with no reachable secret service', () => {
  assert.equal(osStoreReachable({}, 'darwin'), true);
  assert.equal(osStoreReachable({}, 'win32'), true);
  assert.equal(osStoreReachable({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' }, 'linux', () => true), true);
  assert.equal(osStoreReachable({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' }, 'linux', () => false), false);
  assert.equal(osStoreReachable({}, 'linux', () => true), false);
  assert.equal(resolveStoreKind('auto', false), 'file');
  assert.equal(resolveStoreKind('auto', true), 'os');
  assert.equal(resolveStoreKind('os', false), 'os');
  assert.equal(resolveStoreKind('file', true), 'file');
});

test("the OS store's advice names crew's variable and the secretStore setting", () => {
  const e = crewifyStoreError(new Error('No Secret Service is available (libsecret). Set TABLATION_API_KEY instead of running `login`.'));
  assert.match(e.message, /CREW_API_KEY/);
  assert.match(e.message, /ship\.secretStore: file/);
  assert.doesNotMatch(e.message, /TABLATION_API_KEY/);
});

test('crew doctor reports the store in use and whether it is writable', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-state-'));
  const line = describeKeyStore({ secretStore: 'file', stateDir });
  assert.match(line, new RegExp(`file ${keysDir(stateDir)}`));
  assert.match(line, /writable/);
  assert.match(describeKeyStore({ secretStore: 'os', stateDir }), /^OS secret store/);
});

const route = {
  route: 'issues/crew', baseUrl: 'https://example.test', apiKey: 'ship-key',
  resolved: { workspaceId: 'ws-1', seats: { dev: 'crew-dev' }, agentPersonas: { dev: { agentId: 'agent-dev', lastSyncedUpdatedAt: 'x' } } },
} as unknown as Route;

test('seat keys mint into the file store and resolve per seat; an unreadable directory is a store error, not the ship key', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'crew-keys-')), 'keys');
  const store = new FileSessionStore(dir);
  const fetchImpl = (async () => new Response(JSON.stringify({ key: 'sk_dev', id: 'k1' }), { status: 201 })) as typeof fetch;
  const out = await mintMissingSeatKeys(route, { getStore: () => store, fetchImpl });
  assert.equal(out.find((o) => o.role === 'dev')?.action, 'minted');
  const ok = await resolveSeatKey(route, 'dev', () => store);
  assert.equal(ok.kind, 'agent');
  assert.equal(ok.apiKey, 'sk_dev');

  chmodSync(dir, 0o000);
  try {
    if (process.getuid?.() === 0) return; // root reads through mode bits
    const bad = await resolveSeatKey(route, 'dev', () => store);
    assert.equal(bad.kind, 'ship');
    assert.match((bad as { storeError?: string }).storeError ?? '', /key file store unreadable \(EACCES\)/);
  } finally {
    chmodSync(dir, 0o700);
  }
});

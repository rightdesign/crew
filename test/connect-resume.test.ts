import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastSessionFile, rememberSession, resumeKeychainSession } from '../src/connect-resume.ts';

const HOST = 'app.example.test';
const dir = () => mkdtempSync(join(tmpdir(), 'crew-resume-'));
const storeOf = (entries: Record<string, string>) => ({
  get: async (host: string, ws: string) => {
    const apiKey = entries[`${host}/${ws}`];
    return apiKey ? { apiKey, shipId: 's', workspaceId: 'w', identityId: 'i', createdAt: 'now' } : undefined;
  },
});

test('after a stored sign-in, the keychain session is resumed with no device flow', async () => {
  const stateDir = dir();
  rememberSession(stateDir, HOST, 'ws');
  const seen: string[] = [];
  const r = await resumeKeychainSession({
    store: storeOf({ [`${HOST}/ws`]: 'k1' }), stateDir, host: HOST,
    verify: async (k) => { seen.push(k); return true; },
  });
  assert.deepEqual(r, { workspace: 'ws', apiKey: 'k1' });
  assert.deepEqual(seen, ['k1']);
});

test('nothing resumes when there is no pointer, no keychain entry, a rejected key or an unreachable keychain', async () => {
  const stateDir = dir();
  const ok = async () => true;
  assert.equal(await resumeKeychainSession({ store: storeOf({}), stateDir, host: HOST, verify: ok }), undefined, 'no pointer');
  rememberSession(stateDir, HOST, 'ws');
  assert.equal(await resumeKeychainSession({ store: storeOf({}), stateDir, host: HOST, verify: ok }), undefined, 'credential removed');
  assert.equal(await resumeKeychainSession({
    store: storeOf({ [`${HOST}/ws`]: 'old' }), stateDir, host: HOST, verify: async () => false,
  }), undefined, 'credential rejected by the server');
  assert.equal(await resumeKeychainSession({
    store: { get: async () => { throw new Error('no secret service'); } }, stateDir, host: HOST, verify: ok,
  }), undefined, 'keychain unreachable');
});

test('the pointer is per host and holds no secret', async () => {
  const stateDir = dir();
  rememberSession(stateDir, HOST, 'ws');
  rememberSession(stateDir, 'other.test', 'beta');
  assert.deepEqual(JSON.parse(readFileSync(lastSessionFile(stateDir), 'utf8')), { [HOST]: 'ws', 'other.test': 'beta' });
  const r = await resumeKeychainSession({ store: storeOf({ 'other.test/beta': 'kb' }), stateDir, host: 'third.test', verify: async () => true });
  assert.equal(r, undefined);
});

test('a corrupt pointer file reads as no session, and an unwritable state dir does not throw', async () => {
  const stateDir = dir();
  rememberSession(stateDir, HOST, 'ws');
  (await import('node:fs')).writeFileSync(lastSessionFile(stateDir), '{not json');
  assert.equal(await resumeKeychainSession({ store: storeOf({ [`${HOST}/ws`]: 'k' }), stateDir, host: HOST, verify: async () => true }), undefined);
  assert.doesNotThrow(() => rememberSession('/dev/null/nope', HOST, 'ws'));
  assert.ok(!existsSync('/dev/null/nope'));
});

import { signOutSessions, rememberedSessions } from '../src/connect-resume.ts';

const clearingStore = (entries: Record<string, string>) => ({
  ...storeOf(entries),
  clear: async (host: string, ws: string) => { delete entries[`${host}/${ws}`]; },
});

test('sign-out clears the stored session and its pointer, and the next resume finds nothing', async () => {
  const stateDir = dir();
  const entries = { [`${HOST}/ws`]: 'k1' };
  const store = clearingStore(entries);
  rememberSession(stateDir, HOST, 'ws');
  const out = await signOutSessions({ store, stateDir });
  assert.deepEqual(out, [{ host: HOST, workspace: 'ws', action: 'removed' }]);
  assert.deepEqual(entries, {});
  assert.deepEqual(rememberedSessions(stateDir), []);
  assert.equal(existsSync(lastSessionFile(stateDir)), false);
  assert.equal(await resumeKeychainSession({ store, stateDir, host: HOST, verify: async () => true }), undefined);
});

test('sign-out with nothing stored reports absent, and a dry run removes nothing', async () => {
  const stateDir = dir();
  assert.deepEqual(await signOutSessions({ store: clearingStore({}), stateDir }), []);
  const entries = { [`${HOST}/ws`]: 'k1' };
  rememberSession(stateDir, HOST, 'ws');
  const dry = await signOutSessions({ store: clearingStore(entries), stateDir, dryRun: true });
  assert.equal(dry[0]?.action, 'would-remove');
  assert.deepEqual(Object.keys(entries), [`${HOST}/ws`]);
  assert.equal(rememberedSessions(stateDir).length, 1);
  const gone = await signOutSessions({ store: clearingStore({}), stateDir });
  assert.equal(gone[0]?.action, 'absent');
});

test('sign-out honors --host and --workspace', async () => {
  const stateDir = dir();
  const entries = { [`${HOST}/ws`]: 'k1', 'other.test/x': 'k2' };
  rememberSession(stateDir, HOST, 'ws');
  assert.deepEqual(await signOutSessions({ store: clearingStore(entries), stateDir, host: 'elsewhere.test' }), []);
  const out = await signOutSessions({ store: clearingStore(entries), stateDir, host: 'other.test', workspace: 'x' });
  assert.deepEqual(out, [{ host: 'other.test', workspace: 'x', action: 'removed' }]);
  assert.deepEqual(Object.keys(entries), [`${HOST}/ws`]);
});

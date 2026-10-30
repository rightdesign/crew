import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptSessionAddress, lastSessionFile, rememberedAddressFor, rememberSession, resumeKeychainSession } from '../src/connect-resume.ts';

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
  assert.deepEqual(JSON.parse(readFileSync(lastSessionFile(stateDir), 'utf8')), { [HOST]: ['ws'], 'other.test': ['beta'] });
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

import { resumableSessions } from '../src/connect-resume.ts';

test('CREW-2498: a real run resumes one remembered workspace, and offers several as a choice', async () => {
  const stateDir = dir();
  const store = storeOf({ [`${HOST}/a`]: 'ka', [`${HOST}/b`]: 'kb' });
  rememberSession(stateDir, HOST, 'a');
  assert.deepEqual(await resumableSessions({ store, stateDir, host: HOST, verify: async () => true }), [{ workspace: 'a', apiKey: 'ka' }]);
  rememberSession(stateDir, HOST, 'b');
  rememberSession(stateDir, HOST, 'a');
  const both = await resumableSessions({ store, stateDir, host: HOST, verify: async () => true });
  assert.deepEqual(both.map((r) => r.workspace), ['b', 'a']);
  assert.equal(await resumeKeychainSession({ store, stateDir, host: HOST, verify: async () => true }), undefined, 'ambiguous');
  assert.deepEqual(await resumableSessions({ store, stateDir, host: HOST, verify: async (k) => k === 'kb' }), [{ workspace: 'b', apiKey: 'kb' }]);
  assert.deepEqual(await resumableSessions({ store, stateDir, host: 'none.test', verify: async () => true }), [], 'no remembered session: device path');
});

test('CREW-2498: a pointer file from before several workspaces were remembered still reads', async () => {
  const stateDir = dir();
  (await import('node:fs')).writeFileSync(lastSessionFile(stateDir), JSON.stringify({ [HOST]: 'ws' }));
  assert.deepEqual(rememberedSessions(stateDir), [{ host: HOST, workspace: 'ws' }]);
});

/** A mutable fake keychain, keyed `host/workspace`. */
function mutableStore(entries: Record<string, string>) {
  const sess = (apiKey: string) => ({ apiKey, workspaceId: 'w', identityId: 'i', createdAt: 'now' });
  return {
    entries,
    get: async (host: string, ws: string) => {
      const k = entries[`${host}/${ws}`];
      return k ? sess(k) : undefined;
    },
    set: async (host: string, ws: string, s: { apiKey: string }) => { entries[`${host}/${ws}`] = s.apiKey; },
    clear: async (host: string, ws: string) => { delete entries[`${host}/${ws}`]; },
  };
}

test('adoptSessionAddress moves a bare-slug session to the full address, leaving one entry and one pointer (CREW-2668)', async () => {
  const stateDir = dir();
  const store = mutableStore({ [`${HOST}/design-team`]: 'k1' });
  rememberSession(stateDir, HOST, 'design-team');
  assert.equal(await adoptSessionAddress({ store, stateDir, host: HOST, from: 'design-team', to: 'acme:design-team' }), true);
  assert.deepEqual(store.entries, { [`${HOST}/acme:design-team`]: 'k1' });
  assert.deepEqual(JSON.parse(readFileSync(lastSessionFile(stateDir), 'utf8')), { [HOST]: ['acme:design-team'] });
  const again = await resumeKeychainSession({ store, stateDir, host: HOST, verify: async () => true });
  assert.deepEqual(again, { workspace: 'acme:design-team', apiKey: 'k1' });
});

test('adoptSessionAddress is a no-op for the same address, an empty keychain or a failing store', async () => {
  const stateDir = dir();
  const store = mutableStore({ [`${HOST}/ws`]: 'k' });
  assert.equal(await adoptSessionAddress({ store, stateDir, host: HOST, from: 'ws', to: 'ws' }), false);
  assert.equal(await adoptSessionAddress({ store, stateDir, host: HOST, from: 'gone', to: 'a:gone' }), false);
  const broken = { get: async () => { throw new Error('locked'); }, set: async () => {}, clear: async () => {} };
  assert.equal(await adoptSessionAddress({ store: broken, stateDir, host: HOST, from: 'x', to: 'a:x' }), false);
  assert.deepEqual(store.entries, { [`${HOST}/ws`]: 'k' });
});

test('rememberedAddressFor finds the full address of a bare secondary slug', () => {
  const stateDir = dir();
  rememberSession(stateDir, HOST, 'acme:design-team');
  assert.equal(rememberedAddressFor(stateDir, HOST, 'design-team'), 'acme:design-team');
  assert.equal(rememberedAddressFor(stateDir, HOST, 'acme:design-team'), 'acme:design-team');
  assert.equal(rememberedAddressFor(stateDir, HOST, 'other'), 'other');
  assert.equal(rememberedAddressFor(stateDir, 'else.test', 'design-team'), 'design-team');
});

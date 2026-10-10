import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionStore, StoredSession } from '@tablation/client';
import { hydrateApiKeys, resolveApiKey, apiKeyPathFor, type Route } from '../src/config.ts';

// resolveApiKey falls back to CREW_API_KEY (CREW-1503); these tests assert the
// no-key paths, so an ambient value (an agent's own key) must not leak in.
delete process.env.CREW_API_KEY;

/**
 * `hydrateApiKeys` reads the real OS keychain by default (`getSessionStore`
 * from `@tablation/client` — macOS Keychain/`security`, Linux
 * `secret-tool`, Windows Credential Manager). A test must never touch that,
 * so every test here supplies its own fake `getStore` — the same
 * `getStore` parameter `daemon.ts#runOnePass` forwards from its own
 * `getSessionStore` test-injection point.
 */
function fakeStore(
  sessions: Record<string, StoredSession | undefined>,
  calls: string[] = [],
): SessionStore {
  return {
    get: async (host, workspaceSlug) => {
      const key = `${host}/${workspaceSlug}`;
      calls.push(key);
      return sessions[key];
    },
    set: async () => {},
    clear: async () => {},
  };
}

function session(apiKey: string): StoredSession {
  return { apiKey, shipId: 'shp_test', workspaceId: 'ws-1', identityId: 'id-1', createdAt: '2026-09-21T00:00:00Z' };
}

let n = 0;
function fakeRoute(overrides: Partial<Route> = {}): Route {
  n++;
  return {
    route: `issues/route-${n}`,
    enabled: true,
    dir: '/tmp/does-not-matter',
    repos: {},
    reposBasePath: '/tmp',
    baseUrl: 'https://example.test',
    hooks: {},
    labels: {},
    release: {},
    repoOverrides: {},
    promptsDir: '/tmp/prompts',
    ...overrides,
  } as Route;
}

test('a route with no apiKey and no apiKeyFile is hydrated from the keychain', async () => {
  const route = fakeRoute();
  const calls: string[] = [];
  await hydrateApiKeys([route], () => fakeStore({ 'example.test/issues': session('sk_from_keychain') }, calls));
  assert.equal(resolveApiKey(route), 'sk_from_keychain');
  assert.deepEqual(calls, ['example.test/issues']);
});

test('a route with an explicit apiKey is never queried against the keychain', async () => {
  const route = fakeRoute({ apiKey: 'sk_explicit' });
  const calls: string[] = [];
  await hydrateApiKeys([route], () => fakeStore({ 'example.test/issues': session('sk_from_keychain') }, calls));
  assert.equal(resolveApiKey(route), 'sk_explicit');
  assert.deepEqual(calls, []);
});

test('a route with a working apiKeyFile is never queried against the keychain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-hydrate-'));
  const keyFile = join(dir, 'key.env');
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, 'CREW_API_KEY=sk_from_file\n');
  const route = fakeRoute({ apiKeyFile: keyFile, apiKeyVar: 'CREW_API_KEY' });
  const calls: string[] = [];
  await hydrateApiKeys([route], () => fakeStore({ 'example.test/issues': session('sk_from_keychain') }, calls));
  assert.equal(resolveApiKey(route), 'sk_from_file');
  assert.deepEqual(calls, []);
});

test('no session stored for this route leaves it unresolved, without throwing', async () => {
  const route = fakeRoute();
  await hydrateApiKeys([route], () => fakeStore({}));
  assert.throws(() => resolveApiKey(route), /no API key/);
});

test('getStore throwing (no keychain support on this platform) leaves every route unresolved, without throwing', async () => {
  const routeA = fakeRoute();
  const routeB = fakeRoute();
  await hydrateApiKeys([routeA, routeB], () => { throw new Error('unsupported platform'); });
  assert.throws(() => resolveApiKey(routeA), /no API key/);
  assert.throws(() => resolveApiKey(routeB), /no API key/);
});

test('store.get throwing (headless — no Secret Service/Credential Manager) leaves the route unresolved, without throwing', async () => {
  const route = fakeRoute();
  const store: SessionStore = {
    get: async () => { throw new Error('No Secret Service is available'); },
    set: async () => {},
    clear: async () => {},
  };
  await hydrateApiKeys([route], () => store);
  assert.throws(() => resolveApiKey(route), /no API key/);
});

test('a route already hydrated once keeps being re-queried on later calls — a re-connect takes effect without a restart', async () => {
  const route = fakeRoute();
  await hydrateApiKeys([route], () => fakeStore({ 'example.test/issues': session('sk_v1') }));
  assert.equal(resolveApiKey(route), 'sk_v1');

  // Simulates the daemon's per-cycle re-hydrate picking up a fresh `crew
  // connect` session without needing a restart.
  await hydrateApiKeys([route], () => fakeStore({ 'example.test/issues': session('sk_v2') }));
  assert.equal(resolveApiKey(route), 'sk_v2');
});

test('a route with an explicit apiKey is still never queried on a LATER call either, even once other routes have been hydrated', async () => {
  const explicit = fakeRoute({ apiKey: 'sk_explicit' });
  const eligible = fakeRoute();
  const calls: string[] = [];
  const getStore = () => fakeStore({
    'example.test/issues': session('sk_from_keychain'),
  }, calls);
  await hydrateApiKeys([explicit, eligible], getStore);
  await hydrateApiKeys([explicit, eligible], getStore);
  assert.equal(resolveApiKey(explicit), 'sk_explicit');
  assert.equal(resolveApiKey(eligible), 'sk_from_keychain');
});

test('apiKeyPathFor-style routes (mintedFromDevice-but-fallback-to-file) resolve without ever touching the keychain', async () => {
  // Mirrors what `crew connect`'s keychain-write-failed fallback writes:
  // an apiKeyFile under apiKeyPathFor, same as the pre-ISSUE-966 behavior.
  const dir = mkdtempSync(join(tmpdir(), 'crew-hydrate-'));
  const keyFile = apiKeyPathFor(dir, 'issues/fallback-route');
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, 'CREW_API_KEY=sk_fallback\n');
  const route = fakeRoute({ route: 'issues/fallback-route', apiKeyFile: keyFile, apiKeyVar: 'CREW_API_KEY' });
  const calls: string[] = [];
  await hydrateApiKeys([route], () => fakeStore({}, calls));
  assert.equal(resolveApiKey(route), 'sk_fallback');
  assert.deepEqual(calls, []);
});

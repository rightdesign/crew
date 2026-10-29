import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSessionStore } from '@tablation/client';
import type { SessionStore, StoredSession } from '@tablation/client';
import type { Route } from '../src/config.ts';
import { canMintAgentKeys, describeMintOutcome, mintMissingSeatKeys, revokeSeatKeys, resolveReleaseKey, resolveSeatKey, seatKeySlug } from '../src/seat-keys.ts';

delete process.env.CREW_API_KEY;

function memoryStore(): SessionStore & { data: Map<string, StoredSession> } {
  const data = new Map<string, StoredSession>();
  return {
    data,
    get: async (h, s) => data.get(`${h}/${s}`),
    set: async (h, s, v) => { data.set(`${h}/${s}`, v); },
    clear: async (h, s) => { data.delete(`${h}/${s}`); },
  };
}

function route(personas: Record<string, string> = { dev: 'agent-dev', qa: 'agent-qa' }): Route {
  return {
    route: 'issues/crew',
    baseUrl: 'https://example.test',
    apiKey: 'ship-key',
    resolved: {
      workspaceId: 'ws-1',
      seats: { dev: 'crew-dev', qa: 'crew-qa', pair: 'crew-pair' },
      agentPersonas: Object.fromEntries(Object.entries(personas).map(([r, agentId]) => [r, { agentId, lastSyncedUpdatedAt: 'x' }])),
    },
  } as unknown as Route;
}

test('resolveSeatKey returns the stored agent key', async () => {
  const store = memoryStore();
  await mintMissingSeatKeys(route(), {
    getStore: () => store,
    fetchImpl: async () => new Response(JSON.stringify({ key: 'sk_agent_dev' }), { status: 201 }),
  });
  const id = await resolveSeatKey(route(), 'dev', () => store);
  assert.deepEqual(id, { kind: 'agent', apiKey: 'sk_agent_dev', agentId: 'agent-dev' });
});

test('resolveSeatKey falls back to the ship key with a reason', async () => {
  const store = memoryStore();
  const id = await resolveSeatKey(route(), 'dev', () => store);
  assert.equal(id.kind, 'ship');
  assert.equal(id.apiKey, 'ship-key');
  const unlinked = await resolveSeatKey(route({}), 'dev', () => store);
  assert.match((unlinked as { reason: string }).reason, /no linked Agents row|no.*Agents row/);
  const pair = await resolveSeatKey(route(), 'pair', () => store);
  assert.equal(pair.kind, 'ship');
  const broken = await resolveSeatKey(route(), 'dev', () => { throw new Error('no keychain'); });
  assert.equal(broken.kind, 'ship');
});

test('mintMissingSeatKeys mints once per linked seat, skips stored keys and pair, uses the ship key', async () => {
  const store = memoryStore();
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get('authorization') });
    return new Response(JSON.stringify({ key: `sk_${calls.length}` }), { status: 201 });
  }) as unknown as typeof fetch;
  const first = await mintMissingSeatKeys(route(), { getStore: () => store, fetchImpl });
  assert.deepEqual(first.map((o) => [o.role, o.action]), [['dev', 'minted'], ['qa', 'minted']]);
  assert.equal(calls[0]!.url, 'https://example.test/api/workspaces/ws-1/agents/agent-dev/api-keys');
  assert.equal(calls[0]!.auth, 'Bearer ship-key');
  assert.ok(store.data.has(`example.test/${seatKeySlug('issues', 'agent-dev')}`));
  const second = await mintMissingSeatKeys(route(), { getStore: () => store, fetchImpl });
  assert.deepEqual(second.map((o) => o.action), ['already_stored', 'already_stored']);
  assert.equal(calls.length, 2);
});

test('a refused (403) mint is reported once, stores nothing, and does not throw', async () => {
  const store = memoryStore();
  const out = await mintMissingSeatKeys(route({ dev: 'agent-dev' }), {
    getStore: () => store,
    fetchImpl: async () => new Response('no', { status: 403, statusText: 'Forbidden' }),
  });
  assert.deepEqual(out.map((o) => [o.role, o.action]), [['dev', 'forbidden']]);
  assert.equal(store.data.size, 0);
});

test('dryRun mints nothing', async () => {
  const store = memoryStore();
  let called = false;
  await mintMissingSeatKeys(route(), { getStore: () => store, dryRun: true, fetchImpl: async () => { called = true; return new Response('{}'); } });
  assert.equal(called, false);
});

function releaseRoute(releaseAgentId?: string): Route {
  const r = route();
  return {
    ...r,
    resolved: { ...r.resolved!, releaseSeat: 'crew-release', ...(releaseAgentId ? { releaseAgentId } : {}) },
  } as Route;
}

test('the release seat gets its own key minted and resolved (CREW-1605)', async () => {
  const store = memoryStore();
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ key: `sk_${urls.length}` }), { status: 201 });
  }) as unknown as typeof fetch;
  const out = await mintMissingSeatKeys(releaseRoute('agent-release'), { getStore: () => store, fetchImpl });
  assert.equal(out.find((o) => o.role === 'release')?.action, 'minted');
  assert.ok(urls.some((u) => u.endsWith('/agents/agent-release/api-keys')));
  const id = await resolveReleaseKey(releaseRoute('agent-release'), () => store);
  assert.equal(id.kind, 'agent');
  assert.equal((await mintMissingSeatKeys(releaseRoute('agent-release'), { getStore: () => store, fetchImpl }))
    .find((o) => o.role === 'release')?.action, 'already_stored');
});

test('the release seat falls back to the ship key when unlinked, unkeyed or the keychain is down', async () => {
  const store = memoryStore();
  const unlinked = await resolveReleaseKey(releaseRoute(), () => store);
  assert.equal(unlinked.kind, 'ship');
  assert.equal(unlinked.apiKey, 'ship-key');
  assert.equal((await resolveReleaseKey(releaseRoute('agent-release'), () => store)).kind, 'ship');
  assert.equal((await resolveReleaseKey(releaseRoute('agent-release'), () => { throw new Error('no keychain'); })).kind, 'ship');
  const noSeat = await mintMissingSeatKeys(route(), { getStore: () => store, dryRun: true });
  assert.ok(!noSeat.some((o) => o.role === 'release'));
  const noAgent = await mintMissingSeatKeys(releaseRoute(), { getStore: () => store, dryRun: true });
  assert.equal(noAgent.find((o) => o.role === 'release')?.action, 'no_agent');
});

test('CREW-1797: a member key\'s seat-identity reasons name the admin step, an admin key\'s keep the old wording', async () => {
  const store = memoryStore();
  const member = route({});
  member.resolved!.role = 'WORKSPACE_USER';
  const noRow = await resolveSeatKey(member, 'dev', () => store);
  assert.equal(noRow.kind, 'ship');
  assert.match((noRow as { reason: string }).reason, /a workspace admin's `crew agents sync` creates the persona rows; run it here afterwards/);

  const linked = route();
  linked.resolved!.role = 'WORKSPACE_USER';
  const noKey = await resolveSeatKey(linked, 'dev', () => store);
  assert.match((noKey as { reason: string }).reason, /needs the "Mint agent keys" capability/);

  const admin = route();
  admin.resolved!.role = 'WORKSPACE_ADMIN';
  const adminNoKey = await resolveSeatKey(admin, 'dev', () => store);
  assert.match((adminNoKey as { reason: string }).reason, /run `crew agents sync`/);
});

test('a keychain write failure never prints the key, and the minted key is revoked', async () => {
  const store = memoryStore();
  let first = true;
  store.set = async (_h, _s, v) => {
    if (first) { first = false; return; } // the probe succeeds
    throw new Error(`Command failed: security add-generic-password -w {"apiKey":"${v.apiKey}"}\nUser interaction is not allowed.`);
  };
  const deletes: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (init.method === 'DELETE') { deletes.push(url); return new Response(null, { status: 204 }); }
    return new Response(JSON.stringify({ key: 'sk_secret', id: 'key-1' }), { status: 201 });
  }) as unknown as typeof fetch;
  const out = await mintMissingSeatKeys(route({ dev: 'agent-dev' }), { getStore: () => store, fetchImpl });
  const printed = out.map(describeMintOutcome).join('\n');
  assert.doesNotMatch(printed, /sk_secret|-w|Command failed/);
  assert.match(printed, /revoked/);
  assert.match(printed, /User interaction is not allowed/);
  assert.equal(deletes.length, 1);
  assert.match(deletes[0]!, /agents\/agent-dev\/api-keys\/key-1$/);
});

test('a failing keychain probe mints nothing', async () => {
  const store = memoryStore();
  store.set = async () => { throw new Error('Command failed: security -w sk_x\nUser interaction is not allowed.'); };
  let calls = 0;
  const fetchImpl = (async () => { calls++; return new Response('{}', { status: 201 }); }) as unknown as typeof fetch;
  const out = await mintMissingSeatKeys(route(), { getStore: () => store, fetchImpl });
  assert.equal(calls, 0);
  assert.ok(out.every((o) => o.action === 'failed' && !/sk_x|-w/.test(o.detail ?? '')));
});

test('a 403 from the mint endpoint is one forbidden outcome, with no further mints and nothing stored (CREW-1802)', async () => {
  const store = memoryStore();
  let calls = 0;
  const out = await mintMissingSeatKeys(route(), {
    getStore: () => store,
    fetchImpl: async () => { calls++; return new Response('{}', { status: 403 }); },
  });
  assert.equal(calls, 1);
  assert.deepEqual(out.map((o) => o.action), ['forbidden']);
  assert.match(describeMintOutcome(out[0]!), /does not grant "Mint agent keys"/);
  assert.equal(store.data.size, 0);
});

test('a member key that is granted the capability mints and stores every seat key (CREW-1802)', async () => {
  const store = memoryStore();
  const r = route();
  r.resolved!.role = 'WORKSPACE_USER';
  let n = 0;
  const out = await mintMissingSeatKeys(r, {
    getStore: () => store,
    fetchImpl: async () => new Response(JSON.stringify({ key: `sk_${++n}`, id: `kid-${n}` }), { status: 201 }),
  });
  assert.deepEqual(out.map((o) => o.action), ['minted', 'minted']);
  assert.equal((await resolveSeatKey(r, 'dev', () => store)).kind, 'agent');
  assert.equal((await resolveSeatKey(r, 'qa', () => store)).kind, 'agent');
});

test('a non-admin seat with no key is told to run sync and which capability it needs (CREW-1802)', async () => {
  const r = route();
  r.resolved!.role = 'WORKSPACE_USER';
  const id = await resolveSeatKey(r, 'dev', () => memoryStore());
  assert.equal(id.kind, 'ship');
  if (id.kind === 'ship') assert.match(id.reason, /crew agents sync.*Mint agent keys/);
});

test('revokeSeatKeys deletes each stored key server-side and clears it, then a sync mints fresh ones (CREW-1802)', async () => {
  const store = memoryStore();
  let n = 0;
  await mintMissingSeatKeys(route(), {
    getStore: () => store,
    fetchImpl: async () => new Response(JSON.stringify({ key: `sk_${++n}`, id: `kid-${n}` }), { status: 201 }),
  });
  const deleted: string[] = [];
  const out = await revokeSeatKeys(route(), {
    getStore: () => store,
    fetchImpl: async (url, init) => { assert.equal(init?.method, 'DELETE'); deleted.push(String(url).split('/').slice(-3).join('/')); return new Response(null, { status: 204 }); },
  });
  assert.deepEqual(out.map((o) => o.action), ['revoked', 'revoked']);
  assert.deepEqual(deleted, ['agent-dev/api-keys/kid-1', 'agent-qa/api-keys/kid-2']);
  assert.equal((await resolveSeatKey(route(), 'dev', () => store)).kind, 'ship');
  const again = await mintMissingSeatKeys(route(), {
    getStore: () => store,
    fetchImpl: async () => new Response(JSON.stringify({ key: 'sk_new', id: 'kid-9' }), { status: 201 }),
  });
  assert.deepEqual(again.map((o) => o.action), ['minted', 'minted']);
});

test('revokeSeatKeys keeps the keychain entry when the server refuses or no key id was recorded (CREW-1802)', async () => {
  const store = memoryStore();
  store.data.set('example.test/issues#agent:agent-dev', { apiKey: 'sk_old', workspaceId: 'ws-1', identityId: 'agent-dev', createdAt: 'x' });
  const noId = await revokeSeatKeys(route({ dev: 'agent-dev' }), { getStore: () => store, fetchImpl: async () => new Response(null, { status: 204 }) });
  assert.equal(noId[0]!.action, 'failed');
  assert.equal(store.data.size, 1);
});

test('canMintAgentKeys reads 200 as yes, 403 as no, anything else as unknown (CREW-1802)', async () => {
  const at = (status: number) => canMintAgentKeys(route(), { fetchImpl: async () => new Response('[]', { status }) });
  assert.equal(await at(200), true);
  assert.equal(await at(403), false);
  assert.equal(await at(500), undefined);
  assert.equal(await canMintAgentKeys({ ...route(), resolved: undefined } as Route), undefined);
});

test('a failed keychain read names the security exit code and stderr, never an argv or a secret', async () => {
  const canceled = Object.assign(new Error('Command failed: security find-generic-password -s x -a y -w\nUser canceled'), { code: 128, stderr: 'User canceled\n' });
  const r = await resolveSeatKey(route(), 'dev', () => { throw canceled; });
  assert.equal((r as { reason: string }).reason, 'OS keychain unavailable (security exited 128: User canceled)');
  const leaky = Object.assign(new Error('Command failed: security add-generic-password -w sk_secret'), { code: 1, stderr: 'security add-generic-password -w sk_secret\n' });
  const l = await resolveReleaseKey(releaseRoute('agent-release'), () => { throw leaky; });
  assert.equal((l as { reason: string }).reason, 'OS keychain unavailable (security exited 1)');
  assert.doesNotMatch(JSON.stringify(l), /sk_secret/);
});

// CREW-2628: the real DarwinKeychainSessionStore against a stubbed `security`
// that, like the real tool, prints any value holding a non-ASCII byte as hex.
test('a ship name with a typographic apostrophe round-trips through the real macOS keychain store', { skip: process.platform !== 'darwin' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-sec-'));
  const stub = join(dir, 'security');
  writeFileSync(stub, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const val = (f) => args[args.indexOf(f) + 1];
const file = path.join(${JSON.stringify(dir)}, Buffer.from(val('-a')).toString('hex'));
if (args[0] === 'add-generic-password') {
  fs.writeFileSync(file, Buffer.from(val('-w'), 'utf8'));
} else if (args[0] === 'find-generic-password') {
  if (!fs.existsSync(file)) { console.error('The specified item could not be found in the keychain.'); process.exit(44); }
  const raw = fs.readFileSync(file);
  console.log(raw.every((b) => b >= 0x20 && b < 0x7f) ? raw.toString('utf8') : raw.toString('hex'));
}
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    const getStore = () => getSessionStore();
    // An item crew 0.79.6 stored: raw UTF-8 with the ship name as `shipId`, which `security -w` reads back as hex.
    const slug = seatKeySlug('issues', 'agent-dev');
    execFileSync('security', ['add-generic-password', '-U', '-s', 'com.tablation.cli', '-a', `example.test/${slug}`, '-w',
      JSON.stringify({ apiKey: 'sk_agent_dev', shipId: 'Robin’s MacBook Pro', workspaceId: 'ws-1', identityId: 'agent-dev', createdAt: 'x' })]);
    assert.deepEqual(await resolveSeatKey(route(), 'dev', getStore), { kind: 'agent', apiKey: 'sk_agent_dev', agentId: 'agent-dev' });
    // A newly minted key is read back too, and an existing key is not re-minted.
    const fetchImpl = async () => new Response(JSON.stringify({ key: 'sk_agent_qa' }), { status: 201 });
    const out = await mintMissingSeatKeys(route(), { getStore, fetchImpl, shipName: 'Robin’s MacBook Pro' });
    assert.equal(out.find((o) => o.role === 'dev')?.action, 'already_stored');
    assert.deepEqual(await resolveSeatKey(route(), 'qa', getStore), { kind: 'agent', apiKey: 'sk_agent_qa', agentId: 'agent-qa' });
  } finally {
    process.env.PATH = oldPath;
  }
});

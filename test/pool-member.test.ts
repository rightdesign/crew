import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffMs, httpPoolApi, poolConfigFrom, runPoolMember, POOL_EXIT,
  type LeaseAnswer, type LeasePayload, type MemberFile, type PoolApi, type PoolMemberDeps, type PoolReply, type RegisterResponse, type StatusBody,
} from '../src/pool-member.ts';

const lease = (id = 'L1'): LeasePayload => ({
  id, shipName: 'pool-1', routes: [{ workspace: 'acme', project: 'issues' }], connectKey: 'sk_SECRET',
  forges: [{ host: 'github.com', token: 'ghp_SECRET' }], relayHost: 'crewd@relay.example', maxConcurrentAgents: 2,
});
const registerBody = (o: Partial<RegisterResponse> = {}): RegisterResponse => ({
  memberId: 'M1', instanceClassKey: 'c7.large', state: 'idle', leaseId: null, payloadDelivered: false, pollWaitSeconds: 30, ...o,
});

/** A scripted platform: register answers, then lease answers in order; once the script runs dry the member is told to retire. */
function world(o: {
  register?: Array<PoolReply<RegisterResponse>>;
  leases?: Array<PoolReply<LeaseAnswer | { code?: string; currentLeaseId?: string }> | Error>;
  statusReply?: (b: StatusBody) => PoolReply<{ memberState?: string }>;
  file?: MemberFile; shipConfig?: boolean;
  provision?: PoolMemberDeps['provision']; deprovision?: PoolMemberDeps['deprovision']; reconcile?: PoolMemberDeps['reconcile'];
  relayUrls?: Array<string | null>; stopAfterSleeps?: number;
} = {}) {
  const calls: string[] = [];
  const statuses: StatusBody[] = [];
  const polls: Array<string | undefined> = [];
  const registers = [...(o.register ?? [{ status: 200, body: registerBody() }])];
  const leases = [...(o.leases ?? [])];
  let file: MemberFile = { ...(o.file ?? {}) };
  let shipConfig = o.shipConfig ?? false;
  const relay = [...(o.relayUrls ?? [])];
  let sleeps = 0;
  const api: PoolApi = {
    async register() { calls.push('register'); return registers.shift() ?? registers[0] ?? { status: 409 }; },
    async lease(_w, leaseId) {
      polls.push(leaseId);
      const next = leases.shift();
      if (next instanceof Error) throw next;
      return next ?? { status: 200, body: { action: 'retire' } };
    },
    async status(b) { statuses.push(b); calls.push(`status:${b.state}`); return o.statusReply?.(b) ?? { status: 200, body: {} }; },
  };
  const deps: PoolMemberDeps = {
    api,
    store: { read: () => ({ ...file }), write: (f) => { file = { ...f }; } },
    host: { cloudInstanceId: 'i-1', architecture: 'x86_64', crewVersion: '0.100.2', hostname: 'h1' },
    hasShipConfig: () => shipConfig,
    async provision(l, cls, kind) {
      calls.push(`provision:${l.id}:${cls}:${kind}`);
      shipConfig = true;
      return o.provision ? o.provision(l, cls, kind) : { ok: true };
    },
    async reconcile() { calls.push('reconcile'); return o.reconcile ? o.reconcile() : { ok: true }; },
    async deprovision() { calls.push('deprovision'); shipConfig = false; return o.deprovision ? o.deprovision() : { ok: true }; },
    machineId: () => 'mach-1',
    relayUrl: () => (relay.length > 1 ? relay.shift()! : relay[0] ?? null),
    sleep: async () => { sleeps++; },
    log: () => {},
    stopping: () => o.stopAfterSleeps !== undefined && sleeps >= o.stopAfterSleeps,
  };
  return { deps, calls, statuses, polls, get file() { return file; } };
}

test('an idle member registers, reports unprovisioned and polls with no lease; retire ends it with 0', async () => {
  const w = world();
  assert.equal(await runPoolMember(w.deps), POOL_EXIT.ok);
  assert.deepEqual(w.calls, ['register', 'status:unprovisioned']);
  assert.deepEqual(w.polls, [undefined]);
  assert.equal(w.file.memberId, 'M1');
});

test('a 204 polls again at once; a provision action provisions, reports provisioning then running with machine id and relay url', async () => {
  const w = world({
    leases: [{ status: 204 }, { status: 200, body: { action: 'provision', lease: lease() } }],
    relayUrls: ['https://s.relay.example'],
  });
  assert.equal(await runPoolMember(w.deps), POOL_EXIT.ok);
  assert.deepEqual(w.calls, ['register', 'status:unprovisioned', 'status:provisioning', 'provision:L1:c7.large:pooled_instance', 'status:running']);
  const running = w.statuses.find((s) => s.state === 'running')!;
  assert.deepEqual([running.leaseId, running.machineId, running.relayUrl], ['L1', 'mach-1', 'https://s.relay.example']);
  assert.deepEqual(w.polls, [undefined, undefined, 'L1']);
  assert.equal(w.file.leaseId, 'L1');
});

test('the payload is never written to the member file or logged', async () => {
  const logged: string[] = [];
  const w = world({ leases: [{ status: 200, body: { action: 'provision', lease: lease() } }] });
  w.deps.log = (l) => { logged.push(l); };
  await runPoolMember(w.deps);
  assert.ok(!JSON.stringify(w.file).includes('SECRET'));
  assert.ok(!logged.join('\n').includes('SECRET'));
});

test('a failed provision reports failed with the reason and exits 1', async () => {
  const w = world({
    leases: [{ status: 200, body: { action: 'provision', lease: lease() } }],
    provision: async () => ({ ok: false, reason: 'connect exited 1' }),
  });
  assert.equal(await runPoolMember(w.deps), POOL_EXIT.failed);
  const f = w.statuses.at(-1)!;
  assert.deepEqual([f.state, f.leaseId, f.reason], ['failed', 'L1', 'connect exited 1']);
});

test('a release for the held lease wipes, reports wiping then unprovisioned, and goes back to waiting', async () => {
  const w = world({
    leases: [
      { status: 200, body: { action: 'provision', lease: lease() } },
      { status: 200, body: { action: 'release', leaseId: 'L1' } },
    ],
  });
  assert.equal(await runPoolMember(w.deps), POOL_EXIT.ok);
  assert.deepEqual(w.calls.slice(-4), ['status:running', 'status:wiping', 'deprovision', 'status:unprovisioned']);
  assert.equal(w.statuses.at(-1)!.state, 'unprovisioned');
  assert.equal(w.statuses.at(-1)!.leaseId, 'L1');
  assert.equal(w.file.leaseId, null);
  assert.equal(w.polls.at(-1), undefined);
});

test('a release naming another lease never wipes', async () => {
  const w = world({
    leases: [
      { status: 200, body: { action: 'provision', lease: lease() } },
      { status: 200, body: { action: 'release', leaseId: 'OLD' } },
    ],
  });
  await runPoolMember(w.deps);
  assert.ok(!w.calls.includes('deprovision'));
});

test('a failed wipe reports failed and stops polling', async () => {
  const w = world({
    leases: [
      { status: 200, body: { action: 'provision', lease: lease() } },
      { status: 200, body: { action: 'release', leaseId: 'L1' } },
    ],
    deprovision: async () => ({ ok: false, reason: 'volume crew-cache-1 remains' }),
  });
  assert.equal(await runPoolMember(w.deps), POOL_EXIT.failed);
  assert.equal(w.statuses.at(-1)!.state, 'failed');
  assert.ok(!w.statuses.some((s) => s.state === 'unprovisioned' && s.leaseId === 'L1'));
  assert.equal(w.polls.length, 2);
});

test('a second lease on the same host runs after a clean wipe', async () => {
  const w = world({
    leases: [
      { status: 200, body: { action: 'provision', lease: lease('L1') } },
      { status: 200, body: { action: 'release', leaseId: 'L1' } },
      { status: 200, body: { action: 'provision', lease: lease('L2') } },
    ],
  });
  await runPoolMember(w.deps);
  const order = w.calls.filter((c) => /^(provision|deprovision)/.test(c));
  assert.deepEqual(order, ['provision:L1:c7.large:pooled_instance', 'deprovision', 'provision:L2:c7.large:pooled_instance']);
});

test('LEASE_MISMATCH re-registers and follows the resume table', async () => {
  const w = world({
    register: [{ status: 200, body: registerBody() }, { status: 200, body: registerBody() }],
    leases: [{ status: 409, body: { code: 'LEASE_MISMATCH', currentLeaseId: 'L9' } }],
  });
  await runPoolMember(w.deps);
  assert.equal(w.calls.filter((c) => c === 'register').length, 2);
});

test('a retire action exits 0 and a 409 on register exits 0', async () => {
  assert.equal(await runPoolMember(world({ leases: [{ status: 200, body: { action: 'retire' } }] }).deps), POOL_EXIT.ok);
  const w = world({ register: [{ status: 409 }] });
  assert.equal(await runPoolMember(w.deps), POOL_EXIT.ok);
  assert.deepEqual(w.calls, ['register']);
});

test('401 on register or on the poll exits 2', async () => {
  assert.equal(await runPoolMember(world({ register: [{ status: 401 }] }).deps), POOL_EXIT.credential);
  assert.equal(await runPoolMember(world({ leases: [{ status: 401 }] }).deps), POOL_EXIT.credential);
});

test('network errors and 5xx back off and retry; the poll then carries on', async () => {
  const sleeps: number[] = [];
  const w = world({ leases: [new Error('ECONNRESET'), { status: 503 }, { status: 200, body: { action: 'retire' } }] });
  w.deps.sleep = async (ms) => { sleeps.push(ms); };
  assert.equal(await runPoolMember(w.deps), POOL_EXIT.ok);
  assert.deepEqual(sleeps, [5_000, 10_000]);
  assert.deepEqual([backoffMs(0), backoffMs(1), backoffMs(4), backoffMs(9)], [5_000, 10_000, 60_000, 60_000]);
});

test('a 409 on a status report is logged, not retried', async () => {
  const w = world({ statusReply: () => ({ status: 409 }) });
  assert.equal(await runPoolMember(w.deps), POOL_EXIT.ok);
  assert.equal(w.statuses.length, 1);
});

test('a relay url that appears after running is reported once', async () => {
  const w = world({
    leases: [{ status: 200, body: { action: 'provision', lease: lease() } }, { status: 204 }, { status: 204 }],
    relayUrls: [null, null, 'https://s.relay.example'],
  });
  await runPoolMember(w.deps);
  const running = w.statuses.filter((s) => s.state === 'running');
  assert.deepEqual(running.map((s) => s.relayUrl), [null, 'https://s.relay.example']);
});

test('self-upgrade runs only while unprovisioned', async () => {
  const w = world({ leases: [{ status: 204 }, { status: 200, body: { action: 'provision', lease: lease() } }, { status: 204 }] });
  let n = 0;
  w.deps.maybeSelfUpgrade = async () => { n++; };
  await runPoolMember(w.deps);
  assert.equal(n, 2); // before the first poll and the 204's repeat; none while holding L1
});

// --- the resume table -------------------------------------------------------

test('resume: idle with no lease and no crew.yaml polls', async () => {
  const w = world();
  await runPoolMember(w.deps);
  assert.ok(!w.calls.includes('deprovision'));
});

test('resume: idle but a lease or crew.yaml remains -> deprovision, report unprovisioned, poll', async () => {
  for (const o of [{ file: { leaseId: 'L1' } }, { shipConfig: true }]) {
    const w = world(o);
    await runPoolMember(w.deps);
    assert.deepEqual(w.calls.slice(0, 3), ['register', 'deprovision', 'status:unprovisioned']);
  }
});

test('resume: leased, payload not delivered -> polls and the provision action arrives', async () => {
  const w = world({
    register: [{ status: 200, body: registerBody({ state: 'leased', leaseId: 'L1', payloadDelivered: false }) }],
    leases: [{ status: 200, body: { action: 'provision', lease: lease() } }],
  });
  await runPoolMember(w.deps);
  assert.ok(w.calls.includes('provision:L1:c7.large:pooled_instance'));
  assert.ok(!w.calls.includes('deprovision'));
});

test('resume: leased, delivered, same local lease and crew.yaml -> reconcile, running, poll naming the lease', async () => {
  const w = world({
    register: [{ status: 200, body: registerBody({ state: 'leased', leaseId: 'L1', payloadDelivered: true }) }],
    file: { leaseId: 'L1' }, shipConfig: true,
  });
  await runPoolMember(w.deps);
  assert.deepEqual(w.calls.slice(0, 3), ['register', 'reconcile', 'status:running']);
  assert.deepEqual(w.polls, ['L1']);
});

test('resume: leased, delivered, no local record or another lease -> failed, exit 1', async () => {
  for (const file of [{}, { leaseId: 'OTHER' }]) {
    const w = world({ register: [{ status: 200, body: registerBody({ state: 'leased', leaseId: 'L1', payloadDelivered: true }) }], file, shipConfig: true });
    assert.equal(await runPoolMember(w.deps), POOL_EXIT.failed);
    assert.equal(w.statuses.at(-1)!.state, 'failed');
    assert.match(w.statuses.at(-1)!.reason ?? '', /lost/);
  }
});

test('resume: wiping -> deprovision, report unprovisioned for the released lease, poll', async () => {
  const w = world({ register: [{ status: 200, body: registerBody({ state: 'wiping', leaseId: 'L1' }) }], file: { leaseId: 'L1' }, shipConfig: true });
  await runPoolMember(w.deps);
  assert.deepEqual(w.calls.slice(0, 3), ['register', 'deprovision', 'status:unprovisioned']);
  assert.equal(w.statuses[0]!.leaseId, 'L1');
});

test('resume: retiring, retired and failed exit 0 without polling', async () => {
  for (const state of ['retiring', 'retired', 'failed']) {
    const w = world({ register: [{ status: 200, body: registerBody({ state }) }] });
    assert.equal(await runPoolMember(w.deps), POOL_EXIT.ok);
    assert.deepEqual(w.polls, []);
  }
});

// --- configuration and transport ---------------------------------------------

test('poolConfigFrom: flags win over the environment; a missing piece names itself', () => {
  assert.deepEqual(poolConfigFrom(['--url', 'https://p.example/'], { CREW_POOL_URL: 'https://old', CREW_POOL_TOKEN: 'env-token' }, () => ''), { url: 'https://p.example', token: 'env-token' });
  assert.deepEqual(poolConfigFrom(['--token-stdin'], { CREW_POOL_URL: 'https://p.example', CREW_POOL_TOKEN: 'env-token' }, () => 'stdin-token\n'), { url: 'https://p.example', token: 'stdin-token' });
  assert.match(poolConfigFrom([], { CREW_POOL_TOKEN: 't' }, () => '') as string, /platform URL/);
  assert.match(poolConfigFrom([], { CREW_POOL_URL: 'u' }, () => '') as string, /pool credential/);
});

test('the http client sends the bearer token in a header, the lease id and wait in the query, and reads 204', async () => {
  const seen: Array<{ url: string; auth: string | null; body: string | null; method: string }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: new Headers(init.headers).get('authorization'), body: (init.body as string | undefined) ?? null, method: init.method ?? 'GET' });
    if (url.includes('/lease')) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(registerBody()), { status: 200 });
  }) as unknown as typeof fetch;
  const api = httpPoolApi({ url: 'https://p.example', token: 'tok' }, fakeFetch);
  const reg = await api.register({ cloudInstanceId: 'i-1', architecture: 'arm64', crewVersion: '1', hostname: 'h' });
  const poll = await api.lease(30, 'L 1');
  assert.equal(reg.body?.memberId, 'M1');
  assert.equal(poll.status, 204);
  assert.equal(seen[0]!.url, 'https://p.example/pool-members/register');
  assert.equal(seen[1]!.url, 'https://p.example/pool-members/lease?wait=30&leaseId=L%201');
  assert.ok(seen.every((s) => s.auth === 'Bearer tok'));
  assert.ok(!seen.some((s) => (s.body ?? '').includes('tok')));
});

test('a register response naming managed_instance sets the ship kind passed to provision', async () => {
  const w = world({
    register: [{ status: 200, body: registerBody({ shipKind: 'managed_instance' }) }],
    leases: [{ status: 200, body: { action: 'provision', lease: lease() } }],
  });
  await runPoolMember(w.deps);
  assert.ok(w.calls.includes('provision:L1:c7.large:managed_instance'));
});

/**
 * `crew pool-member` (CREW-2882): the crew side of a pooled instance. A host
 * with no tenant registers with the platform, reports `unprovisioned`, and
 * long-polls for a lease. A lease payload makes it provision itself
 * (`provision.ts`); a release signal makes it wipe itself (`deprovision.ts`)
 * and go back to waiting. The wire contract is `docs/pool-member.md`.
 *
 * The loop is separated from the machine (`PoolMemberDeps`) like
 * `provision.ts`, so every poll action and every row of the resume table is
 * driven by a fake platform in `test/pool-member.test.ts`.
 *
 * The lease payload (connect key, forge tokens) lives only in memory: it is
 * never written to disk as a whole and never logged.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const POOL_EXIT = { ok: 0, failed: 1, credential: 2 } as const;

/** What the member reports to `POST /pool-members/status`. */
export type MemberState = 'unprovisioned' | 'provisioning' | 'running' | 'wiping' | 'failed';

export interface RegisterBody { cloudInstanceId: string; architecture: 'x86_64' | 'arm64'; crewVersion: string; hostname: string }

export interface RegisterResponse {
  memberId: string;
  instanceClassKey: string;
  /** `pooled_instance` or `managed_instance`; absent means `pooled_instance`. */
  shipKind?: 'pooled_instance' | 'managed_instance';
  /** The platform's member state: launching, idle, leased, wiping, retiring, retired, failed. */
  state: string;
  leaseId: string | null;
  payloadDelivered: boolean;
  pollWaitSeconds: number;
}

export interface LeasePayload {
  id: string;
  shipName: string;
  routes: Array<{ workspace: string; project: string; workspaceId?: string; projectId?: string }>;
  /** One admin workspace key per distinct workspace among the routes, minted for the lease. */
  connectKeys?: Array<{ workspaceId?: string; workspace: string; key: string }>;
  /** Older platform builds: one key for every route. */
  connectKey?: string;
  forges: Array<{ host: string; token: string }>;
  relayHost?: string;
  maxConcurrentAgents?: number;
}

export type LeaseAnswer =
  | { action: 'provision'; lease: LeasePayload }
  | { action: 'tokens'; leaseId: string; forges: Array<{ host: string; token: string }> }
  | { action: 'release'; leaseId: string }
  | { action: 'retire' };

export interface StatusBody {
  state: MemberState;
  leaseId: string | null;
  machineId: string | null;
  relayUrl: string | null;
  reason: string | null;
  crewVersion: string;
  /** Agent runs in progress on the ship, across all routes (CREW-2906). Sent with `running` only; an older crew omits it. */
  activeRuns?: number;
  /** ISO time the most recent run finished; null when none has. Sent with `activeRuns`. */
  lastRunEndedAt?: string | null;
  /** Forge hosts git asked the credential helper for and got no token (CREW-2903). Sent with `running` only; empty clears it. */
  missingForgeHosts?: Array<{ host: string; lastMissAt: string }>;
}

/** An HTTP answer reduced to what the loop decides on. A transport failure is a thrown error instead. */
export interface PoolReply<T> { status: number; body?: T }

export interface PoolApi {
  register(body: RegisterBody): Promise<PoolReply<RegisterResponse>>;
  /** `leaseId` is the lease the member holds, or undefined. */
  lease(waitSeconds: number, leaseId: string | undefined): Promise<PoolReply<LeaseAnswer | { code?: string; currentLeaseId?: string }>>;
  status(body: StatusBody): Promise<PoolReply<{ memberState?: string; leaseState?: string }>>;
}

/** The member's own small state file (outside the ship's state directory, so a wipe never removes it). */
export interface MemberFile { memberId?: string; leaseId?: string | null; lastState?: MemberState }

export interface MemberStore { read(): MemberFile; write(f: MemberFile): void }

export interface ProvisionResult { ok: boolean; reason?: string }

export interface PoolMemberDeps {
  api: PoolApi;
  store: MemberStore;
  host: RegisterBody;
  /** crew.yaml exists on this host: a tenant (or a failed attempt at one) left something behind. */
  hasShipConfig(): boolean;
  /** Runs the provision path for a lease, `--ship-kind <shipKind> --instance-class <key>`. */
  provision(lease: LeasePayload, instanceClass: string, shipKind: string): Promise<ProvisionResult>;
  /** Brings an already-provisioned host back to running (units, routes, daemon) without a payload. */
  reconcile(): Promise<ProvisionResult>;
  /** CREW-2902: replaces the stored forge tokens with exactly this set; hosts absent from it lose their token. */
  applyTokens(forges: Array<{ host: string; token: string }>): Promise<ProvisionResult>;
  /** `crew deprovision`: true only after the host verified clean. */
  deprovision(): Promise<ProvisionResult>;
  /** This ship's hashed machine id and the tunnel URL, once known. */
  machineId(): string | null;
  relayUrl(): string | null;
  /** The forge hosts the credential helper could not answer; absent on a host that does not track them. */
  missingForgeHosts?(): Array<{ host: string; lastMissAt: string }>;
  /** Run activity read from the daemon's own bookkeeping (CREW-2906); absent means the fields are not reported. */
  activity?(): { activeRuns: number; lastRunEndedAt: string | null };
  /**
   * Calls `onTick` on a short cadence until the returned stop function runs. The loop uses it to notice
   * activity flipping between zero and non-zero while a long poll is in flight.
   */
  watch?(onTick: () => void): () => void;
  /** Called while `unprovisioned` only, before each poll: CREW-2797's self-upgrade call site. */
  maybeSelfUpgrade?(): Promise<void>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  /** True once a signal asked the command to stop. */
  stopping(): boolean;
}

/** 5 s doubling to 60 s, for a network error or a 5xx. A 204 never backs off. */
export function backoffMs(attempt: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, attempt));
}

export const DEFAULT_POLL_WAIT_SECONDS = 30;

export async function runPoolMember(deps: PoolMemberDeps): Promise<number> {
  let failures = 0;
  /** Retries a call on a transport error or 5xx; returns the first usable reply, or null when asked to stop. */
  const settle = async <T>(what: string, call: () => Promise<PoolReply<T>>): Promise<PoolReply<T> | null> => {
    for (;;) {
      if (deps.stopping()) return null;
      try {
        const r = await call();
        if (r.status < 500) { failures = 0; return r; }
        deps.log(`${what}: platform answered ${r.status}; retrying`);
      } catch (e) {
        deps.log(`${what}: ${(e as Error).message}; retrying`);
      }
      await deps.sleep(backoffMs(failures++));
    }
  };

  let reported: StatusBody | undefined;
  /** Whether the last `running` report said a run was in progress. */
  let busy = false;
  /** A status report. A 409 is an illegal transition: logged, not retried. 401 ends the command. */
  const report = async (state: MemberState, o: { leaseId?: string | null; reason?: string } = {}): Promise<'ok' | 'credential' | 'stopped'> => {
    const body: StatusBody = {
      state, leaseId: o.leaseId ?? null,
      machineId: state === 'running' ? deps.machineId() : null,
      relayUrl: state === 'running' ? deps.relayUrl() : null,
      reason: o.reason ?? null, crewVersion: deps.host.crewVersion,
    };
    const act = state === 'running' ? deps.activity?.() : undefined;
    if (act) { body.activeRuns = act.activeRuns; body.lastRunEndedAt = act.lastRunEndedAt; }
    if (act) busy = act.activeRuns > 0;
    if (state === 'running' && deps.missingForgeHosts) body.missingForgeHosts = deps.missingForgeHosts();
    const r = await settle('status', () => deps.api.status(body));
    if (!r) return 'stopped';
    if (r.status === 401) return 'credential';
    if (r.status === 409) deps.log(`status ${state}: the platform refused the transition (409); not retrying`);
    else if (r.status >= 400) deps.log(`status ${state}: platform answered ${r.status}; not retrying`);
    reported = body;
    deps.store.write({ ...deps.store.read(), lastState: state });
    return 'ok';
  };

  const fail = async (leaseId: string | null, reason: string): Promise<number> => {
    deps.log(`failed: ${reason}`);
    await report('failed', { leaseId, reason });
    return POOL_EXIT.failed;
  };

  /** Wipes the host and reports `unprovisioned`; null on success, else the exit code. */
  const wipeThenUnprovisioned = async (leaseId: string | null, announce: boolean): Promise<number | null> => {
    if (announce) {
      const w = await report('wiping', { leaseId });
      if (w === 'credential') return POOL_EXIT.credential;
      if (w === 'stopped') return POOL_EXIT.ok;
    }
    const wiped = await deps.deprovision();
    if (!wiped.ok) return fail(leaseId, wiped.reason ?? 'the wipe left the lease behind');
    deps.store.write({ ...deps.store.read(), leaseId: null });
    const u = await report('unprovisioned', { leaseId });
    if (u === 'credential') return POOL_EXIT.credential;
    return null;
  };

  for (;;) {
    // --- register, and resume from whatever state the host was left in ---------------------------------
    const reg = await settle('register', () => deps.api.register(deps.host));
    if (!reg) return POOL_EXIT.ok;
    if (reg.status === 401) { deps.log('the pool credential is unknown or revoked (401)'); return POOL_EXIT.credential; }
    if (reg.status === 409) { deps.log('the platform is retiring this member (409); stopping'); return POOL_EXIT.ok; }
    if (reg.status !== 200 || !reg.body) { deps.log(`register: unexpected ${reg.status}`); await deps.sleep(backoffMs(failures++)); continue; }
    const platform = reg.body;
    const local = deps.store.read();
    deps.store.write({ ...local, memberId: platform.memberId });
    deps.log(`registered as member ${platform.memberId} (${platform.instanceClassKey}); platform state ${platform.state}`);

    let current: string | null = null;
    const leftovers = deps.hasShipConfig() || !!local.leaseId;
    switch (platform.state) {
      case 'retiring': case 'retired': case 'failed':
        return POOL_EXIT.ok;
      case 'wiping': {
        const code = await wipeThenUnprovisioned(platform.leaseId ?? local.leaseId ?? null, false);
        if (code !== null) return code;
        break;
      }
      case 'leased': {
        if (!platform.payloadDelivered) {
          // The provision action will arrive. Anything an earlier lease left is wiped first, so this one starts clean.
          if (leftovers) { const code = await wipeThenUnprovisioned(null, false); if (code !== null) return code; }
          break;
        }
        if (local.leaseId && local.leaseId === platform.leaseId && deps.hasShipConfig()) {
          const rec = await deps.reconcile();
          if (!rec.ok) return fail(platform.leaseId, rec.reason ?? 'could not bring the lease back up after a restart');
          const r = await report('running', { leaseId: platform.leaseId });
          if (r === 'credential') return POOL_EXIT.credential;
          if (r === 'stopped') return POOL_EXIT.ok;
          current = platform.leaseId;
          break;
        }
        // Delivered once and never repeated: with no local record of it, the payload is gone.
        return fail(platform.leaseId, 'the lease payload was delivered to a previous process and is lost');
      }
      default: { // idle, launching
        if (leftovers) { const code = await wipeThenUnprovisioned(null, false); if (code !== null) return code; }
        const r = await report('unprovisioned');
        if (r === 'credential') return POOL_EXIT.credential;
        if (r === 'stopped') return POOL_EXIT.ok;
      }
    }

    // --- the long poll ---------------------------------------------------------------------------------
    let relayReported = reported?.state === 'running' ? reported.relayUrl : null;
    let reregister = false;
    while (!reregister) {
      if (deps.stopping()) return POOL_EXIT.ok;
      if (!current) await deps.maybeSelfUpgrade?.().catch((e: Error) => { deps.log(`self-upgrade: ${e.message}`); });
      // While a lease is held, a run starting or ending is reported at once rather than at the poll's end.
      let stopWatch: (() => void) | undefined;
      let flipping = false;
      if (current && deps.watch && deps.activity) {
        const held = current;
        stopWatch = deps.watch(() => {
          const now = deps.activity!().activeRuns > 0;
          if (flipping || now === busy) return;
          flipping = true;
          void report('running', { leaseId: held }).catch(() => undefined).finally(() => { flipping = false; });
        });
      }
      let ans: PoolReply<LeaseAnswer | { code?: string; currentLeaseId?: string }> | null;
      try { ans = await settle('lease', () => deps.api.lease(platform.pollWaitSeconds || DEFAULT_POLL_WAIT_SECONDS, current ?? undefined)); }
      finally { stopWatch?.(); }
      if (!ans) return POOL_EXIT.ok;
      if (ans.status === 401) { deps.log('the pool credential is unknown or revoked (401)'); return POOL_EXIT.credential; }
      if (ans.status === 409) { deps.log('the platform says this is not the member\'s current lease (409); re-registering'); reregister = true; continue; }
      if (ans.status === 204) {
        // The tunnel comes up after provision returns; fill the URL in once it exists.
        const url = current ? deps.relayUrl() : null;
        if (current && (url !== relayReported && url || deps.activity || deps.missingForgeHosts)) {
          const r = await report('running', { leaseId: current });
          if (r === 'credential') return POOL_EXIT.credential;
          relayReported = url ?? relayReported;
        }
        continue;
      }
      const body = ans.body as LeaseAnswer | undefined;
      if (ans.status !== 200 || !body || !('action' in body)) { deps.log(`lease: unexpected ${ans.status}`); await deps.sleep(backoffMs(failures++)); continue; }

      if (body.action === 'retire') { deps.log('retiring on the platform\'s signal'); return POOL_EXIT.ok; }

      if (body.action === 'release') {
        if (body.leaseId !== current) { deps.log(`ignoring a release for ${body.leaseId}; this member holds ${current ?? 'no lease'}`); continue; }
        const code = await wipeThenUnprovisioned(body.leaseId, true);
        if (code !== null) return code;
        current = null;
        relayReported = null;
        continue;
      }

      if (body.action === 'tokens') {
        // Like a release, a tokens message for a lease this member does not hold is ignored.
        if (body.leaseId !== current) { deps.log(`ignoring a tokens message for ${body.leaseId}; this member holds ${current ?? 'no lease'}`); continue; }
        const applied = await deps.applyTokens(body.forges ?? []);
        if (!applied.ok) { deps.log(`tokens: ${applied.reason ?? 'could not apply the delivered forge tokens'}`); continue; }
        deps.log(`tokens: replaced the forge tokens (${(body.forges ?? []).length} host${(body.forges ?? []).length === 1 ? '' : 's'})`);
        // The platform treats the next status report as the acknowledgement.
        const r = await report('running', { leaseId: current });
        if (r === 'credential') return POOL_EXIT.credential;
        if (r === 'stopped') return POOL_EXIT.ok;
        continue;
      }

      // provision
      if (current) { deps.log('ignoring a provision payload: a lease is already held'); continue; }
      const lease = body.lease;
      // The id is recorded before anything is written, so a restart mid-provision wipes rather than guesses.
      deps.store.write({ ...deps.store.read(), leaseId: lease.id });
      let r = await report('provisioning', { leaseId: lease.id });
      if (r === 'credential') return POOL_EXIT.credential;
      if (r === 'stopped') return POOL_EXIT.ok;
      const done = await deps.provision(lease, platform.instanceClassKey, platform.shipKind ?? 'pooled_instance');
      if (!done.ok) return fail(lease.id, done.reason ?? 'provisioning failed');
      r = await report('running', { leaseId: lease.id });
      if (r === 'credential') return POOL_EXIT.credential;
      current = lease.id;
      relayReported = deps.relayUrl();
    }
  }
}

// --- the real machine ------------------------------------------------------

/** Where the member keeps its own identity: outside the ship's state directory so `crew deprovision` never removes it. */
export function defaultMemberDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CREW_POOL_DIR ?? join(env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'crew-pool-member');
}

export function fileMemberStore(dir: string): MemberStore {
  const file = join(dir, 'member.json');
  return {
    read() {
      try { return JSON.parse(readFileSync(file, 'utf8')) as MemberFile; } catch { return {}; }
    },
    write(f) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(f)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
    },
  };
}

export interface PoolConfig { url: string; token: string }

/** `CREW_POOL_URL` / `CREW_POOL_TOKEN`, or `--url` / `--token-stdin`; flags win. A message when something is missing. */
export function poolConfigFrom(
  argv: readonly string[], env: NodeJS.ProcessEnv, readStdin: () => string,
): PoolConfig | string {
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    if (i >= 0) return argv[i + 1];
    return argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  };
  const url = (flag('url') ?? env.CREW_POOL_URL ?? '').trim().replace(/\/+$/, '');
  const token = (argv.includes('--token-stdin') ? readStdin() : env.CREW_POOL_TOKEN ?? '').trim();
  if (!url) return 'no platform URL: pass --url or set CREW_POOL_URL';
  if (!token) return 'no pool credential: pass --token-stdin or set CREW_POOL_TOKEN';
  return { url, token };
}

/** The platform API over `fetch`. The token goes in the Authorization header only. */
export function httpPoolApi(c: PoolConfig, fetchFn: typeof fetch = fetch, userAgent = 'crew-pool-member'): PoolApi {
  const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 20_000): Promise<PoolReply<T>> => {
    const res = await fetchFn(`${c.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${c.token}`, 'user-agent': userAgent,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 204) return { status: 204 };
    const text = await res.text();
    let parsed: T | undefined;
    try { parsed = text ? JSON.parse(text) as T : undefined; } catch { parsed = undefined; }
    return { status: res.status, body: parsed };
  };
  return {
    register: (b) => call('POST', '/pool-members/register', b),
    lease: (wait, leaseId) =>
      call('GET', `/pool-members/lease?wait=${wait}${leaseId ? `&leaseId=${encodeURIComponent(leaseId)}` : ''}`, undefined, (wait + 15) * 1000),
    status: (b) => call('POST', '/pool-members/status', b),
  };
}

export function hostArchitecture(arch: string = process.arch): 'x86_64' | 'arm64' {
  return arch === 'arm64' ? 'arm64' : 'x86_64';
}

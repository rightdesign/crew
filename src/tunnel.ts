/**
 * The Host Passengers tunnel client (ISSUE-553, CREW_PRD.md §9.9, README.md in
 * the crew-relay repo). Shells out to the REAL `ssh` binary rather than a
 * library like `ssh2` — the PRD's own spike note (§9.9) is that the real
 * binary needed a real interop fix distinct from what worked `ssh2`-to-`ssh2`,
 * so this client's own fidelity comes from running literally the same command
 * a person would type by hand:
 *
 *   ssh -N -p <relayPort> -R <bindAddr>:0:127.0.0.1:<localPort> <relayHost>
 *
 * `-N`: no remote command, this connection exists purely to hold the
 * forward open. The bind address is advisory to the SSH protocol (RFC 4254
 * §7.1 doesn't require it name a real interface), which is what lets it ride
 * to the relay as routing metadata. It is the v2 format (CREW-1320, the other
 * half of crew-relay's CREW-1319 parser — keep the two in lockstep):
 *
 *   workspace-<uuid>-slug-<12 [a-z0-9]>-key-<routeApiKey>[-secret-<mcpSecret>]
 *
 * The slug is OWNED BY THIS SHIP: generated once per workspace and persisted
 * in `<stateDir>/passengers/<workspaceId>.json`, so the public URL is stable
 * across reconnects; `crew rotate-passenger-url` replaces it. The key is the
 * route's own API key, which the relay validates through `/auth/me`; it
 * travels only inside the encrypted SSH session, and nothing in this repo
 * may log an ssh argv (the `-R` argument carries it). `-secret-` is the
 * container's own identity secret (ISSUE-685), optional, hex — the relay
 * finds it by the LAST `-secret-` marker, since API keys may contain `-`.
 * No colons anywhere: ssh splits `-R` on them.
 *
 * Publishing the URL is not done here: once a tunnel settles `connected`,
 * `mcp-endpoint-registry.ts` registers it as a workspace MCP endpoint with
 * the route's own key.
 *
 * There is no live relay to test this against — every test here injects a
 * fake `spawn`, asserting this module builds the right argv and reacts
 * correctly to a fake child process's stdout/exit, not that a real tunnel
 * actually comes up.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import type { ContainerPlan } from './passenger-containers.ts';

export type TunnelStatus = 'connecting' | 'connected' | 'disconnected';

export type SpawnFn = (cmd: string, args: string[]) => ChildProcess;

// `detached: true` + fully `'ignore'`d stdio (ISSUE-680) — matches
// `passenger-sync-daemon.ts`'s own `defaultSpawn`, the proven shape for
// anything that has to outlive the short-lived invocation that spawned it
// (the `passengers` unit as of ISSUE-677, or a manual `rotate-passenger-url`
// run — never a daemon). An earlier version of this piped stderr back to the parent so
// `startTunnel` could detect the "Allocated port" line immediately — that
// pipe's read end closes the instant the short-lived parent exits, and a
// detached child writing to it afterward can die (confirmed live: both
// `detached: true` alone AND a piped stderr still left the ssh child dead
// moments after the parent exited). No pipe at all sidesteps that
// entirely; `syncPassengerTunnels`'s existing "promote a still-connecting
// tunnel to connected once it has survived a cycle" logic is what confirms
// connection now, not an immediate in-process signal.
/** Pulled out to its own constant so a test can assert on it without mocking `node:child_process`. */
export const DEFAULT_SPAWN_OPTIONS: SpawnOptions = { stdio: 'ignore', detached: true };
const defaultSpawn: SpawnFn = (cmd, args) => spawn(cmd, args, DEFAULT_SPAWN_OPTIONS);

export interface TunnelOptions {
  /** e.g. `crewd@ships.tablation.dev` — `Ship.relayHost`. */
  relayHost: string;
  /** The port `relayHost` listens for `ssh -R` on — `Ship.relayPort` (ISSUE-681). */
  relayPort: number;
  workspaceId: string;
  /** This ship's stable public label for the workspace (see header); 12 chars `[a-z0-9]`. */
  slug: string;
  /** The route's own API key — the relay's entitlement check. Never logged. */
  apiKey: string;
  /** The Host Passengers container's published port on this host. */
  localPort: number;
  privateKeyPath: string;
  /**
   * This container's own identity secret (ISSUE-685) — the same value
   * passed to it as `PASSENGER_MCP_SECRET` at `docker run` time
   * (`passenger-containers.ts`'s `startContainer`, sourced from
   * `syncPassengerSyncDaemons`'s per-container secret). Undefined whenever
   * that secret isn't available for this workspace (e.g. the sync daemon
   * didn't start) — the tunnel still opens, just without the extra
   * credential riding along; `passenger-mcp.ts`'s real-API-key path is the
   * fallback for that case.
   */
  mcpSecret?: string;
  onStatus?: (status: TunnelStatus) => void;
  spawnFn?: SpawnFn;
}

export interface Tunnel {
  readonly status: TunnelStatus;
  /** The underlying `ssh` process's pid — undefined only if `spawn` itself never assigned one. */
  readonly pid: number | undefined;
  stop(): void;
}

const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SLUG_LENGTH = 12;

export function generateTunnelSlug(): string {
  let out = '';
  for (let i = 0; i < SLUG_LENGTH; i++) out += SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)];
  return out;
}

/**
 * `-slug-`, `-key-` and `-secret-` are literal markers, not generic
 * delimiters — a workspace id (a UUID) already contains hyphens of its own,
 * so splitting on any bare `-` would be ambiguous. The relay's parser
 * (crew-relay `parseBindAddr`) parses positionally: uuid is 36 chars, slug is
 * 12, the key runs to the LAST `-secret-`.
 */
export function bindAddrFor(o: Pick<TunnelOptions, 'workspaceId' | 'slug' | 'apiKey' | 'mcpSecret'>): string {
  const base = `workspace-${o.workspaceId}-slug-${o.slug}-key-${o.apiKey}`;
  return o.mcpSecret ? `${base}-secret-${o.mcpSecret}` : base;
}

/**
 * The public MCP URL for a slug: `https://<slug>.<domain>[:<httpPort>]/mcp`.
 * The domain is `ship.relayPublicDomain` when set, else the host part of
 * `relayHost` (`crewd@ships.example.com` -> `ships.example.com`).
 */
export function publicUrlFor(
  slug: string, relayHost: string, relayHttpPort: number, relayPublicDomain?: string,
): string {
  const domain = relayPublicDomain ?? relayHost.replace(/^.*@/, '');
  return `https://${slug}.${domain}${relayHttpPort === 443 ? '' : `:${relayHttpPort}`}/mcp`;
}

export function sshArgsFor(
  o: Pick<TunnelOptions, 'relayHost' | 'relayPort' | 'workspaceId' | 'slug' | 'apiKey' | 'localPort' | 'privateKeyPath' | 'mcpSecret'>,
): string[] {
  return [
    '-N',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-i', o.privateKeyPath,
    '-p', String(o.relayPort),
    '-R', `${bindAddrFor(o)}:0:127.0.0.1:${o.localPort}`,
    o.relayHost,
  ];
}

/**
 * Starts one tunnel, one `ssh` child process per call — the caller
 * (`passenger-containers.ts`'s sync loop, via cli.ts) is responsible for
 * calling this at most once per running container and calling `.stop()`
 * before starting a replacement, never running two tunnels for the same
 * workspace at once.
 */
export function startTunnel(opts: TunnelOptions): Tunnel {
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  let status: TunnelStatus = 'connecting';
  opts.onStatus?.('connecting');

  const child = spawnFn('ssh', sshArgsFor(opts));
  // Same reasoning as `defaultSpawn`'s `detached: true` (ISSUE-680): don't
  // let this child keep the spawning process's event loop — and therefore
  // the whole process — alive until the tunnel itself exits. A test-injected
  // `spawnFn` may return a fake without a real `.unref()`; guard for that.
  child.unref?.();
  // No stderr-based "connected" detection any more (ISSUE-680) — stdio is
  // fully 'ignore'd now, so the only way this settles as 'connected' is
  // `syncPassengerTunnels` finding the pid still alive on a later cycle.
  // These two listeners only matter for a fast, synchronous failure within
  // THIS cycle (spawn itself erroring, or the child exiting immediately).
  child.on('exit', () => {
    if (status !== 'disconnected') {
      status = 'disconnected';
      opts.onStatus?.('disconnected');
    }
  });
  child.on('error', () => {
    if (status !== 'disconnected') {
      status = 'disconnected';
      opts.onStatus?.('disconnected');
    }
  });

  return {
    get status() { return status; },
    pid: child.pid,
    stop() { child.kill('SIGTERM'); },
  };
}

/**
 * Persisted across `passengers` unit invocations (ISSUE-677) — each is its
 * own short-lived process (a systemd/launchd timer, not a daemon loop; see
 * `install.ts`), so a tunnel's actual `ssh` child has to be spawned
 * DETACHED and tracked by pid in a state file, the same way nothing else
 * in this repo holds a live handle across cycles. One file per workspace:
 * `<stateDir>/passengers/<workspaceId>.json`.
 */
export interface PersistedTunnel {
  pid: number;
  containerName: string;
  workspaceId: string;
  mountsHash: string;
  startedAt: string;
  status: TunnelStatus;
  /** The PASSENGER_MCP_SECRET (ISSUE-685) this tunnel's own `-R` bind address was actually started with, if any (ISSUE-696) — compared each cycle against the freshly-resolved `mcpSecrets` map so a drifted secret gets caught the same way a `mountsHash` change does. */
  mcpSecret?: string;
  /** This ship's stable slug for the workspace (CREW-1320); outlives respawns, replaced only by a rotation. */
  slug?: string;
  /** The slug the live `ssh` was actually started with — differs from `slug` after a rotation, which is what forces the respawn. */
  liveSlug?: string;
  /** The workspace MCP endpoint row registered for this tunnel, if any. */
  endpointId?: string;
  /** Hash of the URL + header the endpoint was last registered with, so an unchanged cycle makes no call. */
  registeredKey?: string;
}

function tunnelStatePath(stateDir: string, workspaceId: string): string {
  return join(stateDir, 'passengers', `${workspaceId}.json`);
}

export function readPersistedTunnel(stateDir: string, workspaceId: string): PersistedTunnel | undefined {
  const path = tunnelStatePath(stateDir, workspaceId);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PersistedTunnel;
  } catch {
    return undefined;
  }
}

function writePersistedTunnel(stateDir: string, state: PersistedTunnel): void {
  const path = tunnelStatePath(stateDir, state.workspaceId);
  mkdirSync(join(stateDir, 'passengers'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** Merges `patch` into an existing persisted tunnel; a no-op if there is none. */
export function updatePersistedTunnel(stateDir: string, workspaceId: string, patch: Partial<PersistedTunnel>): void {
  const existing = readPersistedTunnel(stateDir, workspaceId);
  if (existing) writePersistedTunnel(stateDir, { ...existing, ...patch });
}

/** Gives the workspace a fresh slug (`crew rotate-passenger-url`); the next sync respawns the tunnel under it. */
export function rotatePersistedSlug(stateDir: string, workspaceId: string): void {
  updatePersistedTunnel(stateDir, workspaceId, { slug: generateTunnelSlug() });
}

function removePersistedTunnel(stateDir: string, workspaceId: string): void {
  const path = tunnelStatePath(stateDir, workspaceId);
  try { unlinkSync(path); } catch { /* already gone */ }
}

/** `process.kill(pid, 0)` — throws if the pid is gone, signals nothing if it's alive. */
export function isPidAlive(pid: number): boolean {
  try { return process.kill(pid, 0); } catch { return false; }
}

export interface SyncTunnelsDeps {
  spawnFn?: SpawnFn;
  isPidAlive?: (pid: number) => boolean;
  /**
   * Reports each workspace's settled status this cycle, for the caller to write onto the Ships row.
   * `info` is the persisted state as of the report (for a torn-down tunnel, the state just removed),
   * so a caller can still find the `endpointId` it has to delete.
   */
  onStatus?: (workspaceId: string, status: TunnelStatus, info: PersistedTunnel | undefined) => void;
  /** workspaceId -> the route's API key. A workspace without one gets no tunnel (reported `disconnected`). */
  apiKeys?: Map<string, string>;
}

/**
 * Reconciles running tunnels against `plans` (one `ContainerPlan` per
 * workspace this ship should be hosting passengers for — see
 * `passenger-containers.ts`'s `planContainers`), the way
 * `syncPassengerContainers` reconciles Docker containers:
 *
 * - no persisted tunnel, or its pid is dead, or its mounts have changed
 *   (the container behind it was recreated), or its own secret has drifted
 *   from the freshly-resolved `mcpSecrets` entry (ISSUE-696 — the container
 *   behind it was recreated with a new `PASSENGER_MCP_SECRET` but this
 *   tunnel's `-R` bind address still carries the old one, so the container
 *   would 401 every real request despite the tunnel itself looking healthy)
 *   -> (re)spawn, persist the new pid, report whatever status `startTunnel`
 *   settles on immediately.
 * - persisted tunnel, pid alive, mounts AND secret unchanged -> nothing to
 *   do beyond promoting a still-`connecting` status to `connected` (an
 *   alive `ssh -N
 *   ... -o ExitOnForwardFailure=yes` process that has survived past the
 *   cycle it was spawned in has, by construction, not had its forward
 *   request rejected — `ExitOnForwardFailure` is exactly what makes
 *   "still running" a meaningful proxy for "the forward succeeded" once the
 *   stderr stream from the spawning process is long gone).
 * - a persisted tunnel for a workspace no longer in `plans` -> kill it,
 *   drop its state file, report `disconnected`.
 *
 * `relayHost` undefined means Host Passengers containers still run, just
 * with no tunnel — the caller (cli.ts) skips calling this entirely in that
 * case and `crew doctor` says so; this function itself has no opinion on
 * that, it just needs a host to dial when called.
 */
export function syncPassengerTunnels(
  plans: ContainerPlan[],
  relayHost: string,
  relayPort: number,
  privateKeyPath: string,
  stateDir: string,
  /** workspaceId -> this container's PASSENGER_MCP_SECRET (ISSUE-685) — from `syncPassengerSyncDaemons`'s resolved endpoints. Missing entries just spawn without one. */
  mcpSecrets: Map<string, string> = new Map(),
  deps: SyncTunnelsDeps = {},
): void {
  const alive = deps.isPidAlive ?? isPidAlive;
  const plannedIds = new Set(plans.map((p) => p.workspaceId));

  for (const plan of plans) {
    const existing = readPersistedTunnel(stateDir, plan.workspaceId);
    const currentSecret = mcpSecrets.get(plan.workspaceId);
    const secretUnchanged = (existing?.mcpSecret ?? undefined) === (currentSecret ?? undefined);
    const slug = existing?.slug ?? generateTunnelSlug();
    const slugUnchanged = existing?.liveSlug === slug;
    if (existing && alive(existing.pid) && existing.mountsHash === plan.mountsHash && secretUnchanged && slugUnchanged) {
      if (existing.status === 'connecting') {
        const settled: PersistedTunnel = { ...existing, status: 'connected' };
        writePersistedTunnel(stateDir, settled);
        deps.onStatus?.(plan.workspaceId, 'connected', settled);
      }
      continue;
    }
    if (existing && alive(existing.pid)) {
      // Mounts changed under it (the container was recreated), its
      // secret drifted from the container's own (ISSUE-696), or its slug was
      // rotated — either way the old tunnel no longer matches.
      try { process.kill(existing.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    const apiKey = deps.apiKeys?.get(plan.workspaceId);
    if (!apiKey) {
      // The relay's entitlement check needs the route's key; without one a
      // tunnel could only be rejected. Leave no state behind for it.
      deps.onStatus?.(plan.workspaceId, 'disconnected', existing);
      continue;
    }
    let settledStatus: TunnelStatus = 'connecting';
    const tunnel = startTunnel({
      relayHost, relayPort, workspaceId: plan.workspaceId, slug, apiKey, localPort: plan.port, privateKeyPath,
      mcpSecret: currentSecret,
      spawnFn: deps.spawnFn, onStatus: (s) => { settledStatus = s; },
    });
    const started: PersistedTunnel = {
      pid: tunnel.pid ?? -1,
      containerName: plan.containerName,
      workspaceId: plan.workspaceId,
      mountsHash: plan.mountsHash,
      startedAt: new Date().toISOString(),
      status: settledStatus,
      mcpSecret: currentSecret,
      slug,
      liveSlug: slug,
      endpointId: existing?.endpointId,
      registeredKey: existing?.registeredKey,
    };
    writePersistedTunnel(stateDir, started);
    deps.onStatus?.(plan.workspaceId, settledStatus, started);
  }

  for (const workspaceId of readAllPersistedWorkspaceIds(stateDir)) {
    if (plannedIds.has(workspaceId)) continue;
    const existing = readPersistedTunnel(stateDir, workspaceId);
    if (existing && alive(existing.pid)) {
      try { process.kill(existing.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    removePersistedTunnel(stateDir, workspaceId);
    deps.onStatus?.(workspaceId, 'disconnected', existing);
  }
}

function readAllPersistedWorkspaceIds(stateDir: string): string[] {
  const dir = join(stateDir, 'passengers');
  if (!existsSync(dir)) return [];
  // Exclude passenger-sync-daemon.ts's own `<workspaceId>-sync.json` files (ISSUE-705)
  // — this loop only owns the bare `<workspaceId>.json` tunnel-state files, and used
  // to also match the sync-daemon's, treating it as an orphaned tunnel and deleting it
  // every cycle.
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('-sync.json'))
    .map((f) => f.slice(0, -'.json'.length));
}

/**
 * The Host Passengers tunnel client (ISSUE-553, CREW_PRD.md §9.9,
 * docs/RELAY.md in the synthesis repo). Shells out to the REAL `ssh`
 * binary rather than a library like `ssh2` — the PRD's own spike note
 * (§9.9) is that the real binary needed a real interop fix distinct from
 * what worked `ssh2`-to-`ssh2`, so this client's own fidelity comes from
 * running literally the same command a person would type by hand:
 *
 *   ssh -N -p <relayPort> -R workspace-<workspaceId>:0:127.0.0.1:<localPort> <relayHost>
 *
 * `-N`: no remote command, this connection exists purely to hold the
 * forward open. The bind address's `workspace-<id>` prefix and `:0` dynamic
 * port are the relay's own addressing convention (RELAY.md) — not something
 * this client interprets, just what it's told to ask for.
 *
 * There is no live relay to test this against (ISSUE-652 blocks real
 * ship->workspace entitlement on the relay side, filed separately, not
 * this ticket's to fix) — every test here injects a fake `spawn`, asserting
 * this module builds the right argv and reacts correctly to a fake child
 * process's stdout/exit, not that a real tunnel actually comes up.
 *
 * `mcp_url` publishing is a known, explicit gap, not an oversight: per
 * RELAY.md's own "what's real vs. what still needs" section, nothing on the
 * relay side publishes a tunnel's `tunnelSlug` back to the ship yet, so
 * there is no signal this client could read to learn its own public URL.
 * This module only ever writes `tunnel_status`; a future ticket on the
 * relay side (making it tell the ship its slug, e.g. over the SSH banner or
 * a side channel) is what `mcp_url` actually depends on.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
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
  /** The Host Passengers container's published port on this host. */
  localPort: number;
  privateKeyPath: string;
  onStatus?: (status: TunnelStatus) => void;
  spawnFn?: SpawnFn;
}

export interface Tunnel {
  readonly status: TunnelStatus;
  /** The underlying `ssh` process's pid — undefined only if `spawn` itself never assigned one. */
  readonly pid: number | undefined;
  stop(): void;
}

export function sshArgsFor(o: Pick<TunnelOptions, 'relayHost' | 'relayPort' | 'workspaceId' | 'localPort' | 'privateKeyPath'>): string[] {
  return [
    '-N',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-i', o.privateKeyPath,
    '-p', String(o.relayPort),
    '-R', `workspace-${o.workspaceId}:0:127.0.0.1:${o.localPort}`,
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
  /** Reports each workspace's settled status this cycle, for the caller to write onto the Ships row. */
  onStatus?: (workspaceId: string, status: TunnelStatus) => void;
}

/**
 * Reconciles running tunnels against `plans` (one `ContainerPlan` per
 * workspace this ship should be hosting passengers for — see
 * `passenger-containers.ts`'s `planContainers`), the way
 * `syncPassengerContainers` reconciles Docker containers:
 *
 * - no persisted tunnel, or its pid is dead, or its mounts have changed
 *   (the container behind it was recreated) -> (re)spawn, persist the new
 *   pid, report whatever status `startTunnel` settles on immediately.
 * - persisted tunnel, pid alive, mounts unchanged -> nothing to do beyond
 *   promoting a still-`connecting` status to `connected` (an alive `ssh -N
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
  deps: SyncTunnelsDeps = {},
): void {
  const alive = deps.isPidAlive ?? isPidAlive;
  const plannedIds = new Set(plans.map((p) => p.workspaceId));

  for (const plan of plans) {
    const existing = readPersistedTunnel(stateDir, plan.workspaceId);
    if (existing && alive(existing.pid) && existing.mountsHash === plan.mountsHash) {
      if (existing.status === 'connecting') {
        const settled: PersistedTunnel = { ...existing, status: 'connected' };
        writePersistedTunnel(stateDir, settled);
        deps.onStatus?.(plan.workspaceId, 'connected');
      }
      continue;
    }
    if (existing && alive(existing.pid)) {
      // Mounts changed under it (the container was recreated) — the old
      // tunnel forwards to a port that may no longer answer the same repos.
      try { process.kill(existing.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    let settledStatus: TunnelStatus = 'connecting';
    const tunnel = startTunnel({
      relayHost, relayPort, workspaceId: plan.workspaceId, localPort: plan.port, privateKeyPath,
      spawnFn: deps.spawnFn, onStatus: (s) => { settledStatus = s; },
    });
    writePersistedTunnel(stateDir, {
      pid: tunnel.pid ?? -1,
      containerName: plan.containerName,
      workspaceId: plan.workspaceId,
      mountsHash: plan.mountsHash,
      startedAt: new Date().toISOString(),
      status: settledStatus,
    });
    deps.onStatus?.(plan.workspaceId, settledStatus);
  }

  for (const workspaceId of readAllPersistedWorkspaceIds(stateDir)) {
    if (plannedIds.has(workspaceId)) continue;
    const existing = readPersistedTunnel(stateDir, workspaceId);
    if (existing && alive(existing.pid)) {
      try { process.kill(existing.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    removePersistedTunnel(stateDir, workspaceId);
    deps.onStatus?.(workspaceId, 'disconnected');
  }
}

function readAllPersistedWorkspaceIds(stateDir: string): string[] {
  const dir = join(stateDir, 'passengers');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
}

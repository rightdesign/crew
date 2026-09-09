/**
 * The Host Passengers tunnel client (ISSUE-553, CREW_PRD.md §9.9,
 * docs/RELAY.md in the synthesis repo). Shells out to the REAL `ssh`
 * binary rather than a library like `ssh2` — the PRD's own spike note
 * (§9.9) is that the real binary needed a real interop fix distinct from
 * what worked `ssh2`-to-`ssh2`, so this client's own fidelity comes from
 * running literally the same command a person would type by hand:
 *
 *   ssh -N -R workspace-<workspaceId>:0:127.0.0.1:<localPort> <relayHost>
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

// `detached: true` is load-bearing (ISSUE-680): `crew run` is a short-lived
// process relaunched every cycle, not a daemon — without this, Node's
// default child_process behavior keeps the parent's event loop alive until
// the child exits, so `crew run` could never finish the cycle that spawned
// a tunnel meant to keep running indefinitely. `startTunnel` below also
// calls `.unref()` on the returned child for the same reason. Note: stderr
// stays piped (not fully 'ignore'd) so the immediate "Allocated port" signal
// below still works within the spawning cycle; a detached child whose
// parent has since exited could in principle see a write to that pipe fail
// once the parent's read end is gone, but `ssh -N` writes to stderr once at
// connect time and essentially never again in the steady state, so this is
// a narrow residual risk, not addressed here.
/** Pulled out to its own constant so a test can assert on it without mocking `node:child_process`. */
export const DEFAULT_SPAWN_OPTIONS: SpawnOptions = { stdio: ['ignore', 'ignore', 'pipe'], detached: true };
const defaultSpawn: SpawnFn = (cmd, args) => spawn(cmd, args, DEFAULT_SPAWN_OPTIONS);

export interface TunnelOptions {
  /** e.g. `crewd@ships.tablation.dev` — `Ship.relayHost`. */
  relayHost: string;
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

/**
 * OpenSSH's own confirmation that a dynamic `-R ...:0:...` bind actually
 * took: with a real port requested, the client has to be TOLD which port
 * the far end picked, and it prints that to stderr the moment the
 * remote-forward request succeeds — independent of whether the relay does
 * anything useful with it afterward. This is the earliest real signal this
 * client has that the tunnel itself is up, as opposed to just "the ssh
 * process is still running" (which is also true while it's stuck in the
 * TCP handshake).
 */
const ALLOCATED_PORT_RE = /Allocated port \d+ for remote forward/;

export function sshArgsFor(o: Pick<TunnelOptions, 'relayHost' | 'workspaceId' | 'localPort' | 'privateKeyPath'>): string[] {
  return [
    '-N',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-i', o.privateKeyPath,
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
  // let this child keep `crew run`'s event loop — and therefore the whole
  // process — alive until the tunnel itself exits. A test-injected
  // `spawnFn` may return a fake without a real `.unref()`; guard for that.
  child.unref?.();
  let stderrBuf = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrBuf += chunk.toString();
    if (status === 'connecting' && ALLOCATED_PORT_RE.test(stderrBuf)) {
      status = 'connected';
      opts.onStatus?.('connected');
    }
  });
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
 * Persisted across `crew run`/`poll` invocations — each is its own short-
 * lived process (a systemd/launchd timer, not a daemon loop; see
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
      relayHost, workspaceId: plan.workspaceId, localPort: plan.port, privateKeyPath,
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

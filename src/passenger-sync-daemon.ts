/**
 * The host-side half of ISSUE-554 decision 8's `initialize`-triggered
 * freshness sync (the poll-cadence half — `syncAllPassengerCheckouts` in
 * passenger-containers.ts — is decision 8's OTHER half, already shipped).
 *
 * A Passenger session's MCP `initialize` handshake happens inside a
 * container, on a machine with no direct route back to `crewd`'s own
 * process — Docker's bridge network sits between them. `crewd` answers this
 * by running one small HTTP listener PER Host Passengers container,
 * spawned detached alongside that container the same way `tunnel.ts` spawns
 * an `ssh` child per workspace: a per-invocation CLI process (`crew
 * run`/`poll`, see cli.ts) can't itself stay alive between poll cycles, so
 * the listener has to outlive it. `passenger-mcp.ts` (inside the container)
 * calls this listener's `/sync` route from `server.server.oninitialized`.
 *
 * The container reaches this listener via `host.docker.internal`, wired up
 * by `startContainer`'s `--add-host host.docker.internal:host-gateway` —
 * deliberately NOT real loopback. On Docker Desktop (macOS/Windows)
 * `host.docker.internal` is a VM-boundary alias that happens to reach
 * anything the host itself can reach, including a `127.0.0.1`-only
 * listener; on native Linux Docker, `host-gateway` resolves to the bridge
 * network's actual gateway IP, which a service bound only to `127.0.0.1`
 * is NOT reachable at. This listener binds `0.0.0.0` for exactly that
 * reason — the target production environment (a real Docker host running
 * `crewd`) is the Linux case, not Docker Desktop.
 *
 * Auth: a shared secret, generated fresh whenever a workspace's container
 * is (re)created (mounts changed -> new container -> new secret, the same
 * event that already invalidates the old `mountsHash`), passed to the
 * container as `PASSENGER_SYNC_SECRET` (`passenger-containers.ts`'s
 * `startContainer`) and required as a Bearer token on the callback. Each
 * workspace's daemon/secret is independent — nothing here is a single
 * shared secret across every Host Passengers container on this ship, so
 * one workspace's container can never sync another's checkout by guessing
 * or reusing a token. Deliberately NOT rotated on any other cadence (no key
 * rotation, no expiry) — proportionate to what this ticket asks for; a
 * container that's still running has had the same identity, and therefore
 * the same secret, since it was launched.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CrewConfig } from './config.ts';
import {
  portFor, passengerCheckoutSyncSpecs, type ContainerPlan, type SyncDaemonEndpoint, type PassengerCheckoutSyncSpec,
} from './passenger-containers.ts';
import { syncPassengerCheckout, type PassengerCheckoutOutcome } from './git.ts';
import { isPidAlive } from './tunnel.ts';

export function generateSyncSecret(): string {
  return randomBytes(32).toString('hex');
}

/** `Buffer.from`/`timingSafeEqual` throw on a length mismatch rather than reporting one — a client sending a malformed or wrong-length header is just "not the secret", not an error condition. */
function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * A different base than `portFor`'s own default (the MCP container's own
 * published port, 28765-29764) so the two ranges never collide for the same
 * workspace — same deterministic-hash approach, same "a bind failure
 * surfaces loudly rather than silently double-booking" rationale.
 */
export function syncDaemonPortFor(workspaceId: string): number {
  return portFor(workspaceId, 30765, 1000);
}

const SYNC_HOST = 'host.docker.internal';

export interface SyncOutcome {
  name: string;
  outcome: PassengerCheckoutOutcome;
}

/**
 * The actual `/sync` HTTP handler — testable directly against real git
 * fixtures, with no child process or Docker involved (mirrors
 * `passenger-mcp.ts`'s own `createPassengerHttpServer`/
 * `createPassengerMcpServer` split for the same reason: the wire protocol
 * and the "how does this process get launched and torn down" concerns are
 * independently testable).
 */
export function createSyncDaemonServer(targets: PassengerCheckoutSyncSpec[], secret: string): Server {
  return createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== '/sync' || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string' || !secretsMatch(authHeader, `Bearer ${secret}`)) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid or missing sync secret' }));
      return;
    }
    try {
      const synced: SyncOutcome[] = targets.map((t) => ({
        name: t.name,
        outcome: syncPassengerCheckout(t.dir, t.remote, t.gitRemoteName, t.base),
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ synced }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  });
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * The daemon child process's own entrypoint — invoked by `cli.ts`'s
 * `passenger-sync-daemon` command, which is how `startDaemonProcess` below
 * actually launches it (re-running this same `crew` binary with a different
 * subcommand, rather than a second bespoke entry script, so dev/prod both
 * "just work" the same way `dist/cli.js` already does for everything else).
 * Everything this process needs travels in through env vars set at spawn
 * time — it never reads `crew.yaml` itself.
 */
export function runSyncDaemonFromEnv(env: NodeJS.ProcessEnv = process.env): Server {
  const port = Number.parseInt(requireEnv(env, 'PASSENGER_SYNC_PORT'), 10);
  const secret = requireEnv(env, 'PASSENGER_SYNC_SECRET');
  const targets = JSON.parse(requireEnv(env, 'PASSENGER_SYNC_TARGETS')) as PassengerCheckoutSyncSpec[];
  const server = createSyncDaemonServer(targets, secret);
  // A bind failure (most likely EADDRINUSE, the old daemon's socket not yet
  // released when this replacement was spawned) must surface loudly rather
  // than throw uncaught and kill this process with zero visible output —
  // this process runs detached with stdio: 'ignore', so an uncaught error
  // here otherwise vanishes.
  server.on('error', (err) => {
    console.error(`Passenger sync daemon failed to bind 0.0.0.0:${port}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
  server.listen(port, '0.0.0.0', () => {
    console.error(`Passenger sync daemon listening on 0.0.0.0:${port}/sync (${targets.length} checkout(s))`);
  });
  return server;
}

export type SpawnFn = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;

/**
 * Detached, `stdio: 'ignore'`, `.unref()`'d — this process has to outlive
 * the `crew run`/`poll` invocation that spawned it, the same shape
 * `tunnel.ts`'s own `defaultSpawn` uses for the `ssh` child.
 */
const defaultSpawn: SpawnFn = (cmd, args, env) => {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env });
  child.unref();
  return child;
};

/**
 * Persisted across `crew run`/`poll` invocations, same rationale and same
 * directory as `tunnel.ts`'s `PersistedTunnel` — a distinct filename suffix
 * (`-sync.json` vs. tunnel's bare `<workspaceId>.json`) so the two don't
 * collide. `secret` and `port` live here (not just re-derived each cycle)
 * because a container that's still running was launched with a specific
 * secret baked into its env — if this daemon process dies and needs
 * respawning while the container itself is untouched, the respawned
 * daemon MUST reuse that same secret, not a fresh one the container was
 * never told about.
 */
export interface PersistedSyncDaemon {
  pid: number;
  containerName: string;
  workspaceId: string;
  mountsHash: string;
  port: number;
  secret: string;
  startedAt: string;
}

function syncDaemonStatePath(stateDir: string, workspaceId: string): string {
  return join(stateDir, 'passengers', `${workspaceId}-sync.json`);
}

function readPersistedSyncDaemon(stateDir: string, workspaceId: string): PersistedSyncDaemon | undefined {
  const path = syncDaemonStatePath(stateDir, workspaceId);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PersistedSyncDaemon;
  } catch {
    return undefined;
  }
}

function writePersistedSyncDaemon(stateDir: string, state: PersistedSyncDaemon): void {
  const path = syncDaemonStatePath(stateDir, state.workspaceId);
  mkdirSync(join(stateDir, 'passengers'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function removePersistedSyncDaemon(stateDir: string, workspaceId: string): void {
  const path = syncDaemonStatePath(stateDir, workspaceId);
  try { unlinkSync(path); } catch { /* already gone */ }
}

/** Synchronous sleep via `Atomics.wait` — the reconcile loop below is itself synchronous (called once per `crew run`/`poll` cycle), so a short busy-wait fits its existing style. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `SIGTERM` is asynchronous — the kernel doesn't guarantee the old process
 * has released its listening socket by the time `process.kill` returns.
 * Spawning the replacement immediately risked binding the same deterministic
 * port before the old daemon's `close` finished, which used to throw
 * `EADDRINUSE` on the new process with no visible error (stdio: 'ignore').
 * Blocks up to `timeoutMs` for the old pid to actually die; a daemon this
 * small should exit near-instantly, so hitting the timeout itself is a sign
 * something is stuck, not the expected case.
 */
function waitForExit(pid: number, alive: (pid: number) => boolean, timeoutMs = 5_000): void {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < deadline) {
    sleepSync(50);
  }
}

function readAllPersistedSyncWorkspaceIds(stateDir: string): string[] {
  const dir = join(stateDir, 'passengers');
  if (!existsSync(dir)) return [];
  const suffix = '-sync.json';
  return readdirSync(dir).filter((f) => f.endsWith(suffix)).map((f) => f.slice(0, -suffix.length));
}

export interface SyncPassengerSyncDaemonsDeps {
  spawnFn?: SpawnFn;
  isPidAlive?: (pid: number) => boolean;
}

/**
 * Reconciles running sync-daemon listeners against `plans` (one
 * `ContainerPlan` per workspace, from `planContainers` — see
 * `passenger-containers.ts`), the same shape `syncPassengerTunnels`
 * reconciles `ssh` tunnels:
 *
 * - no persisted daemon, or its pid is dead, or `mountsHash` changed (the
 *   container behind it was recreated, or is about to be) -> (re)spawn.
 *   A `mountsHash` change generates a NEW secret (a new container identity
 *   is about to exist); a dead pid alone reuses the EXISTING secret (the
 *   still-running container next to it was already told that one).
 * - persisted daemon, pid alive, `mountsHash` unchanged -> leave it alone.
 * - a persisted daemon for a workspace no longer in `plans` -> kill it,
 *   drop its state file.
 *
 * Returns the resolved `{host, port, secret}` for every plan, whether just
 * (re)spawned or left running — `syncPassengerContainers`'s caller (cli.ts)
 * uses this to wire `startContainer`'s callback env vars, which is also why
 * this MUST run before `syncPassengerContainers`: a container's env is
 * fixed at `docker run` time, so the secret it gets has to already exist.
 */
export function syncPassengerSyncDaemons(
  plans: ContainerPlan[], cfg: CrewConfig, stateDir: string, deps: SyncPassengerSyncDaemonsDeps = {},
): Map<string, SyncDaemonEndpoint> {
  const alive = deps.isPidAlive ?? isPidAlive;
  const spawnFn = deps.spawnFn ?? defaultSpawn;
  const plannedIds = new Set(plans.map((p) => p.workspaceId));
  const endpoints = new Map<string, SyncDaemonEndpoint>();

  for (const plan of plans) {
    const port = syncDaemonPortFor(plan.workspaceId);
    const existing = readPersistedSyncDaemon(stateDir, plan.workspaceId);

    if (existing && alive(existing.pid) && existing.mountsHash === plan.mountsHash) {
      endpoints.set(plan.workspaceId, { host: SYNC_HOST, port: existing.port, secret: existing.secret });
      continue;
    }
    if (existing && alive(existing.pid)) {
      // Either mounts changed under it (recreate) or we're about to
      // replace it below — never leave two listeners bound to the same
      // deterministic port for this workspace at once. Waiting for the old
      // process to actually exit (not just for SIGTERM to have been sent)
      // is what keeps the replacement below from racing it for the port.
      try { process.kill(existing.pid, 'SIGTERM'); } catch { /* already gone */ }
      waitForExit(existing.pid, alive);
    }

    const secret = existing && existing.mountsHash === plan.mountsHash ? existing.secret : generateSyncSecret();
    const targets = passengerCheckoutSyncSpecs(cfg, plan.workspaceId);
    const child = spawnFn(process.execPath, [process.argv[1] ?? '', 'passenger-sync-daemon'], {
      ...process.env,
      PASSENGER_SYNC_PORT: String(port),
      PASSENGER_SYNC_SECRET: secret,
      PASSENGER_SYNC_TARGETS: JSON.stringify(targets),
    });
    writePersistedSyncDaemon(stateDir, {
      pid: child.pid ?? -1,
      containerName: plan.containerName,
      workspaceId: plan.workspaceId,
      mountsHash: plan.mountsHash,
      port,
      secret,
      startedAt: new Date().toISOString(),
    });
    endpoints.set(plan.workspaceId, { host: SYNC_HOST, port, secret });
  }

  for (const workspaceId of readAllPersistedSyncWorkspaceIds(stateDir)) {
    if (plannedIds.has(workspaceId)) continue;
    const existing = readPersistedSyncDaemon(stateDir, workspaceId);
    if (existing && alive(existing.pid)) {
      try { process.kill(existing.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    removePersistedSyncDaemon(stateDir, workspaceId);
  }

  return endpoints;
}

/**
 * Host Passengers container lifecycle (ISSUE-553, CREW_PRD.md §9.8-§9.11).
 *
 * One Docker container per WORKSPACE this ship has at least one
 * `hostPassengers: true` route connected to (decision 6 in the Map) — never
 * per session, never per repo. The container runs the image published for
 * this crew's version from `../Dockerfile.passenger-mcp`
 * (`docker/passenger-mcp/package.json`'s pruned dependency set; see
 * `passengerImageRef` for how the tag is chosen and `ensureImage` for how a
 * missing image is pulled), with a read-only bind mount per repo
 * `passengerCheckoutTargets` (config.ts) says belongs to that workspace —
 * each one a dedicated, `crewd`-maintained checkout (ISSUE-554, decision 7
 * in the Map), never a role's ephemeral build worktree and never even the
 * primary checkout a builder can leave dirty or mid-branch. Keeping those
 * checkouts fresh is `syncAllPassengerCheckouts` (below), called from
 * `cli.ts` before this module's own container sync every cycle.
 *
 * Every `docker` invocation goes through the injectable `exec` so tests can
 * run this module's planning/diffing logic without Docker installed at all
 * — the same shape `ports.ts`'s own `run()` uses for `lsof`/`ss`.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { CrewConfig } from './config.ts';
import { crewVersion, passengerCheckoutTargets, reposOf } from './config.ts';
import { loadRepoConfig, resolveRepoConfig } from './repo-config.ts';
import { syncPassengerCheckout, type PassengerCheckoutOutcome } from './git.ts';

export type Exec = (cmd: string, args: string[]) => string;

/** `execFileSync`, wrapped to throw a plain `Error` with stdout+stderr, never a raw ENOENT. */
export const realExec: Exec = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string };
    const why = [err.stderr, err.stdout].map((x) => (x ?? '').trim()).filter(Boolean).join(' / ');
    throw new Error(`${cmd} ${args.join(' ')}: ${why || err.message.trim()}`);
  }
};

/** Is there a working Docker daemon at all? Surfaced by `crew doctor`. */
export function dockerAvailable(exec: Exec = realExec): boolean {
  try {
    exec('docker', ['info']);
    return true;
  } catch {
    return false;
  }
}

/** The Docker Hub repository `.github/workflows/docker.yml` publishes to. */
export const PASSENGER_IMAGE_REPO = 'tablation/crew-passenger-mcp';

/**
 * The image a ship runs its Host Passengers containers from (CREW-1369).
 *
 * Precedence: `CREW_PASSENGER_IMAGE` in the environment, then
 * `ship.passengerImage` in crew.yaml, then `PASSENGER_IMAGE_REPO` tagged with
 * this crew's own version. The version tag is what keeps a ship's container
 * paired with its own `passenger-mcp.ts` contract: the release workflow builds
 * `:X.Y.Z` for every `v*` tag, so the CLI at X.Y.Z pulls exactly that build.
 */
export function passengerImageRef(cfg: CrewConfig): string {
  return process.env.CREW_PASSENGER_IMAGE
    || cfg.ship.passengerImage
    || `${PASSENGER_IMAGE_REPO}:${crewVersion(cfg.crewHome)}`;
}

/** Whether Docker already has `image` locally. */
export function imagePresent(image: string, exec: Exec = realExec): boolean {
  try {
    exec('docker', ['image', 'inspect', image]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pulls `image` only when Docker does not already have it (CREW-1369).
 * A present tag is never re-pulled: the version tag is immutable, and a
 * ship's container must not silently change image between syncs. A failed
 * pull throws — `docker pull`'s own stderr is in the message — so a bad
 * Docker Hub namespace or a missing image fails at install or the first
 * sync, not as an opaque `docker run` error.
 */
export function ensureImage(image: string, exec: Exec = realExec): void {
  if (!imagePresent(image, exec)) exec('docker', ['pull', image]);
}

/** `crew-passenger-<workspaceId>` — stable, greppable in `docker ps`. */
export function containerNameFor(workspaceId: string): string {
  return `crew-passenger-${workspaceId}`;
}

export interface Mount {
  /** This repo's checkout on the host. */
  hostPath: string;
  /** Where it lands read-only inside the container, under /workspace. */
  containerPath: string;
}

export interface ContainerPlan {
  workspaceId: string;
  containerName: string;
  port: number;
  /** The image to run — see `passengerImageRef`. */
  image: string;
  mounts: Mount[];
  /** A stable digest of `mounts` and `image`, stamped as a Docker label — see `mountsDigest`. */
  mountsHash: string;
}

/**
 * A deterministic host port for a workspace's container — same input,
 * same port, every time, with no shared-state port-allocation table to
 * keep consistent across `crew run` cycles or a restarted ship. Collisions
 * between two DIFFERENT workspace ids are possible in principle (a hash
 * mod a range) but vanishingly unlikely for the number of workspaces one
 * ship will ever host, and `docker run`'s own bind-failure surfaces one
 * loudly if it ever happens rather than silently double-booking a port.
 */
export function portFor(workspaceId: string, base = 28765, span = 1000): number {
  const digest = createHash('sha256').update(workspaceId).digest();
  return base + (digest.readUInt32BE(0) % span);
}

/**
 * Digest of a container's mount set AND image (CREW-1369). The image is
 * folded in so a crew upgrade that changes the image tag reads as a stale
 * container and recreates it on the next cycle, the same path a mounts
 * change already takes.
 */
function mountsDigest(mounts: Mount[], image: string): string {
  const sorted = [...mounts].sort((a, b) => a.containerPath.localeCompare(b.containerPath));
  return createHash('sha256').update(JSON.stringify({ mounts: sorted, image })).digest('hex').slice(0, 16);
}

/**
 * One container plan per workspace this ship should be hosting passengers
 * for right now: every enabled route with `hostPassengers: true` and
 * resolved ids, grouped by `resolved.workspaceId` (several routes — several
 * Tablation *projects* — can share one workspace), repo targets merged
 * across those routes and deduped by repo name so two routes both naming
 * "crew" don't produce two mounts for it.
 */
export function planContainers(cfg: CrewConfig): ContainerPlan[] {
  const byWorkspace = new Map<string, Map<string, Mount>>();
  const image = passengerImageRef(cfg);
  for (const route of cfg.routes) {
    if (!route.enabled || !route.hostPassengers || !route.resolved?.workspaceId) continue;
    const workspaceId = route.resolved.workspaceId;
    const mounts = byWorkspace.get(workspaceId) ?? new Map<string, Mount>();
    for (const target of passengerCheckoutTargets(route)) {
      mounts.set(target.name, { hostPath: target.dir, containerPath: `/workspace/${target.name}` });
    }
    byWorkspace.set(workspaceId, mounts);
  }
  return [...byWorkspace.entries()]
    .filter(([, mounts]) => mounts.size > 0) // a workspace opted in with nothing actually included yet
    .map(([workspaceId, mounts]) => {
      const mountList = [...mounts.values()];
      return {
        workspaceId,
        containerName: containerNameFor(workspaceId),
        port: portFor(workspaceId),
        image,
        mounts: mountList,
        mountsHash: mountsDigest(mountList, image),
      };
    });
}

export interface ExistingContainer {
  name: string;
  /** Whether Docker currently has this container running, not merely present. */
  running: boolean;
}

/**
 * Every `crew-passenger-*` container `docker ps -a` currently knows about,
 * running or not, and which of those two it is — a container name existing
 * is not the same as it doing anything: `docker stop`/`kill`/an OOM/a crash
 * all leave the name present but `Exited`, and the reconciliation loop below
 * must treat that the same as "missing" rather than "healthy" (ISSUE-700).
 */
export function listPassengerContainers(exec: Exec = realExec): ExistingContainer[] {
  const out = exec('docker', ['ps', '-a', '--filter', 'name=crew-passenger-', '--format', '{{.Names}}\t{{.State}}']);
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [name, state] = line.split('\t');
    return { name: name!, running: state === 'running' };
  });
}

/** The `crew.mounts.hash` label on a container, or undefined if it has none / doesn't exist. */
function currentMountsHash(name: string, exec: Exec): string | undefined {
  try {
    const out = exec('docker', ['inspect', '--format', '{{ index .Config.Labels "crew.mounts.hash" }}', name]);
    const hash = out.trim();
    return hash || undefined;
  } catch {
    return undefined;
  }
}

export function stopContainer(name: string, exec: Exec = realExec): void {
  try { exec('docker', ['rm', '-f', name]); } catch { /* already gone */ }
}

/**
 * Where and how a container calls back into `crewd` to ask for an on-demand
 * checkout sync (ISSUE-554, decision 8's `initialize`-triggered half) —
 * `host` is `host.docker.internal`, never `127.0.0.1`: the callback crosses
 * the Docker bridge network, not real loopback, so the container needs the
 * bridge gateway's own DNS name, wired up via `startContainer`'s
 * `--add-host host.docker.internal:host-gateway`. `secret` is generated
 * per-container by `passenger-sync-daemon.ts`'s `syncPassengerSyncDaemons`
 * and passed here as already-resolved data — `startContainer` itself never
 * generates or persists anything, it only wires whatever it's given into
 * `docker run`'s argv.
 */
export interface SyncDaemonEndpoint {
  host: string;
  port: number;
  secret: string;
}

/**
 * `docker run -d`, one bind mount per repo, the workspace id and Tablation
 * base URL as env (mirroring `passenger-mcp-main.ts`'s own env contract),
 * and the plan's `mountsHash` stamped as a label so a later cycle can tell
 * whether this container's mount set is stale without diffing flags by
 * hand. `sync`, when given, additionally wires up the on-demand checkout
 * sync callback (ISSUE-554 decision 8) — omitted only when
 * `syncPassengerSyncDaemons` couldn't stand up a listener for this plan,
 * in which case the container still runs, just without that extra
 * freshness path (the poll-cadence sync in `syncAllPassengerCheckouts`
 * still applies regardless).
 *
 * `sync.secret` also becomes `PASSENGER_MCP_SECRET` (ISSUE-685) — a second,
 * distinctly-named use of the SAME per-container identity secret the sync
 * callback already has, not a new generation/persistence mechanism. It's
 * threaded onward to the relay over the tunnel's own bind address
 * (`tunnel.ts`'s `sshArgsFor`) so a caller with no Tablation credential of
 * their own (a cookie-authenticated chat session — see ISSUE-684 in the
 * synthesis repo) can still be let in by the passenger server, once the
 * ship has registered this same secret as its workspace MCP endpoint's
 * Authorization header (`mcp-endpoint-registry.ts`). Omitted, same as the sync env vars, whenever `sync` itself is
 * unavailable — `validateCredential`'s real-API-key path is the fallback.
 */
export function startContainer(
  plan: ContainerPlan, tablationApiBaseUrl: string, sync: SyncDaemonEndpoint | undefined, exec: Exec = realExec,
): void {
  const args = [
    'run', '-d',
    '--name', plan.containerName,
    '--restart', 'unless-stopped',
    '-p', `${plan.port}:8765`,
    '-e', `PASSENGER_MCP_WORKSPACE_ID=${plan.workspaceId}`,
    '-e', `TABLATION_API_BASE_URL=${tablationApiBaseUrl}`,
    '--label', `crew.mounts.hash=${plan.mountsHash}`,
  ];
  if (sync) {
    args.push(
      '--add-host', 'host.docker.internal:host-gateway',
      '-e', `PASSENGER_SYNC_URL=http://${sync.host}:${sync.port}/sync`,
      '-e', `PASSENGER_SYNC_SECRET=${sync.secret}`,
      '-e', `PASSENGER_MCP_SECRET=${sync.secret}`,
    );
  }
  for (const m of plan.mounts) args.push('-v', `${m.hostPath}:${m.containerPath}:ro`);
  args.push(plan.image);
  exec('docker', args);
}

export interface SyncResult {
  started: string[];
  recreated: string[];
  stopped: string[];
}

/**
 * Reconciles running containers against `planContainers(cfg)` — the per-
 * cycle hook `crew run`/`crew poll` calls (see cli.ts). Idempotent: a
 * container already running with the right mount set is left alone.
 *
 * - missing, planned                -> start
 * - present but not running, planned -> stop (clears the name) + start,
 *   same as missing: an Exited/crashed container is not a healthy one, and
 *   leaving it alone forever with no log output was ISSUE-700
 * - running, planned, mounts changed -> stop + start (docker can't hot-swap
 *   a bind mount; a repo added/removed from `hostPassengers` scope only
 *   takes effect on the next sync after this, not mid-session)
 * - running, no longer planned      -> stop (toggle went off, or the last
 *   included connection for that workspace was removed)
 * - present but not running, no longer planned -> stop (clears the name;
 *   same rm -f either way, running or not)
 *
 * Never called at all when `dockerAvailable()` is false — the caller checks
 * that first, same as `crew doctor` does, and reports it rather than
 * letting every `docker` call in here throw.
 *
 * `syncEndpoints` is a plain data lookup (workspace id -> where/how a
 * container calls back for an on-demand sync), computed by the caller via
 * `syncPassengerSyncDaemons` (passenger-sync-daemon.ts) BEFORE this
 * function runs — deliberately not computed in here, so this function's
 * own docker-argv-building logic stays testable with a fake `exec` and no
 * real child-process/fs side effects. A workspace missing from the map
 * (default: none) just starts its container without the sync callback
 * wired up, never a hard failure.
 */
export function syncPassengerContainers(
  cfg: CrewConfig, tablationApiBaseUrl: string, exec: Exec = realExec,
  syncEndpoints: Map<string, SyncDaemonEndpoint> = new Map(),
): SyncResult {
  const plans = planContainers(cfg);
  const plannedByName = new Map(plans.map((p) => [p.containerName, p]));
  const existing = listPassengerContainers(exec);
  const existingByName = new Map(existing.map((c) => [c.name, c]));

  const started: string[] = [];
  const recreated: string[] = [];
  const stopped: string[] = [];

  // Pull on first need only, and only for a container that is actually about
  // to start (CREW-1369): a ship whose containers are all healthy never
  // touches Docker Hub, and a missing image fails here rather than in `run`.
  const ensured = new Set<string>();
  const start = (plan: ContainerPlan, sync: SyncDaemonEndpoint | undefined) => {
    if (!ensured.has(plan.image)) {
      ensureImage(plan.image, exec);
      ensured.add(plan.image);
    }
    startContainer(plan, tablationApiBaseUrl, sync, exec);
  };

  for (const plan of plans) {
    const sync = syncEndpoints.get(plan.workspaceId);
    const current = existingByName.get(plan.containerName);
    if (!current) {
      start(plan, sync);
      started.push(plan.containerName);
    } else if (!current.running) {
      stopContainer(plan.containerName, exec);
      start(plan, sync);
      started.push(plan.containerName);
    } else if (currentMountsHash(plan.containerName, exec) !== plan.mountsHash) {
      stopContainer(plan.containerName, exec);
      start(plan, sync);
      recreated.push(plan.containerName);
    }
  }
  for (const { name } of existing) {
    if (!plannedByName.has(name)) {
      stopContainer(name, exec);
      stopped.push(name);
    }
  }
  return { started, recreated, stopped };
}

export interface PassengerCheckoutSyncResult {
  name: string;
  workspaceId: string;
  outcome: PassengerCheckoutOutcome;
}

/**
 * Everything `syncPassengerCheckout` needs for one repo's dedicated
 * checkout, fully resolved and JSON-serializable — deliberately a plain
 * data shape rather than a `Route`/`CrewConfig` slice, because this is also
 * what gets handed to a workspace's sync-daemon child process (ISSUE-554,
 * decision 8's `initialize`-triggered half; see `passenger-sync-daemon.ts`)
 * over an env var. That process never loads `crew.yaml` itself — it only
 * knows what its own launch env told it — so the spec must carry the fully
 * resolved remote/base, not a route reference it could re-derive one from.
 */
export interface PassengerCheckoutSyncSpec {
  name: string;
  workspaceId: string;
  dir: string;
  remote: string | undefined;
  gitRemoteName: string;
  base: string;
}

/**
 * Every repo's dedicated Host Passengers checkout this ship should be
 * keeping level with its `branch.base`, resolved down to exactly what
 * `syncPassengerCheckout` needs — optionally narrowed to one workspace's
 * mounts (the sync-daemon case; `syncAllPassengerCheckouts` below wants
 * every workspace at once, the poll-cadence case).
 *
 * Repo facts (which remote, which base branch) are read from each repo's
 * ORDINARY working directory (`reposOf`, its own `.crew.yaml` if any) — the
 * same source `cli.ts`'s own `resolvedRepos` already trusts for release —
 * even though what gets synced is the SEPARATE dedicated checkout
 * `passengerCheckoutTargets` names. Reading a repo's own contract never
 * requires writing to it, so this is safe even when that ordinary
 * directory doesn't exist yet on this ship (`loadRepoConfig` reads nothing
 * and `resolveRepoConfig` falls through to the route's own `branch`
 * override, then to `main`/`origin`).
 */
export function passengerCheckoutSyncSpecs(cfg: CrewConfig, workspaceId?: string): PassengerCheckoutSyncSpec[] {
  const specs: PassengerCheckoutSyncSpec[] = [];
  for (const route of cfg.routes) {
    if (!route.enabled || !route.hostPassengers || !route.resolved?.workspaceId) continue;
    if (workspaceId && route.resolved.workspaceId !== workspaceId) continue;
    const routeWorkspaceId = route.resolved.workspaceId;
    const ordinaryByName = new Map(reposOf(route).map((t) => [t.name, t]));
    for (const target of passengerCheckoutTargets(route)) {
      const ordinary = ordinaryByName.get(target.name);
      const override = route.repoOverrides[target.name];
      const effective = resolveRepoConfig(
        ordinary ? loadRepoConfig(ordinary.dir) : null,
        { branch: { ...route.branch, ...override?.branch } },
        ordinary?.dir ?? target.dir,
      );
      specs.push({
        name: target.name,
        workspaceId: routeWorkspaceId,
        dir: target.dir,
        remote: target.remote,
        gitRemoteName: effective.branch.remote,
        base: effective.branch.base,
      });
    }
  }
  return specs;
}

/**
 * Brings every repo's dedicated Host Passengers checkout level with its
 * `branch.base` (ISSUE-554, decision 8 in the Map, b9f59bd9-8ed5-4479-
 * b85d-f0a64d00726c) — the poll-cadence half of freshness ("piggybacked
 * onto crewd's existing per-project poll cadence as a background floor").
 * The MCP `initialize`-triggered half is `passenger-sync-daemon.ts`'s own
 * HTTP handler, which calls `syncPassengerCheckout` per
 * `passengerCheckoutSyncSpecs(cfg, workspaceId)` entry the same way this
 * function does — just scoped to one workspace and fired on demand instead
 * of once a cycle.
 *
 * Called once per cycle from `cli.ts`, before this module's own
 * `syncPassengerContainers` — a checkout must be cloned and current before
 * a container can mount it.
 */
export function syncAllPassengerCheckouts(cfg: CrewConfig): PassengerCheckoutSyncResult[] {
  return passengerCheckoutSyncSpecs(cfg).map((spec) => ({
    name: spec.name,
    workspaceId: spec.workspaceId,
    outcome: syncPassengerCheckout(spec.dir, spec.remote, spec.gitRemoteName, spec.base),
  }));
}

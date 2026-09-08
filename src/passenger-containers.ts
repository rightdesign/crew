/**
 * Host Passengers container lifecycle (ISSUE-553, CREW_PRD.md §9.8-§9.11).
 *
 * One Docker container per WORKSPACE this ship has at least one
 * `hostPassengers: true` route connected to (decision 6 in the Map) — never
 * per session, never per repo. The container runs the image built from
 * `../Dockerfile.passenger-mcp` (`docker/passenger-mcp/package.json`'s
 * pruned dependency set), with a read-only bind mount per repo
 * `passengerRepoTargets` (config.ts) says belongs to that workspace.
 *
 * Every `docker` invocation goes through the injectable `exec` so tests can
 * run this module's planning/diffing logic without Docker installed at all
 * — the same shape `ports.ts`'s own `run()` uses for `lsof`/`ss`.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { CrewConfig } from './config.ts';
import { passengerRepoTargets } from './config.ts';

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

export const IMAGE_TAG = 'crew-passenger-mcp:latest';

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
  mounts: Mount[];
  /** A stable digest of `mounts`, stamped as a Docker label — see `mountsDigest`. */
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

function mountsDigest(mounts: Mount[]): string {
  const sorted = [...mounts].sort((a, b) => a.containerPath.localeCompare(b.containerPath));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
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
  for (const route of cfg.routes) {
    if (!route.enabled || !route.hostPassengers || !route.resolved?.workspaceId) continue;
    const workspaceId = route.resolved.workspaceId;
    const mounts = byWorkspace.get(workspaceId) ?? new Map<string, Mount>();
    for (const target of passengerRepoTargets(route)) {
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
        mounts: mountList,
        mountsHash: mountsDigest(mountList),
      };
    });
}

/** Every `crew-passenger-*` container `docker ps -a` currently knows about, running or not. */
export function listPassengerContainers(exec: Exec = realExec): string[] {
  const out = exec('docker', ['ps', '-a', '--filter', 'name=crew-passenger-', '--format', '{{.Names}}']);
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
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
 * `docker run -d`, one bind mount per repo, the workspace id and Tablation
 * base URL as env (mirroring `passenger-mcp-main.ts`'s own env contract),
 * and the plan's `mountsHash` stamped as a label so a later cycle can tell
 * whether this container's mount set is stale without diffing flags by hand.
 */
export function startContainer(plan: ContainerPlan, tablationApiBaseUrl: string, exec: Exec = realExec): void {
  const args = [
    'run', '-d',
    '--name', plan.containerName,
    '--restart', 'unless-stopped',
    '-p', `${plan.port}:8765`,
    '-e', `PASSENGER_MCP_WORKSPACE_ID=${plan.workspaceId}`,
    '-e', `TABLATION_API_BASE_URL=${tablationApiBaseUrl}`,
    '--label', `crew.mounts.hash=${plan.mountsHash}`,
  ];
  for (const m of plan.mounts) args.push('-v', `${m.hostPath}:${m.containerPath}:ro`);
  args.push(IMAGE_TAG);
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
 * - not running, planned            -> start
 * - running, planned, mounts changed -> stop + start (docker can't hot-swap
 *   a bind mount; a repo added/removed from `hostPassengers` scope only
 *   takes effect on the next sync after this, not mid-session)
 * - running, no longer planned      -> stop (toggle went off, or the last
 *   included connection for that workspace was removed)
 *
 * Never called at all when `dockerAvailable()` is false — the caller checks
 * that first, same as `crew doctor` does, and reports it rather than
 * letting every `docker` call in here throw.
 */
export function syncPassengerContainers(
  cfg: CrewConfig, tablationApiBaseUrl: string, exec: Exec = realExec,
): SyncResult {
  const plans = planContainers(cfg);
  const plannedByName = new Map(plans.map((p) => [p.containerName, p]));
  const existing = new Set(listPassengerContainers(exec));

  const started: string[] = [];
  const recreated: string[] = [];
  const stopped: string[] = [];

  for (const plan of plans) {
    if (!existing.has(plan.containerName)) {
      startContainer(plan, tablationApiBaseUrl, exec);
      started.push(plan.containerName);
    } else if (currentMountsHash(plan.containerName, exec) !== plan.mountsHash) {
      stopContainer(plan.containerName, exec);
      startContainer(plan, tablationApiBaseUrl, exec);
      recreated.push(plan.containerName);
    }
  }
  for (const name of existing) {
    if (!plannedByName.has(name)) {
      stopContainer(name, exec);
      stopped.push(name);
    }
  }
  return { started, recreated, stopped };
}

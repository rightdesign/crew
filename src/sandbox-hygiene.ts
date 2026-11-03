/**
 * Keeping a sandbox ship's docker host from filling up (CREW-3034).
 *
 * Two independent checks, run together on the daemon's sweep:
 *
 * - The reaper removes docker containers named for this ship's sandboxes that
 *   belong to no live run. The OpenShell gateway can forget sandboxes whose
 *   containers still run, and crew's own `sandbox_deleted` path only covers
 *   the run it started, so nothing else would ever notice them.
 * - The disk watermark reads used space on the root filesystem and the docker
 *   data root. At {@link DISK_WARN_PERCENT} it raises `disk_pressure`; at
 *   {@link DISK_STOP_PERCENT} it reclaims what it safely can (the reaper, the
 *   build cache) and, if that is not enough, raises `disk_full`, which the poll
 *   reads as a ship-wide stop: no run and no image build starts until usage
 *   drops below {@link DISK_RESUME_PERCENT}.
 *
 * A container is only reaped when BOTH the run sidecars and the gateway's own
 * listing fail to name it, and only once it is older than {@link REAP_MIN_AGE_MS}
 * (a sandbox being created has no sidecar yet). If the gateway cannot be asked,
 * nothing is removed: not knowing is not evidence of a leak.
 */

import { execFile } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { Ship } from './config.ts';
import type { Emitter } from './events.ts';
import { liveRuns } from './live-runs.ts';
import { DEFAULT_CACHE_SETTINGS } from './sandbox-cache.ts';
import { clearShipAttention, openShipAttention, raiseShipAttention, type ShipAttentionItem } from './ship-attention.ts';
import type { State } from './state.ts';

const execFileP = promisify(execFile);

/** A container must be at least this old before it can be a leak. */
export const REAP_MIN_AGE_MS = 5 * 60_000;
/** The `sandbox_leak` item clears once nothing has been reaped for this long. */
export const LEAK_CLEAR_AFTER_MS = 60 * 60_000;
export const DISK_WARN_PERCENT = 85;
export const DISK_STOP_PERCENT = 95;
export const DISK_RESUME_PERCENT = 90;
/** Passes closer together than this reuse the last result; the poll cadence is far shorter than a leak needs. */
export const HYGIENE_INTERVAL_MS = 30_000;

export const SANDBOX_LEAK_KEY = 'sandbox_leak';
export const DISK_PRESSURE_KEY = 'disk_pressure';
export const DISK_FULL_KEY = 'disk_full';

/** The sandbox name inside a container name (`sandboxName` in runner.ts: `crew-` + 14 base36 characters). */
const SANDBOX_IN_CONTAINER = /crew-[0-9a-z]{14}/;

export interface ContainerInfo {
  name: string;
  /** Epoch ms of creation. */
  createdMs: number;
}

export interface ReapDeps {
  workspace: string;
  containers: () => Promise<ContainerInfo[]>;
  /** Sandbox names the gateway lists, or null when it could not be asked. */
  gatewaySandboxes: () => Promise<string[] | null>;
  liveSandboxes: () => string[];
  remove: (name: string) => Promise<void>;
  now: () => number;
}

export interface Reaped {
  container: string;
  ageMs: number;
}

/**
 * `docker ps` prints `CreatedAt` as `2026-11-03 06:19:01 +0000 UTC`. Null for
 * anything else, so an unreadable age never turns into a removal.
 */
export function parseDockerCreatedAt(s: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ([+-])(\d{2})(\d{2})/.exec(s.trim());
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`);
  return Number.isNaN(t) ? null : t;
}

/** Removes the containers of sandboxes no live run and no gateway listing names; returns what it removed. */
export async function reapOrphanContainers(d: ReapDeps, minAgeMs = REAP_MIN_AGE_MS): Promise<Reaped[]> {
  const gateway = await d.gatewaySandboxes();
  if (gateway === null) return [];
  const known = new Set([...gateway, ...d.liveSandboxes()]);
  const prefix = `openshell-${d.workspace}--`;
  const out: Reaped[] = [];
  for (const c of await d.containers()) {
    if (!c.name.startsWith(prefix)) continue;
    const sandbox = SANDBOX_IN_CONTAINER.exec(c.name)?.[0];
    if (!sandbox || known.has(sandbox)) continue;
    const ageMs = d.now() - c.createdMs;
    if (ageMs < minAgeMs) continue;
    await d.remove(c.name);
    out.push({ container: c.name, ageMs });
  }
  return out;
}

/** Percent of the filesystem holding `path` in use, as `df` counts it; null when it cannot be read. */
export function usedPercentAt(path: string): number | null {
  try {
    const s = statfsSync(path);
    const used = Number(s.blocks) - Number(s.bfree);
    const total = used + Number(s.bavail);
    return total > 0 ? (used / total) * 100 : null;
  } catch {
    return null;
  }
}

export interface DiskReading {
  path: string;
  percent: number;
}

/** The fullest of `readings`, or null for none. */
export function fullest(readings: DiskReading[]): DiskReading | null {
  return readings.reduce<DiskReading | null>((a, r) => (!a || r.percent > a.percent ? r : a), null);
}

/**
 * What a reading means for the ship. `stopped` is whether `disk_full` is
 * already open: it stays open until usage is below the resume mark, so a ship
 * hovering at the line does not flap between starting and refusing.
 */
export function diskVerdict(percent: number, stopped: boolean): 'stop' | 'warn' | 'ok' {
  if (percent >= DISK_STOP_PERCENT || (stopped && percent >= DISK_RESUME_PERCENT)) return 'stop';
  return percent >= DISK_WARN_PERCENT ? 'warn' : 'ok';
}

export interface DiskDeps {
  readings: () => Promise<DiskReading[]>;
  /** Frees what is safely reclaimable (orphan containers, the build cache). Called once, at the stop line. */
  reclaim: () => Promise<void>;
}

export async function checkDisk(
  o: { state: State; emit: Emitter; ship: Ship; route?: import('./config.ts').Route },
  d: DiskDeps, nowIso = new Date().toISOString(),
): Promise<void> {
  const raise = (item: ShipAttentionItem) => raiseShipAttention({ state: o.state, emit: o.emit, ship: o.ship, ...(o.route ? { route: o.route } : {}) }, item);
  const stopped = openShipAttention(o.state).some((i) => i.key === DISK_FULL_KEY);
  let worst = fullest(await d.readings());
  if (!worst) return;
  let verdict = diskVerdict(worst.percent, stopped);
  if (verdict === 'stop' && !stopped) {
    // Before giving up, reclaim: a ship at the line is often a few leaked containers away from fine.
    await d.reclaim();
    worst = fullest(await d.readings()) ?? worst;
    verdict = diskVerdict(worst.percent, false);
  }
  const pct = `${Math.round(worst.percent)}%`;
  if (verdict === 'stop') {
    clearShipAttention(o.state, DISK_PRESSURE_KEY);
    await raise({
      kind: 'disk_full', key: DISK_FULL_KEY, since: nowIso,
      message: `${worst.path} is ${pct} full — no agent run or sandbox image build starts until it is below ${DISK_RESUME_PERCENT}%. Resumes automatically once space is freed`,
    });
  } else if (verdict === 'warn') {
    clearShipAttention(o.state, DISK_FULL_KEY);
    await raise({
      kind: 'disk_pressure', key: DISK_PRESSURE_KEY, since: nowIso,
      message: `${worst.path} is ${pct} full — runs stop at ${DISK_STOP_PERCENT}%. Resumes normal reporting once it is below ${DISK_WARN_PERCENT}%`,
    });
  } else {
    clearShipAttention(o.state, DISK_FULL_KEY);
    clearShipAttention(o.state, DISK_PRESSURE_KEY);
  }
}

/** Records a reap on the ship (cumulative count, last time) and clears the item once the leak has been quiet for an hour. */
export async function reportReaped(
  o: { state: State; emit: Emitter; ship: Ship }, reaped: Reaped[], nowMs = Date.now(),
): Promise<void> {
  const prior = openShipAttention(o.state).find((i) => i.key === SANDBOX_LEAK_KEY);
  if (reaped.length === 0) {
    if (prior?.lastReapedAt && nowMs - Date.parse(prior.lastReapedAt) > LEAK_CLEAR_AFTER_MS) clearShipAttention(o.state, SANDBOX_LEAK_KEY);
    return;
  }
  for (const r of reaped) {
    o.emit.warn(`sandbox_reaped: removed ${r.container} (${Math.round(r.ageMs / 60_000)} min old, no live run)`, {
      data: { event: 'sandbox_reaped', container: r.container, ageMs: r.ageMs },
    });
  }
  const total = (prior?.count ?? 0) + reaped.length;
  await raiseShipAttention(o, {
    kind: 'sandbox_leak', key: SANDBOX_LEAK_KEY, since: new Date(nowMs).toISOString(),
    count: total, lastReapedAt: new Date(nowMs).toISOString(),
    message: `${total} sandbox container(s) with no live run have been removed from this ship (latest: ${reaped.length} just now) — something created them outside a run; see the sandbox_reaped events`,
  });
}

// ---- the real docker / openshell edges ----

async function run(bin: string, args: string[]): Promise<string> {
  return (await execFileP(bin, args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
}

export function realReapDeps(ship: Ship): ReapDeps {
  const engine = ship.sandbox?.engine ?? DEFAULT_CACHE_SETTINGS.engine;
  const osBin = ship.sandbox?.bin ?? 'openshell';
  return {
    workspace: ship.sandbox?.cacheWorkspace ?? DEFAULT_CACHE_SETTINGS.workspace,
    containers: async () => {
      const out = await run(engine, ['ps', '-a', '--no-trunc', '--format', '{{.Names}}\t{{.CreatedAt}}']);
      const rows: ContainerInfo[] = [];
      for (const line of out.split('\n')) {
        const [name, created] = line.split('\t');
        const createdMs = created ? parseDockerCreatedAt(created) : null;
        if (name && createdMs !== null) rows.push({ name, createdMs });
      }
      return rows;
    },
    gatewaySandboxes: async () => {
      try { return [...(await run(osBin, ['sandbox', 'list'])).matchAll(/crew-[0-9a-z]{14}/g)].map((m) => m[0]); } catch { return null; }
    },
    liveSandboxes: () => liveRuns(ship.stateDir).flatMap((r) => (r.sandbox ? [r.sandbox] : [])),
    remove: async (name) => { await run(engine, ['rm', '-f', name]); },
    now: () => Date.now(),
  };
}

/** Used space on the root filesystem and the docker data root, whichever exist here. */
export async function realDiskReadings(ship: Ship): Promise<DiskReading[]> {
  const paths = ['/'];
  try {
    const root = (await run(ship.sandbox?.engine ?? DEFAULT_CACHE_SETTINGS.engine, ['info', '--format', '{{.DockerRootDir}}'])).trim();
    if (root && existsSync(root)) paths.push(root);
  } catch { /* no docker data root readable: the root filesystem still counts */ }
  return paths.flatMap((path) => {
    const percent = usedPercentAt(path);
    return percent === null ? [] : [{ path, percent }];
  });
}

/**
 * The daemon's per-pass hygiene check for a sandbox ship. Throttled to
 * {@link HYGIENE_INTERVAL_MS}; an error is a warning, never a failed pass.
 */
export function makeSandboxHygiene(o: { state: State; emit: Emitter; ship: Ship; now?: () => number }): () => Promise<void> {
  const now = o.now ?? Date.now;
  let last = -Infinity;
  return async () => {
    if (now() - last < HYGIENE_INTERVAL_MS) return;
    last = now();
    const deps = realReapDeps(o.ship);
    try {
      await reportReaped(o, await reapOrphanContainers(deps), now());
    } catch (e) {
      o.emit.warn(`sandbox reaper failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      await checkDisk(o, {
        readings: () => realDiskReadings(o.ship),
        reclaim: async () => {
          await reportReaped(o, await reapOrphanContainers(deps), now());
          try { await run(o.ship.sandbox?.engine ?? DEFAULT_CACHE_SETTINGS.engine, ['builder', 'prune', '-f']); } catch { /* the reading after decides */ }
        },
      });
    } catch (e) {
      o.emit.warn(`disk check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

/** Whether `disk_full` is open: no run and no sandbox image build starts. */
export function diskFullStop(state: State): string | null {
  return openShipAttention(state).find((i) => i.kind === 'disk_full')?.message ?? null;
}

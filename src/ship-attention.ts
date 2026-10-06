/**
 * Ship-level attention items (CREW-1373): conditions that belong to the ship
 * rather than to a ticket, so `attention.ts` (ticket-scoped) cannot carry
 * them — a role parked by the spawn breaker, a repo hook whose command is not
 * on the scheduler PATH, a release timer that has stopped firing.
 *
 * Three surfaces, none of which needs a client installed anywhere: the Ships
 * row's `attention` column (written on every heartbeat), `crew status`, and a
 * `sweep`-step event for a client that wants to announce it (crew-macos's
 * `AttentionAnnouncer`, or a configured `hooks.notify`).
 *
 * Detector-sourced items are persisted in `.ship-attention.json`;
 * `release_stale` is never stored — it is derived at read time from the
 * timestamp the release phase touches, so it clears itself the moment a
 * release cycle runs again.
 */

import type { Emitter } from './events.ts';
import { repoTargetFor, reposOf, type Route, type Ship } from './config.ts';
import { notify } from './notify.ts';
import { INTERVAL_SECONDS, findOnPath, pathFor, dockerPathProblem } from './install.ts';
import { statfsSync } from 'node:fs';
import type { State } from './state.ts';
import { baseBranchUnsafe, describeUnsafeBase, refreshBaseBranch, type BaseRefreshOutcome } from './git.ts';
import { loadRepoConfig, resolveRepoConfig } from './repo-config.ts';

export type ShipAttentionKind = 'role_parked' | 'hook_missing' | 'release_stale' | 'docker_missing' | 'base_unsafe' | 'stalled' | 'disk_low';

export interface ShipAttentionItem {
  kind: ShipAttentionKind;
  /** Disambiguates within a kind: `role_parked:qa`, `hook_missing:crew/setup`. */
  key: string;
  message: string;
  /** ISO time the condition was first raised; kept across re-raises of the same key. */
  since: string;
}

/** The release timer is stale once it has not run for this many intervals. */
export const RELEASE_STALE_AFTER_INTERVALS = 3;

/** Adds `item`, or refreshes the message of the same key while keeping its original `since`. */
export function upsert(items: ShipAttentionItem[], item: ShipAttentionItem): ShipAttentionItem[] {
  const existing = items.find((i) => i.key === item.key);
  if (!existing) return [...items, item];
  return items.map((i) => (i.key === item.key ? { ...item, since: existing.since } : i));
}

/** Drops the item with `key`, if any. */
export function clear(items: ShipAttentionItem[], key: string): ShipAttentionItem[] {
  return items.filter((i) => i.key !== key);
}

/**
 * Items present in `current` but absent from `previous` — the same
 * present-now/absent-before rule as `attentionTransitions`, so an item that
 * stays open does not re-announce every cycle, and one that clears and
 * returns announces again.
 */
export function transitions(previous: ShipAttentionItem[], current: ShipAttentionItem[]): ShipAttentionItem[] {
  const before = new Set(previous.map((i) => i.key));
  return current.filter((i) => !before.has(i.key));
}

/**
 * `release_stale`, derived. `lastRunMs` is when the release phase last
 * touched its heartbeat file, or null if it never has: a ship that has never
 * run a release cycle (no release timer installed, a fresh install) is not
 * stale, it is simply not a releasing ship — flagging it would be noise.
 */
export function staleRelease(
  lastRunMs: number | null, nowMs: number, intervalSeconds = INTERVAL_SECONDS,
): ShipAttentionItem | null {
  if (lastRunMs === null) return null;
  const limitMs = RELEASE_STALE_AFTER_INTERVALS * intervalSeconds * 1000;
  const ageMs = nowMs - lastRunMs;
  if (ageMs <= limitMs) return null;
  const minutes = Math.round(ageMs / 60_000);
  return {
    kind: 'release_stale',
    key: 'release_stale',
    message: `This ship has not run a release cycle for ${minutes} minute${minutes === 1 ? '' : 's'} — check its release timer`,
    since: new Date(lastRunMs + limitMs).toISOString(),
  };
}

/** The key of a repo's `base_unsafe` item; one per repo, so two repos' stops do not mask each other. */
export const baseUnsafeKey = (repo: string): string => `base_unsafe:${repo}`;

/**
 * What a base-branch check means for the ship (CREW-1388). A diverged base is
 * the ship's problem, not the ticket's: the ticket is fine and keeps its hold,
 * so the stop is written on the ship where `crew status`, the Ships row and
 * the menubar read it, instead of in a comment only a person who opens the
 * ticket would see. Returns `raise` for an unsafe base, `clear` once the
 * checkout is level again (so the condition resolves itself the next time
 * anything checks), and null when the check says nothing either way
 * (not-applicable, fetch-failed, a dry run's would-fast-forward).
 */
export function baseAttention(
  repo: string, outcome: BaseRefreshOutcome, remote: string, base: string, nowIso = new Date().toISOString(),
): { raise: ShipAttentionItem } | { clear: string } | null {
  if (baseBranchUnsafe(outcome)) {
    return {
      raise: {
        kind: 'base_unsafe', key: baseUnsafeKey(repo), since: nowIso,
        message: `${repo}: no worktree can be cut until the primary checkout's ${base} is reconciled — ${describeUnsafeBase(outcome, remote, base)}. Resumes automatically once it is level with ${remote}/${base}`,
      },
    };
  }
  if (outcome.action === 'level' || outcome.action === 'fast-forwarded') return { clear: baseUnsafeKey(repo) };
  return null;
}

/** The key of a repo's `disk_low` item. */
export const diskLowKey = (repo: string): string => `disk_low:${repo}`;

/** Below this much free space beside a repo, a fresh worktree plus its `setup` install is unlikely to fit. */
export const LOW_DISK_BYTES = 2 * 1024 ** 3;

const gib = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);

/**
 * What a free-space reading means for a repo (ISSUE-1406): `raise` below the
 * threshold, `clear` once there is room again. A worktree cannot be cut and
 * set up with no disk, and the failure otherwise surfaces mid-`setup` as an
 * opaque install error.
 */
export function diskAttention(
  repo: string, freeBytes: number, thresholdBytes = LOW_DISK_BYTES, nowIso = new Date().toISOString(),
): { raise: ShipAttentionItem } | { clear: string } {
  if (freeBytes >= thresholdBytes) return { clear: diskLowKey(repo) };
  return {
    raise: {
      kind: 'disk_low', key: diskLowKey(repo), since: nowIso,
      message: `${repo}: only ${gib(freeBytes)} GiB free beside the checkout (need ${gib(thresholdBytes)}) — no worktree can be set up until space is freed. Resumes automatically once there is room`,
    },
  };
}

/** Free bytes on the filesystem holding `dir`, or null when it cannot be read. */
export function freeBytesAt(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * Reads free space beside every repo of `route`, raising or clearing `disk_low`
 * (ISSUE-1406). Run by the poll each cycle: a statfs is cheap, and checking
 * here is what lets the stop clear itself with no agent run noticing.
 */
export async function checkRepoDisks(
  o: RaiseOptions & { route: Route },
  freeAt: (dir: string) => number | null = freeBytesAt,
  thresholdBytes = LOW_DISK_BYTES,
): Promise<void> {
  for (const target of reposOf(o.route)) {
    const free = freeAt(target.dir);
    if (free === null) continue;
    const att = diskAttention(target.name, free, thresholdBytes);
    if ('raise' in att) await raiseShipAttention(o, att.raise);
    else clearShipAttention(o.state, att.clear);
  }
}

/** `hook_missing:<route>/<repo>/<hook>` split into its repo and hook, or null for another route's or shape. */
function parseHookMissing(key: string, routeName: string): { repo: string; hook: string } | null {
  const prefix = `hook_missing:${routeName}/`;
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const slash = rest.lastIndexOf('/');
  if (slash <= 0) return null;
  return { repo: rest.slice(0, slash), hook: rest.slice(slash + 1) };
}

/**
 * Why a ticket's repo is stopped on this ship (CREW-1403), or null when it is
 * not. Reads the persisted items that make a worktree impossible to cut or
 * set up — a diverged base, a missing `setup` tool (ISSUE-1406: the other
 * hooks only run at release, so they stop nothing here), a full disk — so the
 * building lanes skip such a repo and the digest says why, instead of each
 * run claiming a ticket and then stopping on it.
 */
export function repoStopFor(items: ShipAttentionItem[], route: Route): (t: { repo_id?: string | null }) => string | null {
  const stops = new Map<string, string>();
  for (const i of items) {
    let repo: string | null = null;
    if (i.kind === 'base_unsafe') repo = i.key.slice('base_unsafe:'.length);
    else if (i.kind === 'disk_low') repo = i.key.slice('disk_low:'.length);
    else if (i.kind === 'hook_missing') {
      const h = parseHookMissing(i.key, route.route);
      if (h?.hook === 'setup') repo = h.repo;
    }
    if (repo && !stops.has(repo)) stops.set(repo, i.message);
  }
  if (stops.size === 0) return () => null;
  return (t) => {
    const name = repoTargetFor(route, t.repo_id)?.name;
    return name ? (stops.get(name) ?? null) : null;
  };
}

/**
 * Re-checks the open missing-tool stops (`hook_missing`, `docker_missing`) and
 * clears those whose command now resolves on the scheduler PATH (ISSUE-1406),
 * so a stop resolves itself once the operator fixes `ship.extraPath` or
 * installs the tool, with no `crew doctor` run. A hook whose script no longer
 * names a command is cleared too — nothing is left to be missing. Only a
 * positive answer clears; an item it cannot place (another route, an unknown
 * repo) is left alone.
 */
export function recheckEnvironmentStops(
  state: State, route: Route, ship: Ship,
  deps: { onPath?: (bin: string, path: string) => string | undefined; dockerProblem?: (ship: Ship) => string | undefined } = {},
): string[] {
  const onPath = deps.onPath ?? findOnPath;
  const dockerProblem = deps.dockerProblem ?? dockerPathProblem;
  const cleared: string[] = [];
  for (const item of state.shipAttention().previous()) {
    if (item.kind === 'docker_missing') {
      if (!dockerProblem(ship)) { clearShipAttention(state, item.key); cleared.push('docker'); }
      continue;
    }
    if (item.kind !== 'hook_missing') continue;
    const h = parseHookMissing(item.key, route.route);
    const target = h && reposOf(route).find((t) => t.name === h.repo);
    if (!h || !target) continue;
    let cfg: ReturnType<typeof resolveRepoConfig>;
    try { cfg = resolveRepoConfig(loadRepoConfig(target.dir), undefined, target.dir); } catch { continue; } // unreadable config: leave the stop, `crew doctor` reports it
    const script = (cfg.hooks as Record<string, string | undefined>)[h.hook];
    const cmd = script ? hookCommand(script) : null;
    if (!cmd || onPath(cmd, pathFor(ship))) {
      clearShipAttention(state, item.key);
      cleared.push(`${h.repo}/${h.hook}`);
    }
  }
  return cleared;
}

/**
 * Re-checks every open `base_unsafe` stop against its checkout and clears the
 * ones that are no longer unsafe (CREW-1403). Run by the poll before it
 * selects, so a stop resolves itself without anyone running `crew sync` or an
 * agent run having to notice. Uses a dry-run refresh: it fetches but never
 * moves a branch. A checkout the check cannot judge (not on a clean base,
 * fetch failed) keeps its stop — only a positive "level"/"can fast-forward"
 * answer clears it, the same rule `baseAttention` applies.
 */
export function recheckBaseStops(state: State, route: Route): string[] {
  const open = state.shipAttention().previous().filter((i) => i.kind === 'base_unsafe');
  const cleared: string[] = [];
  for (const item of open) {
    const target = reposOf(route).find((t) => baseUnsafeKey(t.name) === item.key);
    if (!target) continue;
    const cfg = resolveRepoConfig(loadRepoConfig(target.dir), undefined, target.dir);
    const outcome = refreshBaseBranch(target.dir, cfg.branch.remote, cfg.branch.base, true);
    if (outcome.action === 'level' || outcome.action === 'would-fast-forward') {
      clearShipAttention(state, item.key);
      cleared.push(target.name);
    }
  }
  return cleared;
}

/** Every open item: the persisted ones plus the derived `release_stale`. */
export function openShipAttention(state: State, nowMs = Date.now()): ShipAttentionItem[] {
  const stale = staleRelease(state.releaseHeartbeat().at(), nowMs);
  const stored = state.shipAttention().previous();
  return stale ? [...stored, stale] : stored;
}

/** The sweep event a client announces: `attention: ['ship:<kind>']`, no ticket, no url. */
export function announce(emit: Emitter, item: ShipAttentionItem): void {
  emit.warn(item.message, {
    step: 'sweep',
    data: { attention: [`ship:${item.kind}`], title: item.message },
  });
}

export interface RaiseOptions {
  state: State;
  emit: Emitter;
  /** With these, a newly raised item also goes through the route's `hooks.notify`. */
  route?: Route;
  ship?: Ship;
}

/** Persists `item` and announces it once, when it was not already open. Returns whether it was new. */
export async function raiseShipAttention(o: RaiseOptions, item: ShipAttentionItem): Promise<boolean> {
  const store = o.state.shipAttention();
  const previous = store.previous();
  const next = upsert(previous, item);
  store.persist(next);
  if (transitions(previous, next).length === 0) return false;
  announce(o.emit, item);
  if (o.route && o.ship) {
    await notify(o.route, o.ship, { level: 'warn', headline: item.message }, o.emit);
  }
  return true;
}

/** Closes the item with `key`. Silent: nothing needs announcing about a problem going away. */
export function clearShipAttention(state: State, key: string): void {
  const store = state.shipAttention();
  const previous = store.previous();
  const next = clear(previous, key);
  if (next.length !== previous.length) store.persist(next);
}

/**
 * The command a hook script starts with, for `crew doctor`'s PATH check: the
 * first word of the first line that is not blank, a comment or a `VAR=value`
 * assignment. Deliberately only the first command — a script's later lines
 * may be shell builtins, functions or branches, and guessing at those would
 * raise false alarms. Null when the script has no plain command word to check
 * (a leading `if`/`for`, a path, a subshell).
 */
export function hookCommand(script: string): string | null {
  for (const raw of script.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const word = line.split(/\s+/)[0]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    if (!/^[A-Za-z0-9._+-]+$/.test(word)) return null;
    if (SHELL_WORDS.has(word)) return null;
    return word;
  }
  return null;
}

const SHELL_WORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
  'cd', 'echo', 'export', 'set', 'exit', 'test', 'true', 'false', 'source', '.', 'eval', 'exec', 'ok',
]);

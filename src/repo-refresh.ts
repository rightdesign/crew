/**
 * Keeping the route's `Repos` map current (CREW-2885).
 *
 * `resolved.repoNames` (and its remotes/forge-host siblings) is a snapshot
 * `crew connect` takes of the tracker's `Repos` table. A row created by hand
 * afterwards is absent from it, `repoTargetFor` returns null for its id, and
 * every ticket filed against that repository is walked past as "no local
 * checkout" forever — with nothing but an info line per pass to say so.
 *
 * So when a candidate names a repo id the map does not know, the daemon
 * refetches the rows (bounded: at most once per route per `REFRESH_COOLDOWN_MS`),
 * updates the map in memory and in the resolved file, and only then judges
 * servability. A ticket that is still unservable after that, pass after pass,
 * raises a ship attention item naming the ticket and the repository.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolvedPathFor, type Route, type ResolvedIds } from './config.ts';
import { clearShipAttention, raiseShipAttention, type RaiseOptions, type ShipAttentionItem } from './ship-attention.ts';

/** One `Repos` row, as far as the resolved file mirrors it. */
export interface RepoRow {
  id: string;
  name?: string | null;
  remote?: string | null;
  forge_host?: string | null;
}

/** Re-asking the tracker about the same unknown id is pointless inside this window. */
export const REFRESH_COOLDOWN_MS = 2 * 60_000;

/** Consecutive passes a ticket must stay unservable before it is raised as attention. */
export const UNSERVABLE_PASSES_BEFORE_ATTENTION = 3;

/** route -> when (ms) this process last asked the tracker for the Repos rows. */
const lastAsked = new Map<string, number>();

/** The ids in `repoIds` that the route's resolved map does not name. */
export function unknownRepoIds(route: Route, repoIds: Array<string | null | undefined>): string[] {
  const names = route.resolved?.repoNames;
  if (!route.resolved?.reposModelId || !names) return [];
  return [...new Set(repoIds.filter((id): id is string => !!id && !(id in names)))];
}

/**
 * Folds fresh rows into the resolved ids (in place, so every holder of the
 * route sees them). Returns the ids that were not in the map before. Existing
 * entries are updated too: a rename or a changed remote is as stale as a miss.
 */
export function applyRepoRows(resolved: ResolvedIds, rows: RepoRow[]): string[] {
  const added: string[] = [];
  const names = (resolved.repoNames ??= {});
  const remotes = (resolved.repoRemotes ??= {});
  const hosts = (resolved.repoForgeHosts ??= {});
  for (const r of rows) {
    if (!(r.id in names)) added.push(r.id);
    names[r.id] = r.name ?? '';
    if (r.remote) remotes[r.id] = r.remote; else delete remotes[r.id];
    const h = r.forge_host?.trim().toLowerCase();
    if (h) hosts[r.id] = h; else delete hosts[r.id];
  }
  if (Object.keys(remotes).length === 0) delete resolved.repoRemotes;
  if (Object.keys(hosts).length === 0) delete resolved.repoForgeHosts;
  return added;
}

/** Writes the rows into the route's resolved file, leaving every other key alone. */
export function persistRepoRows(stateDir: string, routeName: string, rows: RepoRow[]): void {
  const path = resolvedPathFor(stateDir, routeName);
  if (!existsSync(path)) return;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as ResolvedIds & Record<string, unknown>;
  applyRepoRows(raw, rows);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}

export interface RefreshOptions {
  route: Route;
  stateDir: string;
  /** Every `Repos` row; a thrown error means "could not tell" and leaves the map as it was. */
  fetchRows: () => Promise<RepoRow[]>;
  tickets: Array<{ repo_id?: string | null }>;
  now?: number;
  /** Forget the cooldown (a CLI invocation asking explicitly). */
  force?: boolean;
}

/**
 * If any ticket names a repo id the map lacks, refetch the rows and update the
 * map in memory and on disk. Returns the ids newly learned (empty when nothing
 * was unknown, the cooldown held, the fetch failed, or the id is truly absent).
 */
export async function refreshUnknownRepos(o: RefreshOptions): Promise<string[]> {
  const unknown = unknownRepoIds(o.route, o.tickets.map((t) => t.repo_id));
  if (unknown.length === 0 || !o.route.resolved) return [];
  const now = o.now ?? Date.now();
  const last = lastAsked.get(o.route.route);
  if (!o.force && last !== undefined && now - last < REFRESH_COOLDOWN_MS) return [];
  lastAsked.set(o.route.route, now);
  let rows: RepoRow[];
  try {
    rows = await o.fetchRows();
  } catch {
    return []; // tracker unreachable: the next pass after the cooldown tries again
  }
  const added = applyRepoRows(o.route.resolved, rows);
  try {
    persistRepoRows(o.stateDir, o.route.route, rows);
  } catch {
    // The in-memory map is already right for this process; a failed write
    // only means the next restart re-learns it.
  }
  return added;
}

/** Test seam: forget what was asked. */
export function resetRepoRefreshCooldown(): void {
  lastAsked.clear();
}

/** Key of one ticket's `repo_unservable` item. */
export const repoUnservableKey = (route: string, issueId: string): string => `repo_unservable:${route}:${issueId}`;

export function repoUnservableItem(
  route: string, issueId: string, repoLabel: string, nowIso = new Date().toISOString(),
): ShipAttentionItem {
  return {
    kind: 'repo_unservable', key: repoUnservableKey(route, issueId), since: nowIso,
    message: `${route}: ${issueId} is skipped — this ship has no checkout for ${repoLabel}. Resumes automatically once the route lists that repository (\`crew repos add\`) or a Repos row for it exists`,
  };
}

/**
 * Counts consecutive passes a ticket was unservable. Returns the ticket ids
 * that just reached the threshold or are past it (to be raised; raising is
 * idempotent) and forgets any ticket not in `unservable` this pass.
 */
export function trackUnservable(streaks: Map<string, number>, unservable: string[]): { raise: string[]; recovered: string[] } {
  const now = new Set(unservable);
  const recovered: string[] = [];
  for (const id of [...streaks.keys()]) {
    if (!now.has(id)) { streaks.delete(id); recovered.push(id); }
  }
  const raise: string[] = [];
  for (const id of now) {
    const n = (streaks.get(id) ?? 0) + 1;
    streaks.set(id, n);
    if (n >= UNSERVABLE_PASSES_BEFORE_ATTENTION) raise.push(id);
  }
  return { raise, recovered };
}

/** route -> (issue id -> consecutive unservable passes). */
const streaksByRoute = new Map<string, Map<string, number>>();

/**
 * After `resolveTopCandidate`: turns "unservable this pass" into a visible
 * ship attention item once it has persisted, and closes the item of a ticket
 * that has since become servable (or left the candidate list).
 */
export async function reportUnservable(
  o: RaiseOptions & { route: Route },
  unservable: string[],
  repoLabelOf: (issueId: string) => string,
): Promise<void> {
  const streaks = streaksByRoute.get(o.route.route) ?? new Map<string, number>();
  streaksByRoute.set(o.route.route, streaks);
  const { raise, recovered } = trackUnservable(streaks, unservable);
  for (const id of recovered) {
    try { clearShipAttention(o.state, repoUnservableKey(o.route.route, id)); } catch { /* attention is a convenience */ }
  }
  for (const id of raise) {
    try { await raiseShipAttention(o, repoUnservableItem(o.route.route, id, repoLabelOf(id))); } catch { /* attention is a convenience */ }
  }
}

/** How the attention message names a ticket's repository: its name when the map knows it, else the row id. */
export function repoLabelFor(route: Route, ticket: { repo_id?: string | null } | undefined): string {
  const id = ticket?.repo_id;
  if (!id) return 'a repository (the ticket names none)';
  const name = route.resolved?.repoNames?.[id];
  return name ? `repository "${name}"` : `repository ${id} (no Repos row by that id)`;
}

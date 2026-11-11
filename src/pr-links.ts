/**
 * Web links from an Issues record to the code under review (CREW-3255): the
 * pushed branch (`branch_url`) and its pull request (`pr_url`).
 *
 * `branch_url` is built, never fetched. `pr_url` comes from `hooks.pr` when
 * crew opened the pull request, and otherwise is discovered here: for an open
 * ticket with a `pushed` event, ask the forge for pull requests whose head is
 * the pushed branch. Both columns are optional on the Issues table; a table
 * without them has not adopted them and nothing here touches the forge.
 */

import { forgeDescriptorFor, hasForgeToken, normalizeForgeHost, pullWebUrl, readForgeToken, type ForgesConfig } from './forges.ts';
import { repoTargetFor, type Route } from './config.ts';
import type { Contract } from './contract.ts';
import { Tracker, type RunnerEvent, type Ticket } from './tracker.ts';
import type { Ship } from './config.ts';

export interface ForgePull {
  url: string;
  number: number;
  open: boolean;
  /** ISO time the pull request was created. */
  createdAt: string;
}

/**
 * Which pull request belongs to a ticket: the newest open one; failing that
 * the most recently created one made after the ticket's first push. The cutoff
 * is what stops a branch name reused from an old, merged pull request from
 * attaching that one. A pull request with an unreadable date never qualifies
 * as "after".
 */
export function selectPull(pulls: ForgePull[], firstPushedAt: string | null): ForgePull | null {
  const byNewest = [...pulls].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const open = byNewest.find((p) => p.open);
  if (open) return open;
  const cutoff = firstPushedAt ? Date.parse(firstPushedAt) : NaN;
  if (Number.isNaN(cutoff)) return null;
  return byNewest.find((p) => Date.parse(p.createdAt) > cutoff) ?? null;
}

/** `pushed <sha> to <remote>/<branch>` -> the pushed branch name. */
export function pushedBranchOf(message: string | null | undefined): string | null {
  const m = /^pushed \S+ to [^/\s]+\/(\S+)/.exec((message ?? '').trim());
  return m ? m[1]! : null;
}

/** The full URL for what `hooks.pr` printed: a URL as is, a number (`12`, `#12`) built from the forge. */
export function prUrlFromRef(ref: string | undefined, forgeHost: string | null | undefined, remote: string | null | undefined): string | null {
  const r = ref?.trim();
  if (!r) return null;
  if (/^https?:\/\/\S+$/.test(r)) return r;
  const n = /^#?(\d+)$/.exec(r);
  return n ? pullWebUrl(forgeHost, remote, n[1]!) : null;
}

type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The pull/merge requests whose head is `branch`, newest data the forge has. Throws on any forge error. */
export async function listPulls(
  host: string, remote: string, branch: string, token: string, fetcher: Fetcher = fetch as unknown as Fetcher,
): Promise<ForgePull[]> {
  const h = normalizeForgeHost(host);
  const kind = forgeDescriptorFor(h).kind;
  const signal = AbortSignal.timeout(15_000);
  if (kind === 'gitlab') {
    const url = `https://${h}/api/v4/projects/${encodeURIComponent(remote)}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all&order_by=created_at&sort=desc&per_page=30`;
    const res = await fetcher(url, { headers: { 'PRIVATE-TOKEN': token, Accept: 'application/json' }, signal });
    if (!res.ok) throw new Error(`${h} answered ${res.status}`);
    const rows = await res.json() as Array<{ iid?: number; web_url?: string; state?: string; created_at?: string }>;
    return rows.filter((r) => r.web_url && r.created_at).map((r) => ({
      url: r.web_url!, number: r.iid ?? 0, open: r.state === 'opened', createdAt: r.created_at!,
    }));
  }
  const owner = remote.split('/')[0] ?? '';
  const api = h === 'github.com' ? 'https://api.github.com' : `https://${h}/api/v3`;
  const url = `${api}/repos/${remote}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&sort=created&direction=desc&per_page=30`;
  const res = await fetcher(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'crew' }, signal,
  });
  if (!res.ok) throw new Error(`${h} answered ${res.status}`);
  const rows = await res.json() as Array<{ number?: number; html_url?: string; state?: string; created_at?: string }>;
  return rows.filter((r) => r.html_url && r.created_at).map((r) => ({
    url: r.html_url!, number: r.number ?? 0, open: r.state === 'open', createdAt: r.created_at!,
  }));
}

export interface DiscoveryTracker {
  linkColumns(): Promise<{ branchUrl: boolean; prUrl: boolean; prRef: boolean }>;
  events(type: string): Promise<RunnerEvent[]>;
  updateTicket(id: string, patch: Record<string, unknown>): Promise<unknown>;
  contract: Contract;
}

export interface DiscoveryLog { emit(msg: string, extra?: Record<string, unknown>): unknown; warn(msg: string, extra?: Record<string, unknown>): unknown }

export interface DiscoveryInput {
  tracker: DiscoveryTracker;
  route: Route;
  forges: ForgesConfig | undefined;
  stateDir: string;
  /** The route's open tickets this cycle. */
  tickets: Ticket[];
  log: DiscoveryLog;
  /** Hosts already complained about in this process: one warning per host per run. */
  warnedHosts?: Set<string>;
  fetcher?: Fetcher;
  env?: NodeJS.ProcessEnv;
}

const processWarned = new Set<string>();
const blank = (v: unknown): boolean => typeof v !== 'string' || v.trim() === '';

/**
 * One cycle of pull request discovery. Returns how many tickets got a `pr_url`.
 * Never throws: a missing token, a forge error or a rate limit skips quietly.
 */
export async function discoverPullRequests(i: DiscoveryInput): Promise<number> {
  const warned = i.warnedHosts ?? processWarned;
  const cols = i.tracker.contract.columns;
  try {
    const have = await i.tracker.linkColumns();
    if (!have.prUrl) return 0;
    const candidates = i.tickets.filter((t) => blank(t[cols.prUrl]) && t.repo_id);
    if (candidates.length === 0) return 0;
    const pushed = await i.tracker.events('pushed');
    let found = 0;
    for (const t of candidates) {
      const mine = pushed.filter((e) => e.record_id === t.id);
      if (mine.length === 0) continue;
      const stamp = (e: RunnerEvent) => e.occurred_at ?? e.created_at ?? '';
      const ordered = [...mine].sort((a, b) => Date.parse(stamp(a)) - Date.parse(stamp(b)));
      const branch = pushedBranchOf(ordered[ordered.length - 1]!.message);
      if (!branch) continue;
      const target = repoTargetFor(i.route, t.repo_id);
      const remote = target?.remote ?? i.route.resolved?.repoRemotes?.[t.repo_id!];
      const host = normalizeForgeHost(target?.forgeHost ?? i.route.resolved?.repoForgeHosts?.[t.repo_id!]);
      if (!remote) continue;
      let token: string | null = null;
      try { token = readForgeToken(i.forges, host, i.stateDir, i.env); } catch { /* unreadable reads as no token */ }
      if (!token) continue;
      try {
        const pull = selectPull(await listPulls(host, remote, branch, token, i.fetcher), stamp(ordered[0]!) || null);
        if (!pull) continue;
        const patch: Record<string, unknown> = { [cols.prUrl]: pull.url };
        if (have.prRef && blank(t[cols.prRef])) patch[cols.prRef] = pull.url;
        await i.tracker.updateTicket(t.id, patch);
        i.log.emit(`found pull request ${pull.url}`, { ticket: t.issue_id, step: 'review' });
        found++;
      } catch (e) {
        if (!warned.has(host)) {
          warned.add(host);
          i.log.warn(`pull request discovery on ${host} skipped: ${(e as Error).message}`, { step: 'review' });
        }
      }
    }
    return found;
  } catch (e) {
    i.log.warn(`pull request discovery skipped: ${(e as Error).message}`, { step: 'review' });
    return 0;
  }
}

/** The per-cycle entry point: discovery for one route's open tickets with the ship's own forge tokens. */
export async function discoverForRoute(
  route: Route, ship: Ship, tickets: Ticket[], log: DiscoveryLog, tracker: DiscoveryTracker = new Tracker(route, ship),
): Promise<number> {
  return discoverPullRequests({ tracker, route, forges: ship.forges, stateDir: ship.stateDir, tickets, log });
}

/**
 * `crew doctor` lines for the link columns (CREW-3255): notes, never blockers.
 * `repos` are the route's repos as `{ name, host }`; discovery needs a token for each host.
 */
export function linkDoctorLines(
  have: { branchUrl: boolean; prUrl: boolean },
  repos: Array<{ name: string; host: string | null | undefined }>,
  forges: ForgesConfig | undefined, stateDir: string, env: NodeJS.ProcessEnv = process.env,
): string[] {
  const out = [
    have.branchUrl ? 'branch links:     branch_url present' : 'branch links:     branch_url absent — the pushed branch is not linked; add it to the Issues template',
    have.prUrl ? 'pull requests:    pr_url present — discovery runs each cycle' : 'pull requests:    pr_url absent — pull requests a person opens are not linked; add it to the Issues template',
  ];
  if (have.prUrl) {
    for (const r of repos) {
      const host = normalizeForgeHost(r.host);
      if (!hasForgeToken(forges, host, stateDir, env)) {
        out.push(`pull requests:    discovery unavailable for ${r.name}: no forge token stored for ${host} (see \`crew forge\`)`);
      }
    }
  }
  return out;
}

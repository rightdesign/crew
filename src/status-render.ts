import { since } from './fleet.ts';

/**
 * The text form of `crew status` (CREW-3280). Pure: the command gathers every
 * fact into a `StatusView`, this decides what a terminal shows. The default is
 * what is running and what needs a person; configuration and full lists are
 * under `--verbose`. `--json` never comes through here.
 */

/** How many waiting tickets the default view lists before pointing at `--verbose`. */
export const WAITING_SHOWN = 5;

export interface StatusAttention { kind: string; message: string; since?: string }

export interface StatusRun {
  role: string; ticket: string | null; repo?: string | null; pid: number; spawnedAt: string; deadline?: string;
}

export interface StatusWaitingTicket { key: string; title?: string | null; reasons: string[]; updatedAt: string }

export interface StatusRepo {
  name: string;
  /** Why no worktree may be cut or released from this base; set only when unsafe. */
  unsafeDetail?: string;
  /** The `released by …; lock …` description. */
  releaser: string;
  /** Worth showing by default: the lock is held, or another ship does the releasing. */
  notable: boolean;
}

export interface StatusShip {
  name: string;
  /** The ship's one-line description (online/idle/engaged/not seen). */
  line: string;
  attention: StatusAttention[];
}

export interface StatusLastRun { role: string; ticket: string | null; finishedAt: string; outcome: string }

export interface StatusView {
  ship: { name: string; platform: string };
  route: { name: string; dir: string; enabled: boolean };
  crewPaused: boolean;
  releasePaused: boolean;
  pausedRoles: string[];
  periscopes: { summary: string; relayUrl?: string; live: string[] };
  watermark: string;
  projects: string[];
  reloadRequestedSecondsAgo: number | null;
  runs: StatusRun[];
  lastRuns: StatusLastRun[];
  /** This ship's open attention items. */
  attention: StatusAttention[];
  waiting: StatusWaitingTicket[];
  repos: StatusRepo[];
  /** Verified tickets the release is holding back on a blocker. */
  heldReleases: string[];
  /** The fairness line: a ticket passed over cycle after cycle. */
  starved?: { ticket: string; since: string; streak: number };
  ships: StatusShip[];
}

const plural = (n: number, w: string, many = `${w}s`): string => `${n} ${n === 1 ? w : many}`;

/** One word when everything is normal, otherwise what is not. */
export function stateWord(v: StatusView): string {
  const bits: string[] = [];
  if (v.crewPaused) bits.push('crew paused');
  else if (v.releasePaused) bits.push('release paused');
  for (const r of v.pausedRoles) bits.push(`${r} paused`);
  if (!v.route.enabled) bits.push('route disabled');
  return bits.length ? bits.join(', ') : 'active';
}

const byRecent = <T>(items: T[], at: (x: T) => string | undefined): T[] =>
  [...items].sort((a, b) => Date.parse(at(b) ?? '') - Date.parse(at(a) ?? '') || 0);

function waitingReasonCounts(w: StatusWaitingTicket[]): string {
  const counts = new Map<string, number>();
  for (const t of w) for (const r of t.reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts].map(([r, n]) => `${r} ${n}`).join(', ');
}

const waitingLine = (t: StatusWaitingTicket): string =>
  `${t.key} — ${t.reasons.join(', ')}${t.title ? ` — ${t.title}` : ''}`;

export function renderStatus(v: StatusView, opts: { verbose: boolean; now?: number }): string[] {
  const now = opts.now ?? Date.now();
  const out: string[] = [];
  const verbose = opts.verbose;

  out.push(`${v.ship.name} · ${v.route.name} · ${stateWord(v)}`);

  // Running.
  if (v.runs.length) {
    for (const x of v.runs) {
      out.push(`running:    ${x.role} — ${x.ticket ?? '(no ticket)'}${x.repo ? ` in ${x.repo}` : ''} for ${since(x.spawnedAt, now)}` +
        (verbose ? ` (pid ${x.pid}, since ${x.spawnedAt}${x.deadline ? `, deadline ${x.deadline}` : ''})` : ''));
    }
  } else {
    const last = byRecent(v.lastRuns, (l) => l.finishedAt)[0];
    out.push(last ? `running:    nothing (last run ${since(last.finishedAt, now)} ago)` : 'running:    nothing');
  }
  if (v.reloadRequestedSecondsAgo !== null) {
    out.push(`reload:     requested ${v.reloadRequestedSecondsAgo}s ago, not yet honored — \`crew reload --now\` forces it`);
  }

  // Needs attention: each item once.
  const own = byRecent(v.attention, (a) => a.since);
  const others = v.ships.filter((s) => s.name !== v.ship.name && s.attention.length);
  const unsafe = v.repos.filter((r) => r.unsafeDetail);
  if (own.length || others.length || unsafe.length || v.heldReleases.length || v.starved) {
    out.push('needs attention:');
    for (const i of own) out.push(`  ${i.kind} — ${i.message}`);
    for (const r of unsafe) out.push(`  base ${r.name} — UNSAFE, no worktree cuts or releases: ${r.unsafeDetail}`);
    for (const l of v.heldReleases) out.push(`  release: ${l}`);
    if (v.starved) {
      out.push(`  waiting: ${v.starved.ticket} for ${since(v.starved.since, now)} (passed over ${plural(v.starved.streak, 'cycle')} running)`);
    }
    for (const s of others) {
      if (verbose) for (const i of s.attention) out.push(`  ship ${s.name}: ${i.kind} — ${i.message}`);
      else out.push(`  ship ${s.name}: ${plural(s.attention.length, 'item')} (\`crew status --verbose\` lists them)`);
    }
  }

  // Waiting on you.
  if (v.waiting.length) {
    const sorted = byRecent(v.waiting, (t) => t.updatedAt);
    out.push(`waiting on you: ${v.waiting.length} (${waitingReasonCounts(v.waiting)})`);
    const shown = verbose ? sorted : sorted.slice(0, WAITING_SHOWN);
    for (const t of shown) out.push(`  ${waitingLine(t)}`);
    if (shown.length < sorted.length) out.push(`  … ${sorted.length - shown.length} more (\`crew status --verbose\` lists all)`);
  }

  // Releases.
  const notable = v.repos.filter((r) => verbose || r.notable);
  for (const r of notable) out.push(`releaser:   ${r.name} — ${r.releaser}`);
  const rest = v.repos.length - notable.length;
  if (rest > 0) out.push(`releases:   ${plural(rest, 'repository', 'repositories')} idle, no lock held`);

  // Other ships.
  for (const s of v.ships.filter((x) => x.name !== v.ship.name)) out.push(`other ship: ${s.line}`);

  if (verbose) {
    out.push('');
    out.push(`ship:       ${v.ship.name} (${v.ship.platform})`);
    out.push(`route:      ${v.route.name} -> ${v.route.dir}`);
    out.push(`enabled:    ${v.route.enabled}`);
    out.push(`crew:       ${v.crewPaused ? 'paused' : 'active'}`);
    out.push(`release:    ${v.releasePaused ? 'paused' : 'active'}`);
    for (const r of v.pausedRoles) out.push(`role ${r}: paused`);
    out.push(`periscopes: ${v.periscopes.summary}`);
    if (v.periscopes.relayUrl) out.push(`relay:      ${v.periscopes.relayUrl}`);
    for (const p of v.periscopes.live) out.push(`periscope:  ${p}`);
    out.push(`watermark:  ${v.watermark}`);
    if (v.projects.length) out.push(`projects:   ${v.projects.join(', ')}`);
    for (const l of byRecent(v.lastRuns, (x) => x.finishedAt)) {
      out.push(`last run:   ${l.role} — ${l.ticket ?? '(no ticket)'} ${l.outcome}, ${since(l.finishedAt, now)} ago`);
    }
    const self = v.ships.find((s) => s.name === v.ship.name);
    if (self) out.push(`ship row:   ${self.line}`);
  }
  return out;
}

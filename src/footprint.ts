/**
 * Footprints (CREW-3387): every ticket in flight carries the set of repo-relative
 * files it is expected to change or has changed, and a ticket about to start
 * waits for any active ticket of the same repo that shares one of its files.
 * There is nothing to configure.
 *
 * Where a footprint comes from:
 *  - predicted: the dev lane lists the files it expects to change before it
 *    cuts a worktree and records them once as a `footprint_declared` event;
 *  - actual: every `pushed` event carries the paths its branch changes against
 *    the base (`metadata.paths`, both sides of a rename).
 *
 * While a ticket is `in_progress` its footprint is the declared paths plus the
 * paths of its newest push; from `fixed` on it is the paths of its newest push
 * only, since the work is then known. The changelog, the version files and
 * package manager lockfiles never count: the release phase rewrites them.
 *
 * Everything here is PURE. The inputs are the board and the event log, so every
 * ship reaches the same answer, and a parked ticket is restored simply because
 * it stopped being in the answer (`blocked.ts` sweeps it back, never reading
 * the status back as an input). Only starts are held: a ticket already in flight
 * is never stopped when its pushes grow into another ticket's footprint (the
 * right-of-way rule in CREW-3386 handles a conflict that results), and a ticket
 * with no declaration, an empty one, or from a ship on an older crew simply runs.
 */

import type { Ticket } from './tracker.ts';
import { displayKey } from './tracker.ts';

/** The event type a dev lane writes once, listing the files a ticket's work will touch. */
export const FOOTPRINT_DECLARED_EVENT = 'footprint_declared';

/** Basenames of package manager lockfiles, at any depth. */
const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'Cargo.lock', 'Gemfile.lock', 'poetry.lock', 'Pipfile.lock', 'composer.lock', 'go.sum', 'uv.lock',
  'pdm.lock', 'Podfile.lock', 'Package.resolved',
]);

export interface Declaration { paths: string[]; at: string }
export interface PushInfo {
  at: string;
  /** Absent on a push written by a crew that did not record paths. */
  paths?: string[];
}

export const normalizePath = (p: string): string => p.trim().replace(/\\/g, '/').replace(/^\.\//, '');

/** Whether `path` never counts: lockfiles, plus `extra` (the repo's changelog and version files). */
export function isIgnoredPath(path: string, extra: ReadonlySet<string> = new Set()): boolean {
  const p = normalizePath(path);
  return extra.has(p) || LOCKFILES.has(p.slice(p.lastIndexOf('/') + 1));
}

/** The paths of `raw` that count: normalized, unique, without ignored ones. */
export function countedPaths(raw: unknown, extra?: ReadonlySet<string>): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\n,]/) : [];
  return [...new Set(list.map((p) => normalizePath(String(p))).filter((p) => p && !isIgnoredPath(p, extra)))];
}

const stamp = (e: { occurred_at?: string | null; created_at?: string | null }): string => e.occurred_at ?? e.created_at ?? '';

type EventLike = { record_id: string; occurred_at?: string | null; created_at?: string | null; metadata?: Record<string, unknown> | null };

/** The newest `footprint_declared` event per ticket (`events()` returns newest first). */
export function declarations(events: EventLike[]): Map<string, Declaration> {
  const out = new Map<string, Declaration>();
  for (const e of events) {
    if (out.has(e.record_id)) continue;
    out.set(e.record_id, { paths: countedPaths(e.metadata?.paths), at: stamp(e) });
  }
  return out;
}

/** The newest `pushed` event per ticket, with the paths it recorded when it recorded any. */
export function pushes(events: EventLike[]): Map<string, PushInfo> {
  const out = new Map<string, PushInfo>();
  for (const e of events) {
    if (out.has(e.record_id)) continue;
    const raw = e.metadata?.paths;
    out.set(e.record_id, { at: stamp(e), ...(Array.isArray(raw) ? { paths: raw.map((p) => normalizePath(String(p))).filter(Boolean) } : {}) });
  }
  return out;
}

/** In flight and holding its files: claimed, handed off, in QA, or verified and not yet merged. */
export function isActive(t: Ticket): boolean {
  const s = String(t.status);
  return s === 'in_progress' || s === 'fixed' || s === 'qa' || (s === 'verified' && !t.merged_at);
}

const isWaiting = (t: Ticket): boolean => t.status === 'accepted' || t.status === 'blocked';

/** The footprint in force for a ticket (see the file header). */
export function footprintOf(
  t: Ticket, declared: Map<string, Declaration>, pushed: Map<string, PushInfo>, extra?: ReadonlySet<string>,
): string[] {
  const actual = countedPaths(pushed.get(t.id)?.paths, extra);
  if (t.status === 'in_progress') return [...new Set([...countedPaths(declared.get(t.id)?.paths, extra), ...actual])];
  if (isWaiting(t)) return countedPaths(declared.get(t.id)?.paths, extra);
  return actual;
}

export interface FootprintInput {
  tickets: Ticket[];
  declared: Map<string, Declaration>;
  pushed: Map<string, PushInfo>;
  /** repo_id -> exact paths that never count (its changelog and version files). */
  ignoreByRepo?: Map<string, ReadonlySet<string>>;
  /** Tickets already parked by a dependency: they neither wait here nor take a place in line. */
  dependencyBlocked?: Set<string>;
}

export interface FootprintWait {
  ticket: Ticket;
  /** Display keys of the tickets it waits for. */
  waitingFor: string[];
  /** The shared files, sorted. */
  files: string[];
}

export interface FootprintPlan {
  /** accepted/blocked tickets that must wait, by ticket id. */
  waits: Map<string, FootprintWait>;
}

/** Oldest first: by ticket number, then by key. */
function byAge(a: Ticket, b: Ticket): number {
  const n = (t: Ticket) => Number(String(t.issue_id).replace(/\D/g, '')) || 0;
  return n(a) - n(b) || displayKey(a).localeCompare(displayKey(b));
}

const repoOf = (t: Ticket): string => t.repo_id ?? '';

/**
 * Which accepted tickets must wait.
 *
 * A waiting ticket (accepted, or blocked because of this very rule) that has a
 * non-empty declaration waits when it shares a file with any active ticket of
 * its repo. Waiting tickets are then admitted oldest first and each one
 * admitted holds its files for the rest of the pass, so when several wait on
 * the same files the oldest is restored first and the others wait on it. A
 * ticket parked for a person (`needs_info`), blocked, closed or released holds
 * nothing, so tickets waiting on it start on the next poll.
 */
export function planFootprints(input: FootprintInput): FootprintPlan {
  const waits = new Map<string, FootprintWait>();
  const byRepo = new Map<string, Ticket[]>();
  for (const t of input.tickets) byRepo.set(repoOf(t), [...(byRepo.get(repoOf(t)) ?? []), t]);
  for (const [repoId, tickets] of byRepo) {
    const extra = input.ignoreByRepo?.get(repoId);
    const held: { ticket: Ticket; files: Set<string> }[] = tickets.filter(isActive)
      .map((t) => ({ ticket: t, files: new Set(footprintOf(t, input.declared, input.pushed, extra)) }));
    const candidates = tickets.filter((t) => isWaiting(t) && !input.dependencyBlocked?.has(t.id)).sort(byAge);
    for (const t of candidates) {
      const mine = footprintOf(t, input.declared, input.pushed, extra);
      const hits = held.filter((h) => h.ticket.id !== t.id && mine.some((f) => h.files.has(f)));
      if (mine.length === 0 || hits.length === 0) {
        if (mine.length) held.push({ ticket: t, files: new Set(mine) });
        continue;
      }
      waits.set(t.id, {
        ticket: t,
        waitingFor: hits.map((h) => displayKey(h.ticket)),
        files: [...new Set(hits.flatMap((h) => mine.filter((f) => h.files.has(f))))].sort(),
      });
    }
  }
  return { waits };
}

/**
 * The lane-side check, run right after a declaration is recorded and before a
 * worktree is cut: which active tickets must `self` yield to. Two ships can pick
 * up overlapping tickets in the same moment and both declare before either sees
 * the other; of two overlapping tickets that are both newly declared (in
 * progress, nothing pushed) the later declaration yields, and an exact tie goes
 * to the lower ticket number. Any other overlapping active ticket always wins.
 * Both sides call this with the same log, so exactly one proceeds.
 */
export function mustYieldTo(
  self: Ticket, input: Omit<FootprintInput, 'dependencyBlocked'>,
): { waitingFor: string[]; files: string[] } | null {
  const extra = input.ignoreByRepo?.get(repoOf(self));
  const mine = footprintOf(self, input.declared, input.pushed, extra);
  if (mine.length === 0) return null;
  const newly = (t: Ticket): boolean => t.status === 'in_progress' && input.declared.has(t.id) && !input.pushed.has(t.id);
  const number = (t: Ticket) => Number(String(t.issue_id).replace(/\D/g, '')) || 0;
  const earlier = (a: Ticket, b: Ticket): boolean => {
    const x = input.declared.get(a.id)!.at, y = input.declared.get(b.id)!.at;
    return x !== y ? x < y : number(a) < number(b);
  };
  const hits = input.tickets.filter((o) => o.id !== self.id && repoOf(o) === repoOf(self) && isActive(o))
    .filter((o) => !(newly(self) && newly(o) && earlier(self, o)))
    .map((o) => ({ o, shared: footprintOf(o, input.declared, input.pushed, extra).filter((f) => mine.includes(f)) }))
    .filter((h) => h.shared.length > 0);
  if (hits.length === 0) return null;
  return { waitingFor: hits.map((h) => displayKey(h.o)), files: [...new Set(hits.flatMap((h) => h.shared))].sort() };
}

/** "a.ts, b.ts, c.ts and 4 more" — a few files, then a count. */
export function describeFiles(files: string[], shown = 3): string {
  const head = files.slice(0, shown).map((f) => `\`${f}\``).join(', ');
  return files.length > shown ? `${head} and ${files.length - shown} more` : head;
}

/** What the crew writes on a ticket it parks for a shared file. */
export function footprintWaitNote(w: { waitingFor: string[]; files: string[] }): string {
  return `waiting for ${w.waitingFor.join(', ')}, which changes the same ${w.files.length === 1 ? 'file' : 'files'}: ${describeFiles(w.files)}`;
}

/**
 * The dev lane's declaration step, appended to its queue digest. `recorded`
 * lists the footprints already on the open tickets, so a resumed run does not
 * declare again.
 */
export function footprintDigestSection(recorded: { ticket: string; paths: string[] }[]): string {
  const lines = recorded.length
    ? recorded.map((r) => `- ${r.ticket}: ${r.paths.length ? describeFiles(r.paths, 8) : 'none'}`).join('\n')
    : '- none recorded yet';
  return `### Footprint — declare before you build

The crew keeps tickets that would change the same files from being built at the same time. When you pick up a ticket that has **no branch or worktree yet**, before you cut a worktree or change anything:

1. Read the ticket and the code and list the repo-relative files you expect to change, including files you expect to create. A guess is fine; an empty list is allowed when you cannot tell.
2. Run \`crew footprint <ticket number> <path>...\` (just \`crew footprint <ticket number>\` when a footprint is already recorded below). It records the list once, then checks it against the active work.
3. If it prints \`YIELD\`, stop there: set the ticket back to \`accepted\`, clear \`assignee_id\`, comment in one line that you declared a footprint and yielded, and end the run without a worktree. The crew parks the ticket as \`blocked\` and restores it when the tickets it waits for are released. If it prints \`PROCEED\`, or the command fails or is not available, go on: a ticket with no footprint simply runs.

Footprints already recorded:

${lines}
`;
}

/** Upper bound on the paths one `pushed` event records, so a huge branch cannot bloat the log. */
export const MAX_PUSHED_PATHS = 2000;

/**
 * The extra metadata a `pushed` event carries: the paths the branch changes
 * against the base, both sides of a rename. `undefined` when they could not be
 * read, which leaves the event as an older crew would have written it.
 */
export function pushedMetadata(diffNameOnly: string | null): { paths: string[] } | undefined {
  if (diffNameOnly === null) return undefined;
  return { paths: [...new Set(diffNameOnly.split('\n').map(normalizePath).filter(Boolean))].slice(0, MAX_PUSHED_PATHS) };
}

/** What `crew footprint` prints: one verdict line the lane acts on, then the reason. */
export function footprintVerdictText(ticket: string, y: { waitingFor: string[]; files: string[] } | null): string {
  return y
    ? `YIELD ${ticket}: ${footprintWaitNote(y)}. Set the ticket back to accepted, clear assignee_id, comment in one line and end the run without a worktree; the crew parks it and restores it when they are released.`
    : `PROCEED ${ticket}: no active ticket shares its files.`;
}

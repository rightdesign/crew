/**
 * Right of way for a ticket handed back for a merge conflict (CREW-3386).
 *
 * When several open tickets edit the same few files, a ticket handed back for
 * a conflict kept conflicting again: while its dev lane merged the base in and
 * QA re-verified it, other verified branches touching the same files were
 * released first, so the base had moved again by the time it came back. After
 * the third conflict the release escalated it to a person.
 *
 * So while a hand-back is open, the release defers any OTHER verified branch
 * whose diff touches one of the paths the hand-back conflicted in. A deferred
 * branch stays `verified`, is not handed back and is not counted as a failure;
 * it is simply left out of the cycle and retried on the next.
 *
 * Everything here is computed from the board and the event log on every
 * release, the way `priorBounces` is: nothing is stored in a status or a lock
 * row, so nothing can go stale, and two ships releasing one repo reach the
 * same answer. The pieces are pure functions over tickets, events and the
 * paths each candidate branch changes; `branchPaths` is the only git read.
 *
 * An open hand-back is a `conflict_handed_back` event carrying `metadata.paths`
 * (older events carry none and grant nothing) whose ticket is still in the
 * building/hand-off/verifying/verified statuses, with no later
 * `conflict_escalated`. It lapses `rightOfWayMinutes` after it was written, so
 * an abandoned ticket cannot hold the repo; the release says so when that
 * happens to matter.
 */

import { gitOk } from './git.ts';
import { calloutHeader } from './callout.ts';
import { displayKey, type RunnerEvent, type Ticket } from './tracker.ts';
import type { Contract } from './contract.ts';

export const RIGHT_OF_WAY_MARKER = calloutHeader('NOTE', 'Waiting For A Conflict Fix');

/** The event written on a deferred ticket, once per ticket it waits for. */
export const DEFERRED_EVENT = 'right_of_way_deferred';

export interface OpenHandBack {
  ticket: Ticket;
  /** Epoch ms the hand-back was written. */
  at: number;
  /** The paths the branch conflicted in. */
  paths: string[];
  /** Epoch ms after which the right of way lapses. */
  expiresAt: number;
}

export interface RightOfWayCandidate {
  ticket: Ticket;
  /** Paths the branch changes against the base. */
  paths: string[];
}

export interface Deferral {
  ticket: Ticket;
  waitingFor: Ticket;
  /** The overlap between this branch's paths and the hand-back's. */
  paths: string[];
  /** When the hand-back being waited for was written (epoch ms). */
  since: number;
}

export interface RightOfWayPlan {
  deferrals: Deferral[];
  /** Hand-backs that would have deferred a candidate but have run out their time. */
  lapsed: OpenHandBack[];
}

const stampMs = (e: RunnerEvent): number => Date.parse(e.occurred_at ?? e.created_at ?? '') || 0;

/** The conflicting paths a hand-back event recorded; none for events written before paths were. */
export const pathsOf = (e: RunnerEvent): string[] => {
  const p = e.metadata?.paths;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string' && x !== '') : [];
};

/**
 * Every hand-back whose ticket has not yet been released, escalated or closed,
 * split into those still inside their time and those that have lapsed.
 * Only a ticket's newest hand-back counts.
 */
export function handBacks(
  tickets: Ticket[], events: RunnerEvent[], contract: Contract, now: number, ttlMinutes: number,
): { open: OpenHandBack[]; lapsed: OpenHandBack[] } {
  const none = { open: [] as OpenHandBack[], lapsed: [] as OpenHandBack[] };
  if (ttlMinutes <= 0) return none;
  const s = contract.statuses;
  const live = new Set([s.building, s.handoff, s.verifying, s.verified]);
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const newest = new Map<string, RunnerEvent>();
  for (const e of events) {
    if (e.event_type !== 'conflict_handed_back' || !pathsOf(e).length) continue;
    const prev = newest.get(e.record_id);
    if (!prev || stampMs(e) > stampMs(prev)) newest.set(e.record_id, e);
  }
  const out = { open: [] as OpenHandBack[], lapsed: [] as OpenHandBack[] };
  for (const [id, e] of newest) {
    const ticket = byId.get(id);
    if (!ticket || !live.has(ticket.status)) continue;
    const at = stampMs(e);
    if (events.some((x) => x.record_id === id && x.event_type === 'conflict_escalated' && stampMs(x) > at)) continue;
    const hb: OpenHandBack = { ticket, at, paths: pathsOf(e), expiresAt: at + ttlMinutes * 60_000 };
    (now >= hb.expiresAt ? out.lapsed : out.open).push(hb);
  }
  const order = (a: OpenHandBack, b: OpenHandBack) => a.at - b.at || a.ticket.issue_id.localeCompare(b.ticket.issue_id);
  out.open.sort(order);
  out.lapsed.sort(order);
  return out;
}

const overlap = (a: string[], b: string[]): string[] => {
  const set = new Set(b);
  return a.filter((p) => set.has(p));
};

/**
 * Which candidates wait, and for whom. A candidate waits for the OLDEST open
 * hand-back of another ticket whose paths it touches, unless it has a hand-back
 * of its own that is older (the older hand-back goes first).
 */
export function planRightOfWay(
  candidates: RightOfWayCandidate[], tickets: Ticket[], events: RunnerEvent[],
  contract: Contract, now: number, ttlMinutes: number,
): RightOfWayPlan {
  const { open, lapsed } = handBacks(tickets, events, contract, now, ttlMinutes);
  const own = new Map(open.map((h) => [h.ticket.id, h]));
  const deferrals: Deferral[] = [];
  for (const c of candidates) {
    const mine = own.get(c.ticket.id);
    const first = open.find((h) => h.ticket.id !== c.ticket.id
      && (!mine || mine.at > h.at || (mine.at === h.at && mine.ticket.issue_id > h.ticket.issue_id))
      && overlap(c.paths, h.paths).length > 0);
    if (first) deferrals.push({ ticket: c.ticket, waitingFor: first.ticket, paths: overlap(c.paths, first.paths), since: first.at });
  }
  const lapsedUsed = lapsed.filter((h) => candidates.some((c) => c.ticket.id !== h.ticket.id && overlap(c.paths, h.paths).length > 0));
  return { deferrals, lapsed: lapsedUsed };
}

/** A ticket handed back for a conflict earlier in the release cycle now being settled. */
export interface CycleHandBack {
  ticket: Ticket;
  paths: string[];
}

/**
 * Which hand-back of THIS cycle a conflicting branch queues behind, if any.
 *
 * A release that finds several verified branches conflicting in the same files
 * used to hand every one of them back at once. Each dev lane then merged the
 * same base in, each branch came back clean against the base and still
 * conflicting with its siblings, and the first to land sent the rest round
 * again. So only the first conflict over a set of paths is handed back; a later
 * one in the same cycle whose conflict shares a path with it is left at
 * `verified`, untouched in git and with no hand-back counted against it. From
 * the next cycle the head's right of way holds it back like any other branch
 * touching those paths, and once the head has landed it is merged again: clean,
 * or first in line for a hand-back of its own.
 */
export function queuesBehind(paths: string[], handedBack: CycleHandBack[]): { head: CycleHandBack; paths: string[] } | null {
  for (const head of handedBack) {
    const shared = overlap(paths, head.paths);
    if (shared.length) return { head, paths: shared };
  }
  return null;
}

/** The note on a branch that conflicted but was queued behind another hand-back instead of being handed back itself. */
export function queuedComment(ticket: Ticket, waitingFor: Ticket, paths: string[], base: string, ttlMinutes: number): string {
  const list = paths.map((p) => `\`${p}\``).join(', ');
  return `${RIGHT_OF_WAY_MARKER}

**Verified, and waiting its turn — not handed back.**

This branch no longer squash-merges into \`${base}\`: it conflicts in ${list}. ${displayKey(waitingFor)} conflicted in the same file${paths.length === 1 ? '' : 's'} in the same release and was handed back first. Fixing both at once would only make them conflict with each other, so ${displayKey(ticket)} stays at \`verified\` and nothing in its branch or worktree was touched. The release retries it each cycle once ${displayKey(waitingFor)} is verified and released, or once its right of way lapses (${ttlMinutes} minutes after the hand-back); if it still conflicts then, it is handed back in its turn. Nothing is needed from anyone.`;
}

/** The paths a branch changes against the base (three-dot, so only the branch's own work). */
export function branchPaths(cwd: string, base: string, branch: string): string[] {
  return (gitOk(cwd, ['diff', '--name-only', `${base}...${branch}`]) ?? '').split('\n').filter(Boolean);
}

/** Whether this ticket already carries a deferral event for this hand-back (so it is written once, not per cycle). */
export const deferralReported = (d: Deferral, events: RunnerEvent[]): boolean =>
  events.some((e) => e.record_id === d.ticket.id && e.event_type === DEFERRED_EVENT
    && e.metadata?.waiting_for === d.waitingFor.id && stampMs(e) >= d.since);

export function deferralComment(d: Deferral, base: string, ttlMinutes: number): string {
  const list = d.paths.map((p) => `\`${p}\``).join(', ');
  return `${RIGHT_OF_WAY_MARKER}

**Verified, and waiting its turn — not handed back.**

${displayKey(d.waitingFor)} was handed back for a merge conflict in ${list}, which this branch also changes. Releasing this branch first would move \`${base}\` under it again, so the release leaves this ticket at \`verified\` and retries it each cycle until ${displayKey(d.waitingFor)} is verified and released, or until its right of way lapses (${ttlMinutes} minutes after the hand-back). Nothing is needed from anyone.`;
}

/**
 * Verified tickets the event log says are waiting for a hand-back that is still
 * open, for `crew status`. Needs no git: the deferral event names who it waits
 * for, and the hand-back is read the same way the release reads it.
 */
export function deferredFromLog(
  tickets: Ticket[], events: RunnerEvent[], contract: Contract, now: number, ttlMinutes: number,
): Array<{ ticket: Ticket; waitingFor: Ticket }> {
  const { open } = handBacks(tickets, events, contract, now, ttlMinutes);
  const out: Array<{ ticket: Ticket; waitingFor: Ticket }> = [];
  for (const t of tickets) {
    if (t.status !== contract.statuses.verified) continue;
    const last = events.filter((e) => e.record_id === t.id && e.event_type === DEFERRED_EVENT)
      .sort((a, b) => stampMs(b) - stampMs(a))[0];
    const hb = last && open.find((h) => h.ticket.id === last.metadata?.waiting_for && h.at <= stampMs(last));
    if (hb) out.push({ ticket: t, waitingFor: hb.ticket });
  }
  return out;
}

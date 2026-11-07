/**
 * Back-off for runs that change nothing (CREW-3014).
 *
 * A run can end cleanly (exit 0) with its ticket still `in_progress`, nothing
 * pushed and no hand-off: the agent found a problem it could not work around
 * and stopped on purpose. The ticket keeps its ship hold, so the next pass
 * starts the same run again, each one a new sandbox and a full bill. The
 * spawn breaker only covers a start failure, so nothing noticed the repeat.
 *
 * Each such run is recorded per ticket. The ticket is skipped by candidate
 * selection until `NOOP_DELAYS_MS[count - 1]` has passed (the last delay
 * repeats), and the `repeats`th consecutive no-op run bounces the ticket to a
 * person instead. A run that pushes or hands off clears the record.
 *
 * State lives in `<stateDir>/noop-runs.json`, keyed by the ticket's record id,
 * so a daemon restart does not forget a ticket it was backing off from.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { calloutHeader } from './callout.ts';
import type { ShipAttentionItem } from './ship-attention.ts';
import type { Comment, Ticket } from './tracker.ts';

/** Wait after the 1st, 2nd, 3rd... consecutive no-op run; the last entry repeats. */
export const NOOP_DELAYS_MS = [5, 15, 60].map((m) => m * 60_000);
/** Consecutive no-op runs before the ticket is bounced to a person. */
export const DEFAULT_NOOP_REPEATS = 3;

export const NOOP_BOUNCED_MARKER = calloutHeader('WARNING', 'Runs Changed Nothing');

export interface NoopEntry {
  /** Consecutive runs that ended with nothing pushed and no hand-off. */
  count: number;
  /** Epoch ms of the latest such run's end. */
  lastAt: number;
  /** Epoch ms before which the ticket is not started again. */
  nextAt: number;
}
export type NoopState = Record<string, NoopEntry>;

export const noopRunsPath = (stateDir: string): string => join(stateDir, 'noop-runs.json');
/** The ship-attention key for a ticket's repeating no-op runs. */
export const noopRunsKey = (issueId: string): string => `noop_runs:${issueId}`;

export function readNoopRuns(stateDir: string): NoopState {
  try {
    const v = JSON.parse(readFileSync(noopRunsPath(stateDir), 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as NoopState) : {};
  } catch {
    return {};
  }
}

function writeNoopRuns(stateDir: string, state: NoopState): void {
  mkdirSync(stateDir, { recursive: true });
  const file = noopRunsPath(stateDir);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/** True while the ticket is inside its back-off window. */
export function noopBackedOff(stateDir: string, recordId: string, now: number = Date.now()): boolean {
  const e = readNoopRuns(stateDir)[recordId];
  return e !== undefined && now < e.nextAt;
}

export interface NoopVerdict {
  count: number;
  nextAt: number;
  /** True once `count` reaches `repeats`: stop retrying and hand the ticket to a person. */
  bounce: boolean;
}

/** Records one more run that changed nothing and says what to do about it. */
export function recordNoopRun(stateDir: string, recordId: string, repeats: number, now: number = Date.now()): NoopVerdict {
  const state = readNoopRuns(stateDir);
  const count = (state[recordId]?.count ?? 0) + 1;
  const nextAt = now + NOOP_DELAYS_MS[Math.min(count, NOOP_DELAYS_MS.length) - 1]!;
  state[recordId] = { count, lastAt: now, nextAt };
  writeNoopRuns(stateDir, state);
  return { count, nextAt, bounce: count >= repeats };
}

/** Forgets a ticket's record: it moved, or a person took it back. */
export function clearNoopRuns(stateDir: string, recordId: string): void {
  if (!existsSync(noopRunsPath(stateDir))) return;
  const state = readNoopRuns(stateDir);
  if (!(recordId in state)) return;
  delete state[recordId];
  writeNoopRuns(stateDir, state);
}

/** What the attention item and the ticket comment say while the ticket is backing off. */
export function noopAttentionMessage(tag: string, role: string, count: number, nextAt: number, lastComment: string | null, waitingOnPerson = false): string {
  const mins = Math.max(1, Math.round((nextAt - Date.now()) / 60_000));
  const next = waitingOnPerson ? 'waiting on a person to answer before it is picked up again' : `next attempt in about ${mins} minutes`;
  return `${tag}: ${role} run ended ${count} time${count === 1 ? '' : 's'} in a row with nothing pushed and no hand-off; ${next}` +
    (lastComment ? `. Its last comment: ${lastComment.slice(0, 300)}` : '');
}

export function noopBounceComment(count: number, lastComment: string | null): string {
  return `${NOOP_BOUNCED_MARKER}\n\n${count} consecutive runs of this ticket ended with nothing pushed and no hand-off, so the crew stopped retrying and released its hold. ` +
    (lastComment ? `The agent's last comment:\n\n${lastComment}\n\n` : '') +
    'Needs a person to read this, fix what stopped the run, and set the status back to `accepted` or `in_progress`.';
}

/** The slice of the tracker a run-end settlement needs. */
export interface NoopTracker {
  ticket(id: string): Promise<Ticket>;
  comments(): Promise<Comment[]>;
  updateTicket(id: string, patch: Record<string, unknown>, expectedUpdatedAt?: string): Promise<unknown>;
  postEvent(ticketId: string, body: string, memberId: string, type?: string): Promise<void>;
  claimAffinity(): Promise<{ column: string; shipId: string } | undefined>;
}

export interface SettleNoopOptions {
  tracker: NoopTracker;
  stateDir: string;
  role: string;
  /** The ticket's record id. */
  ticketId: string;
  /** The ticket as it was when the run started. */
  before: Ticket;
  /** What the branch looked like before and after the run (`branchProgress`); equal means nothing was committed or pushed. */
  tipBefore: string;
  tipAfter: string;
  runStart: string;
  memberId: string | undefined;
  operatorId: string | undefined;
  /** Contract column and status names. */
  columns: { status: string; assignee: string };
  statuses: { building: string; needsHuman: string };
  repeats: number;
  raise: (item: ShipAttentionItem) => Promise<unknown> | void;
  clear: (key: string) => void;
  now?: number;
}

export type NoopSettlement = 'progress' | 'backoff' | 'bounced';

/**
 * Called when a building run ends without being killed. A run that moved the ticket
 * (status or assignee), changed the branch, or never held a building ticket clears the
 * record; one that did none of those is recorded and backs the ticket off or bounces it.
 */
export async function settleNoopRun(o: SettleNoopOptions): Promise<NoopSettlement> {
  const tag = o.before.issue_tag ?? o.before.issue_id;
  const after = await o.tracker.ticket(o.ticketId);
  // CREW-3101: the design lane's hand-off is a flag plus a comment, never a push or a status change.
  const flagged = (k: 'needs_review' | 'needs_planning'): boolean => Boolean(after[k]) && !o.before[k];
  const noop = o.before[o.columns.status] === o.statuses.building &&
    after[o.columns.status] === o.before[o.columns.status] &&
    after[o.columns.assignee] === o.before[o.columns.assignee] &&
    o.tipBefore === o.tipAfter &&
    !flagged('needs_review') && !flagged('needs_planning') &&
    // A person owes an answer, so an earlier stale entry for this ticket is not a repeat either.
    !after.needs_review;
  if (!noop) {
    clearNoopRuns(o.stateDir, o.ticketId);
    o.clear(noopRunsKey(o.before.issue_id));
    return 'progress';
  }
  const verdict = recordNoopRun(o.stateDir, o.ticketId, o.repeats, o.now);
  let last: string | null = null;
  try {
    const mine = (await o.tracker.comments())
      .filter((c) => c.ticket_id === o.ticketId && c.team_member_id === o.memberId && c.created_at >= o.runStart && c.body)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    last = mine.at(-1)?.body ?? null;
  } catch { /* the item and comment go without the agent's words */ }
  if (!verdict.bounce) {
    await o.raise({
      kind: 'noop_runs', key: noopRunsKey(o.before.issue_id), since: new Date().toISOString(),
      message: noopAttentionMessage(tag, o.role, verdict.count, verdict.nextAt, last, Boolean(after.needs_planning)),
    });
    return 'backoff';
  }
  const affinity = await o.tracker.claimAffinity();
  await o.tracker.updateTicket(o.ticketId, {
    [o.columns.status]: o.statuses.needsHuman,
    ...(o.operatorId ? { [o.columns.assignee]: o.operatorId } : {}),
    ...(affinity ? { [affinity.column]: null } : {}),
  }, after.updated_at);
  if (o.memberId) await o.tracker.postEvent(o.ticketId, noopBounceComment(verdict.count, last), o.memberId, 'noop_bounced').catch(() => undefined);
  clearNoopRuns(o.stateDir, o.ticketId);
  // The ticket now sits with a person; the board shows it, so the ship item has done its job.
  o.clear(noopRunsKey(o.before.issue_id));
  return 'bounced';
}

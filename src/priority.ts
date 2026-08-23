/**
 * The crew's ticket ordering, in one place.
 *
 * This is the executable copy of the Step 2 ordering rule in
 * `prompts/common.md`. Both the queue digest (which sorts the agent's queue)
 * and role selection (which decides who runs this cycle) rank through here,
 * so the sort an agent is handed and the choice of who runs can never
 * disagree. If this and the prose ever drift, the prose is what to correct.
 *
 * Ported from lib/priority.jq — behaviour-for-behaviour, including the
 * fallbacks, which carry real history (see `effectivePriority`).
 */

export interface Rankable {
  issue_id?: string | null;
  severity?: string | null;
  priority?: string | null;
}

import { DEFAULT_CONTRACT, type Contract } from './contract.ts';

/**
 * A workspace's own ordering, as a lookup. Built per contract rather than
 * hardcoded: a ship serving several workspaces must rank each by its own
 * rules, and nothing about "p0" says it beats "p3".
 */
const indexOf = (order: string[]): Record<string, number> =>
  Object.fromEntries(order.map((v, i) => [v, i]));

/**
 * Priority implied by severity, using triage's own mapping. An unrecognised
 * or absent severity lands mid-pack (2) rather than last, matching the jq:
 * an unclassified ticket should not outrank an S1, nor sink below an S4.
 */
export function derivedPriority(t: Rankable, c: Contract = DEFAULT_CONTRACT): number {
  return indexOf(c.severityOrder)[t.severity ?? ''] ?? c.unknownPriorityRank;
}

/** The explicitly-set Priority, or null when nobody has set one. */
export function explicitPriority(t: Rankable, c: Contract = DEFAULT_CONTRACT): number | null {
  return indexOf(c.priorityOrder)[t.priority ?? ''] ?? null;
}

/**
 * The STRONGER of explicit and derived (lower number wins), so an explicit
 * Priority can only ever move a ticket forward, never behind where its
 * Severity alone would have put it.
 *
 * Marking an S2 as "P2 Medium" used to demote it below every unmarked S2 —
 * flagging a ticket for attention pushed it backwards (ISSUE-159 vs
 * ISSUE-142). To rank something down, lower its Severity.
 */
export function effectivePriority(t: Rankable, c: Contract = DEFAULT_CONTRACT): number {
  const explicit = explicitPriority(t, c);
  const derived = derivedPriority(t, c);
  return explicit === null ? derived : Math.min(explicit, derived);
}

/**
 * Severity as its own tiebreaker. Note this falls back to 4, NOT to the 2
 * that `derivedPriority` uses: as a tiebreaker an unclassified ticket sorts
 * last, while as a priority it sorts mid-pack. The jq draws the same
 * distinction and it is load-bearing, not a typo.
 */
export function severityRank(t: Rankable, c: Contract = DEFAULT_CONTRACT): number {
  return indexOf(c.severityOrder)[t.severity ?? ''] ?? c.severityOrder.length;
}

/** The numeric half of ISSUE-nnn, for oldest-first ordering. */
export function issueNumber(t: Rankable): number {
  const id = t.issue_id ?? 'ISSUE-0';
  const n = Number.parseInt(id.split('-')[1] ?? '0', 10);
  return Number.isNaN(n) ? 0 : n;
}

/** Full sort key: effective priority, then severity, then oldest first. */
export function rank(t: Rankable, c: Contract = DEFAULT_CONTRACT): [number, number, number] {
  return [effectivePriority(t, c), severityRank(t, c), issueNumber(t)];
}

/** Compare two rank keys lexicographically; lower sorts first. */
export function compareRank(a: Rankable, b: Rankable, c: Contract = DEFAULT_CONTRACT): number {
  const ra = rank(a, c);
  const rb = rank(b, c);
  for (let i = 0; i < ra.length; i++) {
    const d = (ra[i] as number) - (rb[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The single integer role selection compares across roles, matching the
 * arithmetic in bash's `lane_top_rank`. Kept identical so a Node runner and
 * a bash runner would pick the same role from the same queue.
 */
export function rankScalar(t: Rankable, c: Contract = DEFAULT_CONTRACT): number {
  const [p, s, n] = rank(t, c);
  return p * 1_000_000_000 + s * 10_000_000 + n;
}

/** "Nothing actionable" — loses to any role that has something. */
export const NOTHING_ACTIONABLE = 999_999_999_999;

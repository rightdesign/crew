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
  /**
   * Whether this ticket's epic is already in progress (ISSUE-385).
   *
   * Precomputed by the caller, never fetched here: priority.ts stays free of
   * contract/tracker concerns, and a caller with no Epics table (or that
   * never looked one up) just never sets this — the tiebreaker then falls
   * through as if every ticket had no epic, which is the correct default.
   */
  epicInProgress?: boolean | null;
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

/**
 * Epic membership as a tiebreaker (ISSUE-385): within equal effective
 * priority and severity, a ticket whose epic is already in progress goes
 * first — finishing beats starting, since an in-progress epic is committed
 * work with the rest of it still owed.
 *
 * Bare membership doesn't count, and neither does an epic that is merely
 * `planned` — both rank the same as no epic at all (1). That's deliberate on
 * two counts: priority is already explicit, so boosting on membership alone
 * would double-count an operator who set both; and it's what keeps a ticket
 * in no epic from ever being permanently starved by this — it only ever
 * loses a TIE, never a comparison against a higher priority or severity.
 */
export function epicRank(t: Rankable): number {
  return t.epicInProgress ? 0 : 1;
}

/**
 * Full sort key: effective priority, then severity, then epic-in-progress,
 * then oldest first.
 */
export function rank(t: Rankable, c: Contract = DEFAULT_CONTRACT): [number, number, number, number] {
  return [effectivePriority(t, c), severityRank(t, c), epicRank(t), issueNumber(t)];
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
 *
 * The epic-in-progress digit sits between severity and issue number, at
 * 1,000,000 — comfortably inside severity's 10,000,000-wide band, and with
 * ten times the headroom `issueNumber` needs at any realistic ticket count.
 */
export function rankScalar(t: Rankable, c: Contract = DEFAULT_CONTRACT): number {
  const [p, s, e, n] = rank(t, c);
  return p * 1_000_000_000 + s * 10_000_000 + e * 1_000_000 + n;
}

/** "Nothing actionable" — loses to any role that has something. */
export const NOTHING_ACTIONABLE = 999_999_999_999;

/**
 * Aging (ISSUE-383): a ticket's effective rank improves the longer it has
 * sat at the front of its connection's queue without winning — the fairness
 * bookkeeping ISSUE-382 already keeps (`state.fairness(name).waiting()`) is
 * both the trigger and the age input, so a quiet connection cannot be
 * starved by a busy one.
 *
 * **Saturating, not linear-forever**: the bonus grows with elapsed time but
 * the aged rank can never go below 0, so aging can never overtake
 * `FIXED_RANK` (QA at -2, triage at -1, see select.ts) — an aged dev ticket
 * outranking QA would delay every release to start more work.
 *
 * **Weight scales the RATE, not the rank.** A rank multiplier could starve a
 * connection permanently, duplicating `enabled: false` badly; scaling the
 * rate means a heavily-weighted connection's work surfaces less often, never
 * that a lightly-weighted one's stops happening. Weight defaults to 1 (pure
 * aging) when a connection configures none.
 *
 * `AGE_HOURS_TO_ERODE` — how long an ungrown ticket takes to fully erode to
 * rank 0 at weight 1 — is a placeholder default, not a tuned constant: this
 * ticket's own dependency on ISSUE-382 is explicit that the rate wants
 * tuning against the real distribution of wait times it now records, rather
 * than against an imagined one.
 */
const AGE_HOURS_TO_ERODE = 48;

export interface AgingInput {
  /** ISO timestamp this ticket has sat at the front of its queue, unpicked. */
  since: string;
  /** Per-connection multiplier on the aging RATE. Undefined means 1 (pure aging). */
  weight?: number;
}

/**
 * `rawRank` eroded toward 0 by how long `aging.since` has elapsed, scaled by
 * `aging.weight`. No `aging` (nothing has been waiting) returns `rawRank`
 * unchanged. Never negative, never larger than `rawRank` — a ticket can only
 * ever be made MORE urgent by aging, never less.
 */
export function agedRankScalar(rawRank: number, aging: AgingInput | undefined, now: number): number {
  if (!aging) return rawRank;
  const elapsedHours = Math.max(0, (now - Date.parse(aging.since)) / 3_600_000);
  const weight = aging.weight ?? 1;
  const fraction = Math.min(1, (elapsedHours * weight) / AGE_HOURS_TO_ERODE);
  return Math.round(rawRank * (1 - fraction));
}

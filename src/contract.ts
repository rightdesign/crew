/**
 * The contract: what a workspace's own choices MEAN.
 *
 * A ship connects to several workspaces at once and must follow the rules
 * each one supplies. So none of this can be a constant in the runner — the
 * values below are only the DEFAULT, which is what an unmodified Issue
 * Tracker template ships with. A workspace that renames its statuses, adds
 * one, or orders priority differently supplies its own, and every route
 * carries its own resolved contract.
 *
 * See docs/CONTRACT.md for the documented default and how to override it.
 *
 * Three kinds of thing live here, and only the first is guessable:
 *   1. which column plays which part;
 *   2. the ORDER of choice values — nothing about "p0" says it beats "p3";
 *   3. what each status MEANS — and `fixed` being open but not resolved is
 *      load-bearing, since a ticket blocked by unmerged work is still blocked.
 */

export interface ContractColumns {
  key: string;
  /**
   * A per-project ticket key (`TABL-123`, `CREW-969`), where the workspace
   * has adopted one — ISSUE-969's Issue Tag. `key`'s own number is what is
   * globally unique, so this is purely a display/branch-naming convenience,
   * never how a ticket is looked up. A ticket whose row has no value in this
   * column (an older ticket, or a workspace that has not adopted the field)
   * reads as "no tag" at every call site, which falls back to plain
   * `issue-{number}` naming — exactly today's behaviour.
   */
  tag: string;
  title: string;
  status: string;
  assignee: string;
  priority: string;
  severity: string;
  /** Where the work source is partitioned — the area. */
  slice: string;
  repo: string;
  parent: string;
  blockedBy: string;
  updatedAt: string;
  needsDesign: string;
  /** Carries the ISSUE-354 coordinating marker — a ticket's report/issue type. */
  reportType: string;
  /**
   * Which body of work a ticket belongs to, on a workspace that has an
   * Epics table (ISSUE-384). Meaningless — and never rendered — on one that
   * doesn't; `environment.ts` gates this on `resolved.epicsModelId`, not on
   * the column merely having a default here.
   */
  epic: string;
  /**
   * The Crew row that filed a ticket (CREW-1371's `filed_by_id`). Optional on
   * the workspace: a table that has not taken the column is written without
   * it (see `Tracker`'s authorship probe), so nothing reads it as required.
   */
  author: string;
  /**
   * The Ships row a ticket was filed from (CREW-1371's `ship_id`, "Filed
   * from"). Optional, like `author` — absent on a workspace that has not
   * taken the column.
   */
  ship: string;
}

export interface ContractComments {
  parent: string;
  body: string;
  author: string;
  /** Marks a comment as the runner's own audit trail rather than prose. */
  kind: string;
  /** The value of `kind` that means "audit trail" — never wakes a role. */
  eventKind: string;
  createdAt: string;
  /**
   * The Ships row a comment was posted from (CREW-1371's `ship_id`, "Posted
   * from"). Optional: a comments table without the column is written without it.
   */
  ship: string;
}

export interface ContractStatuses {
  /** Everything a poll considers live. */
  open: string[];
  /**
   * A blocker stops counting only at these. Besides the deploy/won't-fix/
   * duplicate terminals, the default also names `closed_completed` (done but
   * not deployed — investigation-report-shaped tickets that have no build to
   * ship) and `closed_cant_reproduce` (closed as written, unreproducible) as
   * terminal. A workspace-added status not already in `open` or `resolved`
   * is still discovered per-route via `crew connect`'s prompt, same as ever.
   */
  resolved: string[];
  /** The one a human sets to authorise work. The runner may never set it. */
  approved: string;
  /** The sub-state of approved that the runner parks into and out of. */
  parked: string;
  building: string;
  /** Built, not yet checked. Open but NOT resolved. */
  handoff: string;
  verifying: string;
  verified: string;
  deployed: string;
  /** A person owes an answer. The runner surfaces these, never moves them. */
  needsHuman: string;
  /**
   * Under human review, off this machine — a pull request is open.
   *
   * **Null when this workspace has no review step**, which is the default: an
   * unmodified Issue Tracker has no such status, and inventing one the board
   * does not contain would be worse than admitting the gap. A workspace that
   * adopts review adds the status and names it here.
   *
   * Where present it is open but NOT resolved: unmerged work, so a ticket
   * blocked by one is still blocked. Deliberately not a hold — the QA seat
   * keeps watching, because a reviewer's own commits change what was verified.
   */
  reviewing: string | null;
  /**
   * Where a ticket goes when its review was closed WITHOUT merging.
   *
   * The crew may only write this on a DEFINITIVE signal (the repo's `merged`
   * hook), never on the commit-subject heuristic: a squash whose subject was
   * rewritten is indistinguishable from an abandoned branch, and closing a
   * ticket wrongly is worse than leaving it open.
   */
  wontFix: string;
  /**
   * The holding state for tickets not yet ready to act on (the epic grill-me
   * flow files Maps and child Issues here, then promotes them to `new`).
   *
   * Neither open nor resolved: never polled, and a blocker sitting here is
   * still blocking. It exists as a role only so `crew connect`'s status
   * discovery recognises it instead of asking whether it is terminal.
   */
  draft: string;
}

/**
 * An epic's own status, on a workspace that has an Epics table (CREW-1255).
 *
 * Separate from `ContractStatuses` because it is a separate CHOICE field on
 * a separate table: an epic is planned/in progress/done/cancelled, which
 * only coincidentally shares a value with a ticket's `building`. Ignored
 * entirely on a workspace with no Epics table.
 */
export interface ContractEpics {
  statusColumn: string;
  /** What a person calls the epic (`EPIC-024`) — for the log, never a lookup. */
  keyColumn: string;
  statuses: {
    planned: string;
    /** Work on it is under way. Also what the ISSUE-385 tiebreaker reads. */
    building: string;
    done: string;
    /** Called off by a person. The runner never moves an epic into or out of this. */
    cancelled: string;
  };
}

export interface Contract {
  columns: ContractColumns;
  comments: ContractComments;
  statuses: ContractStatuses;
  epics: ContractEpics;
  /** Most urgent first. Cannot be inferred from the values themselves. */
  priorityOrder: string[];
  severityOrder: string[];
  /**
   * Where an unrecognised value sorts, as an index into the orders above.
   * Mid-pack as a priority, last as a tiebreaker — see priority.ts, where
   * that asymmetry is deliberate and load-bearing.
   */
  unknownPriorityRank: number;
  /**
   * The `columns.reportType` value meaning "coordinating parent, not a
   * filing error" (ISSUE-354) — exempt from needing a Repo, and what
   * `rollUpParents` keys off instead of an absent `columns.repo`.
   */
  coordinatingValue: string;
  /**
   * Every `columns.reportType` value that legitimately needs no Repo
   * (ISSUE-387) — what `filingErrors` treats as exempt, kept separate from
   * `coordinatingValue`. A `question` or `investigation` ticket is
   * repo-less by design (a discussion or a spike, not a build) but is a
   * standalone ticket, not a coordinating parent with children — so it must
   * not also make `rollUpParents` treat it as one. Defaults to
   * `coordinatingValue` plus the two Report-type values an unmodified Issue
   * Tracker ships with for this.
   */
  repoExemptReportTypes: string[];
}

/**
 * What an unmodified Issue Tracker template means by its own choices. Any
 * workspace that has not said otherwise is assumed to mean this.
 */
export const DEFAULT_CONTRACT: Contract = {
  columns: {
    key: 'issue_id',
    tag: 'issue_tag',
    title: 'title',
    status: 'status',
    assignee: 'assignee_id',
    priority: 'priority',
    severity: 'severity',
    slice: 'project_id',
    repo: 'repo_id',
    parent: 'parent_id',
    blockedBy: 'blocked_by',
    updatedAt: 'updated_at',
    needsDesign: 'needs_design',
    reportType: 'report_type',
    epic: 'epic_id',
    author: 'filed_by_id',
    ship: 'ship_id',
  },
  comments: {
    parent: 'ticket_id',
    body: 'body',
    author: 'team_member_id',
    kind: 'kind',
    eventKind: 'event',
    createdAt: 'created_at',
    ship: 'ship_id',
  },
  statuses: {
    open: ['new', 'accepted', 'blocked', 'in_progress', 'needs_info', 'fixed', 'qa', 'verified'],
    resolved: [
      'verified',
      'closed_deployed',
      'closed_wont_fix',
      'closed_duplicate',
      'closed_completed',
      'closed_cant_reproduce',
    ],
    approved: 'accepted',
    parked: 'blocked',
    building: 'in_progress',
    handoff: 'fixed',
    verifying: 'qa',
    verified: 'verified',
    deployed: 'closed_deployed',
    needsHuman: 'needs_info',
    reviewing: null,
    wontFix: 'closed_wont_fix',
    draft: 'draft',
  },
  epics: {
    statusColumn: 'status',
    keyColumn: 'epic_id',
    statuses: { planned: 'planned', building: 'in_progress', done: 'done', cancelled: 'cancelled' },
  },
  priorityOrder: ['p0', 'p1', 'p2', 'p3'],
  severityOrder: ['s1', 's2', 's3', 's4'],
  unknownPriorityRank: 2,
  coordinatingValue: 'coordinating',
  repoExemptReportTypes: ['coordinating', 'question', 'investigation'],
};

export class ContractError extends Error {}

/**
 * The statuses at which a ticket is closed for good: `resolved` minus
 * `verified`. `verified` counts as resolved for a BLOCKER's purposes, but
 * the ticket itself is still pre-release — its branch is unmerged and its
 * worktree is what the release phase is about to ship.
 */
export function closedStatuses(c: Contract): string[] {
  return c.statuses.resolved.filter((s) => s !== c.statuses.verified);
}

/** Deep-merge an override onto the default. Absent keys keep the default. */
export function resolveContract(override?: Partial<Contract> | null): Contract {
  if (!override) return DEFAULT_CONTRACT;
  return {
    columns: { ...DEFAULT_CONTRACT.columns, ...override.columns },
    comments: { ...DEFAULT_CONTRACT.comments, ...override.comments },
    statuses: { ...DEFAULT_CONTRACT.statuses, ...override.statuses },
    epics: {
      ...DEFAULT_CONTRACT.epics,
      ...override.epics,
      statuses: { ...DEFAULT_CONTRACT.epics.statuses, ...override.epics?.statuses },
    },
    priorityOrder: override.priorityOrder ?? DEFAULT_CONTRACT.priorityOrder,
    severityOrder: override.severityOrder ?? DEFAULT_CONTRACT.severityOrder,
    unknownPriorityRank: override.unknownPriorityRank ?? DEFAULT_CONTRACT.unknownPriorityRank,
    coordinatingValue: override.coordinatingValue ?? DEFAULT_CONTRACT.coordinatingValue,
    // A workspace overriding `coordinatingValue` alone (renaming the rollup
    // marker) still gets that renamed value exempted here by default,
    // without also having to repeat it — only an explicit
    // `repoExemptReportTypes` overrides this derived default.
    repoExemptReportTypes:
      override.repoExemptReportTypes ??
      (override.coordinatingValue ? [override.coordinatingValue, 'question', 'investigation']
        : DEFAULT_CONTRACT.repoExemptReportTypes),
  };
}

/**
 * Every problem with a contract, rather than the first — the same reasoning
 * as crew.yaml's loader: someone correcting a workspace's contract should see
 * the whole list, not discover it one run at a time.
 *
 * These are consistency checks a workspace can genuinely fail. A `handoff`
 * status listed as resolved, for instance, would tell the runner that a
 * ticket blocked by unmerged work is free to build on.
 */
export function validateContract(c: Contract): string[] {
  const problems: string[] = [];
  const open = new Set(c.statuses.open);
  const resolved = new Set(c.statuses.resolved);

  for (const role of ['approved', 'parked', 'building', 'handoff', 'verifying', 'needsHuman'] as const) {
    const v = c.statuses[role];
    if (!open.has(v)) problems.push(`statuses.${role} ("${v}") is not listed in statuses.open`);
  }
  // Only checked when this workspace actually has a review step.
  if (c.statuses.reviewing && !open.has(c.statuses.reviewing)) {
    problems.push(`statuses.reviewing ("${c.statuses.reviewing}") is not listed in statuses.open`);
  }
  if (!resolved.has(c.statuses.deployed)) {
    problems.push(`statuses.deployed ("${c.statuses.deployed}") is not listed in statuses.resolved`);
  }
  if (resolved.has(c.statuses.handoff)) {
    problems.push(
      `statuses.handoff ("${c.statuses.handoff}") is listed as resolved — it means built-but-unchecked, ` +
        'so a ticket blocked by it is still blocked; calling it resolved would build on unverified work',
    );
  }
  if (!resolved.has(c.statuses.wontFix)) {
    problems.push(`statuses.wontFix ("${c.statuses.wontFix}") is not listed in statuses.resolved`);
  }
  if (c.statuses.reviewing && resolved.has(c.statuses.reviewing)) {
    problems.push(
      `statuses.reviewing ("${c.statuses.reviewing}") is listed as resolved — it is unmerged work ` +
        'under review, so a ticket blocked by it is still blocked',
    );
  }
  if (resolved.has(c.statuses.approved)) {
    problems.push(`statuses.approved ("${c.statuses.approved}") is listed as resolved`);
  }
  if (c.statuses.parked === c.statuses.approved) {
    problems.push('statuses.parked and statuses.approved are the same value — parking would be a no-op');
  }
  const epicValues = Object.values(c.epics.statuses);
  if (new Set(epicValues).size !== epicValues.length) {
    problems.push('epics.statuses names the same value twice — the epic sync could not tell those states apart');
  }
  if (c.priorityOrder.length === 0) problems.push('priorityOrder is empty');
  if (c.severityOrder.length === 0) problems.push('severityOrder is empty');
  for (const [name, order] of [['priorityOrder', c.priorityOrder], ['severityOrder', c.severityOrder]] as const) {
    if (new Set(order).size !== order.length) problems.push(`${name} contains duplicates`);
  }
  return problems;
}

/**
 * Order read from the tracker's own CHOICE options, which carry a `position`.
 *
 * This is the half a workspace never has to configure: if someone reorders
 * priority in the UI, the crew follows. Only the MEANINGS below need stating.
 */
export function orderFromChoiceOptions(
  options: Array<{ value: string; position?: number | null }>,
): string[] {
  return [...options]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((o) => o.value);
}

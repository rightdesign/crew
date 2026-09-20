/**
 * One cycle: fetch, sweep, select, and decide what to run.
 *
 * Ported from poll_for_work in bin/crew. Returns a decision; performing it is
 * the caller's job, which is what makes `--dry-run` a real dry run rather
 * than an approximation of one.
 */

import type { Route, RoleName, Ship } from './config.ts';
import { configuredMembers, routeSlug } from './config.ts';
import { Tracker, ticketBranchContext, type Ticket, type Comment } from './tracker.ts';
import { buildRoster, holdIds, rosterMarkdown, type Roster } from './roster.ts';
import {
  blockerInfoMap, missingBlockerIds, computeBlockedIds, planSweep,
  sweepDiagnostics, strandedNeedsInfo, rollUpParents, filingErrors,
  type BlockerInfo, type SweepStep,
} from './blocked.ts';
import {
  selectRole, sliceFor, actionableSummary, type Selection, type ActionableSummary, type SelectionInput,
} from './select.ts';
import { attentionReasons, attentionTransitions, type AttentionReason } from './attention.ts';
import { buildingDigest, qaDigest } from './digest.ts';
import { loadRepoConfig, resolveRepoConfig, renderBranchName, effectiveBranchTemplate } from './repo-config.ts';
import { dirForRepo } from './config.ts';
import { branchForIssue } from './git.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { State } from './state.ts';
import type { Emitter } from './events.ts';

export interface CycleDecision {
  tickets: Ticket[];
  comments: Comment[];
  roster: Roster;
  blocked: Set<string>;
  info: BlockerInfo;
  sweep: SweepStep[];
  stranded: Ticket[];
  selection: Selection;
  /** Everything actionable this cycle, pooled across every pending role (ISSUE-382). */
  actionable: ActionableSummary;
  watermark: string;
  /**
   * The exact input `selectRole` ranked this cycle — exposed so the caller
   * can re-rank the winning role's candidates itself (ISSUE-395's claim
   * step) without reconstructing holds/seats/contract from scratch, and
   * risking that reconstruction drifting from what this cycle actually saw.
   */
  selectionInput: SelectionInput;
  /**
   * This cycle's "needs a person" set (ISSUE-928) — `{ ticketId: [reason,
   * ...] }` for every OPEN ticket currently carrying at least one of
   * needs_info/needs_planning/needs_review. `decideCycle` itself makes no
   * writes, so the caller persists this via `state.attention(route).persist(...)`
   * once the cycle is otherwise committed, beside the existing
   * `fairness(route).record(...)` call.
   */
  attention: Record<string, AttentionReason[]>;
}

export interface CycleOptions {
  route: Route;
  ship: Ship;
  state: State;
  emit: Emitter;
  roles?: RoleName[];
}

/**
 * Everything a cycle decides, with no writes at all.
 *
 * Blocked-ness is computed once from the WHOLE payload before any role
 * slicing: a blocker can belong to another role's slice, so a per-role
 * computation would read a cross-role dependency as resolved.
 */
export async function decideCycle(o: CycleOptions): Promise<CycleDecision> {
  const { route, ship, state, emit } = o;
  const tracker = new Tracker(route, ship);
  emit.enter('poll');

  const [tickets, comments, crewRows, epicRows] = await Promise.all([
    tracker.openTickets(),
    tracker.comments(200),
    tracker.crewRows(),
    tracker.epicRows(),
  ]);
  emit.emit(`${tickets.length} open ticket(s), ${comments.length} comment(s)`, {
    data: { tickets: tickets.length, comments: comments.length },
  });

  // ISSUE-385: the epic-in-progress tiebreaker priority.ts reads is computed
  // here, once, rather than fetched inside priority.ts itself — that module
  // stays free of contract/tracker concerns. Annotating these Ticket objects
  // in place means every downstream consumer (select.ts, digest.ts, fleet.ts)
  // sees it too, since they all read from this same array or slices of it.
  const epicColumn = tracker.contract.columns.epic;
  const epicBuilding = tracker.contract.statuses.building;
  const epicStatusById = new Map(epicRows.map((e) => [e.id, e.status ?? null]));
  for (const t of tickets) {
    const epicId = t[epicColumn];
    t.epicInProgress = typeof epicId === 'string' && epicStatusById.get(epicId) === epicBuilding;
  }

  const extra = await tracker.ticketsByIds(missingBlockerIds(tickets));
  const info = blockerInfoMap(tickets, extra);
  const blocked = computeBlockedIds(tickets, info);

  emit.enter('sweep');
  const roster = buildRoster(configuredMembers(route), crewRows);
  const holds = new Set(holdIds(roster));
  const diag = sweepDiagnostics(tickets, info);
  for (const d of diag.dangling) emit.warn(`dangling blocked_by reference, ignored: ${d}`);
  if (diag.selfBlocked.length) {
    emit.warn(`ticket(s) blocking themselves, parked permanently: ${diag.selfBlocked.join(', ')}`);
  }
  const sweep = planSweep(tickets, info, blocked);

  // What a watcher can't otherwise see without `crew status`: the queue
  // behind the winning role. Emitted every cycle, empty or not, since each
  // cycle is its own event-stream id — a view folding only the latest cycle
  // has nothing to fall back on if a quiet cycle skipped the emit (ISSUE-399).
  const blockedIssues = tickets.filter((t) => blocked.has(t.id)).map((t) => t.issue_id);
  emit.emit(`${blockedIssues.length} ticket(s) parked as blocked`, { data: { blocked: blockedIssues } });
  const qaHeld = tickets.filter((t) => t.status === tracker.contract.statuses.verifying).map((t) => t.issue_id);
  emit.emit(`${qaHeld.length} ticket(s) held in QA`, { data: { qaHeld } });

  const stranded = strandedNeedsInfo(tickets, blocked, holds);
  for (const t of stranded) {
    emit.emit('needs_info with all blockers resolved — the operator\'s call, not the crew\'s', {
      ticket: t.issue_id,
    });
  }
  const coordinating = {
    reportTypeColumn: tracker.contract.columns.reportType,
    coordinatingValue: tracker.contract.coordinatingValue,
  };
  for (const r of rollUpParents(tickets, undefined, coordinating)) {
    if (r.complete) {
      emit.emit(`every child is done — this coordinating ticket is too`, { ticket: r.parent.issue_id });
    }
  }
  for (const t of filingErrors(tickets, {
    ...coordinating,
    repoExemptValues: tracker.contract.repoExemptReportTypes,
  })) {
    emit.warn(
      'no repo and not marked coordinating/question/investigation — a filing error, not an epic, and unroutable as written',
      { ticket: t.issue_id },
    );
  }

  // ISSUE-928: which open tickets need a PERSON right now, and which of
  // those reasons are NEW since last cycle. Diffed at the (ticket, reason)
  // grain against the persisted set — see attention.ts and the ticket's own
  // "Decision 2" for why a reason that drops out and later reappears fires
  // again rather than being treated as already-notified.
  const attentionCurrent: Record<string, AttentionReason[]> = {};
  for (const t of tickets) {
    const reasons = attentionReasons(t, tracker.contract);
    if (reasons.length) attentionCurrent[t.id] = reasons;
  }
  const attentionPrevious = state.attention(route.route).previous() as Record<string, AttentionReason[]>;
  const transitions = attentionTransitions(attentionPrevious, attentionCurrent);
  let mintFailed = false;
  for (const tr of transitions) {
    const ticket = tickets.find((t) => t.id === tr.ticketId);
    if (!ticket) continue;
    // Fetch-or-create, not a plain read: minting the same (view, model,
    // record) link twice is idempotent (RecordLinksService.mintForRecord
    // upserts), which is what makes this safe to call from a
    // decision-making pass that otherwise performs no writes.
    const url = await tracker.recordLinkUrl(ticket.id);
    if (!url && route.resolved?.recordLinkViewId) mintFailed = true;
    emit.emit(
      `needs a person: ${tr.reasons.join(', ')} — ${ticket.title}`,
      {
        step: 'sweep',
        ticket: ticket.issue_id,
        data: {
          attention: tr.reasons,
          title: ticket.title ?? undefined,
          ...(url ? { url } : {}),
        },
      },
    );
  }
  if (mintFailed) {
    emit.warn('could not mint a record-link URL for at least one attention event this cycle', { step: 'sweep' });
  }

  emit.enter('select');
  const watermark = state.watermark();
  const selectionInput = {
    tickets, comments, watermark, blocked,
    holds,
    seats: route.resolved!.seats,
    paused: state.pausedRoles(['dev', 'design', 'qa']),
    contract: tracker.contract,
  };
  const selection = selectRole(selectionInput);
  const actionable = actionableSummary(selectionInput, selection.pending);
  const decision: CycleDecision = {
    tickets, comments, roster, blocked, info, sweep, stranded, selection, actionable, watermark,
    selectionInput, attention: attentionCurrent,
  };

  // AFTER every role has been evaluated, never during: advancing inside the
  // first role's check would hide that role's new comments from the second.
  //
  // Advanced to the newest thing this cycle actually SAW, never to the clock
  // — using `now` would silently skip anything written between the fetch and
  // the write, and losing a signal is worse than repeating one.
  const advanced = state.advanceWatermark([...comments, ...tickets]);
  if (advanced !== watermark) {
    emit.emit(`watermark ${watermark.slice(0, 19)} -> ${advanced.slice(0, 19)}`, {
      step: 'poll', data: { from: watermark, to: advanced },
    });
  }
  if (selection.selected) {
    writeDigest(o, decision, selection.selected, state.dir);
    emit.emit(
      `roles with work: ${selection.pending.join(' ')} -> '${selection.selected}' wins this cycle` +
        `; the rest stay pending for the next`,
      { role: selection.selected, data: { rank: selection.ranks[selection.selected], pending: selection.pending } },
    );
  } else {
    emit.enter('idle');
    emit.emit('nothing pending');
  }
  return decision;
}

/**
 * Where a role's queue digest lives. Per route AND per role: a ship
 * serves several projects, and each seat gets its own slice.
 *
 * `route` here is already filename-safe (`routeSlug`'d by the caller) — a
 * raw `workspace/project` string would put a `/` in what has to be one path
 * segment.
 */
export const digestPath = (stateDir: string, route: string, role: RoleName): string =>
  join(stateDir, `digest-${route}-${role}.md`);

/**
 * Write the digest the winning seat will be handed.
 *
 * Without this the agent fetches the whole tracker itself at the top of every
 * run — ~691 KB of JSON, ~275 KB of it case history for tickets it will never
 * touch, paid again every cycle. The digest is the same data the poll has
 * already fetched, filtered to one role and already in pick order.
 *
 * Never fatal: a digest that cannot be rendered or written just means the
 * agent falls back to fetching, which is slower rather than wrong.
 */
export function writeDigest(
  o: CycleOptions, d: CycleDecision, role: RoleName, stateDir: string,
): boolean {
  const me = o.route.resolved?.seats[role];
  if (!me) return false;
  try {
    // The repo's own convention, not the crew's assumption — and each repo
    // has its own, so this is resolved per ticket rather than once for the
    // route's directory. Cached by directory: an area of a dozen repos
    // must not re-read and re-parse the same .crew.yaml once per row.
    const repoCache = new Map<string, ReturnType<typeof resolveRepoConfig>>();
    const repoFor = (dir: string) => {
      const hit = repoCache.get(dir);
      if (hit) return hit;
      const cfg = resolveRepoConfig(loadRepoConfig(dir), undefined, dir);
      repoCache.set(dir, cfg);
      return cfg;
    };
    const dirFor = (t: { repo_id?: string | null }) => dirForRepo(o.route, t.repo_id);
    // ISSUE-969: which template applies depends on the TICKET (its own
    // project tag), not only on the repo — a repo hosts tickets from more
    // than one project, so this is resolved per row via
    // `effectiveBranchTemplate`/`ticketBranchContext`, never cached
    // alongside the repo config itself.
    type BranchTicket = { issue_id: string; title?: string | null; issue_tag?: string | null; project_issue_prefix?: string | null };
    const render = (t: BranchTicket) => {
      const { tag, prefix } = ticketBranchContext(t as Ticket);
      return (template: string) => renderBranchName(template, { key: t.issue_id, title: t.title ?? undefined, role, tag, prefix });
    };

    const input = {
      dirFor,
      branchFor: (t: BranchTicket & { repo_id?: string | null }) => {
        const cfg = repoFor(dirFor(t) ?? o.route.dir);
        const { prefix } = ticketBranchContext(t as Ticket);
        return render(t)(effectiveBranchTemplate(cfg, prefix));
      },
      // Looked for in the ticket's own repository. Asking the route's
      // directory whether a second repo's branch exists always answered no,
      // which QA reads as "no worktree to test" (ISSUE-349).
      existingBranchFor: (t: BranchTicket & { repo_id?: string | null }) => {
        const dir = dirFor(t);
        if (!dir) return null;
        const cfg = repoFor(dir);
        const { prefix } = ticketBranchContext(t as Ticket);
        const name = effectiveBranchTemplate(cfg, prefix);
        const push = cfg.provenance['branch.push'] === 'default' ? name : cfg.branch.push;
        return branchForIssue(dir, t.issue_id, { name, push }, render(t));
      },
      tickets: role === 'triage'
        ? d.tickets.filter((t) => t.assignee_id === o.route.resolved?.seats.triage)
        : sliceFor(d.tickets, role),
      comments: d.comments,
      me,
      roster: d.roster,
      watermark: d.watermark,
      blocked: d.blocked,
      blockerInfo: d.info,
    };
    const text = role === 'qa' ? qaDigest(input) : buildingDigest(input);
    const path = digestPath(stateDir, routeSlug(o.route.route), role);
    writeFileSync(path, text);
    o.emit.emit(`queue digest written for ${role} (${Buffer.byteLength(text)} bytes)`, {
      data: { role, bytes: Buffer.byteLength(text) },
    });
    return true;
  } catch (e) {
    o.emit.warn(`could not write the ${role} digest — the agent will fetch the tracker itself: ${(e as Error).message}`);
    return false;
  }
}

/** The roster block the winning seat is handed. */
export function rosterFor(d: CycleDecision, route: Route, role: RoleName): string {
  return rosterMarkdown(d.roster, route.resolved!.seats[role] ?? null);
}

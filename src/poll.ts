/**
 * One cycle: fetch, sweep, select, and decide what to run.
 *
 * Ported from poll_for_work in bin/crew. Returns a decision; performing it is
 * the caller's job, which is what makes `--dry-run` a real dry run rather
 * than an approximation of one.
 */

import type { Connection, RoleName, Ship } from './config.ts';
import { configuredMembers } from './config.ts';
import { Tracker, type Ticket, type Comment } from './tracker.ts';
import { buildRoster, holdIds, rosterMarkdown, type Roster } from './roster.ts';
import {
  blockerInfoMap, missingBlockerIds, computeBlockedIds, planSweep,
  sweepDiagnostics, strandedNeedsInfo, rollUpParents,
  type BlockerInfo, type SweepStep,
} from './blocked.ts';
import { selectRole, sliceFor, actionableSummary, type Selection, type ActionableSummary } from './select.ts';
import { buildingDigest, qaDigest } from './digest.ts';
import { loadRepoConfig, resolveRepoConfig, renderBranchName } from './repo-config.ts';
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
}

export interface CycleOptions {
  conn: Connection;
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
  const { conn, ship, state, emit } = o;
  const tracker = new Tracker(conn, ship);
  emit.enter('poll');

  const [tickets, comments, crewRows] = await Promise.all([
    tracker.openTickets(),
    tracker.comments(200),
    tracker.crewRows(),
  ]);
  emit.emit(`${tickets.length} open ticket(s), ${comments.length} comment(s)`, {
    data: { tickets: tickets.length, comments: comments.length },
  });

  const extra = await tracker.ticketsByIds(missingBlockerIds(tickets));
  const info = blockerInfoMap(tickets, extra);
  const blocked = computeBlockedIds(tickets, info);

  emit.enter('sweep');
  const roster = buildRoster(configuredMembers(conn), crewRows);
  const holds = new Set(holdIds(roster));
  const diag = sweepDiagnostics(tickets, info);
  for (const d of diag.dangling) emit.warn(`dangling blocked_by reference, ignored: ${d}`);
  if (diag.selfBlocked.length) {
    emit.warn(`ticket(s) blocking themselves, parked permanently: ${diag.selfBlocked.join(', ')}`);
  }
  const sweep = planSweep(tickets, info, blocked);
  const stranded = strandedNeedsInfo(tickets, blocked, holds);
  for (const t of stranded) {
    emit.emit('needs_info with all blockers resolved — the operator\'s call, not the crew\'s', {
      ticket: t.issue_id,
    });
  }
  for (const r of rollUpParents(tickets)) {
    if (r.complete) {
      emit.emit(`every child is done — this coordinating ticket is too`, { ticket: r.parent.issue_id });
    }
  }

  emit.enter('select');
  const watermark = state.watermark();
  const selectionInput = {
    tickets, comments, watermark, blocked,
    holds,
    seats: conn.resolved!.seats,
    paused: state.pausedRoles(['dev', 'design', 'qa']),
    contract: tracker.contract,
  };
  const selection = selectRole(selectionInput);
  const actionable = actionableSummary(selectionInput, selection.pending);
  const decision: CycleDecision = {
    tickets, comments, roster, blocked, info, sweep, stranded, selection, actionable, watermark,
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
 * Where a role's queue digest lives. Per connection AND per role: a ship
 * serves several projects, and each seat gets its own slice.
 */
export const digestPath = (stateDir: string, connection: string, role: RoleName): string =>
  join(stateDir, `digest-${connection}-${role}.md`);

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
  const me = o.conn.resolved?.seats[role];
  if (!me) return false;
  try {
    // The repo's own convention, not the crew's assumption — and each repo
    // has its own, so this is resolved per ticket rather than once for the
    // connection's directory. Cached by directory: an area of a dozen repos
    // must not re-read and re-parse the same .crew.yaml once per row.
    const repoCache = new Map<string, ReturnType<typeof resolveRepoConfig>>();
    const repoFor = (dir: string) => {
      const hit = repoCache.get(dir);
      if (hit) return hit;
      const cfg = resolveRepoConfig(loadRepoConfig(dir), undefined, dir);
      repoCache.set(dir, cfg);
      return cfg;
    };
    const dirFor = (t: { repo_id?: string | null }) => dirForRepo(o.conn, t.repo_id);
    const render = (t: { issue_id: string; title?: string | null }) => (template: string) =>
      renderBranchName(template, { key: t.issue_id, title: t.title ?? undefined, role });

    const input = {
      dirFor,
      branchFor: (t: { issue_id: string; title?: string | null; repo_id?: string | null }) =>
        render(t)(repoFor(dirFor(t) ?? o.conn.dir).branch.name),
      // Looked for in the ticket's own repository. Asking the connection's
      // directory whether a second repo's branch exists always answered no,
      // which QA reads as "no worktree to test" (ISSUE-349).
      existingBranchFor: (t: { issue_id: string; title?: string | null; repo_id?: string | null }) => {
        const dir = dirFor(t);
        if (!dir) return null;
        const { name, push } = repoFor(dir).branch;
        return branchForIssue(dir, t.issue_id, { name, push }, render(t));
      },
      tickets: role === 'triage'
        ? d.tickets.filter((t) => t.assignee_id === o.conn.resolved?.seats.triage)
        : sliceFor(d.tickets, role),
      comments: d.comments,
      me,
      roster: d.roster,
      watermark: d.watermark,
      blocked: d.blocked,
      blockerInfo: d.info,
    };
    const text = role === 'qa' ? qaDigest(input) : buildingDigest(input);
    const path = digestPath(stateDir, o.conn.name, role);
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
export function rosterFor(d: CycleDecision, conn: Connection, role: RoleName): string {
  return rosterMarkdown(d.roster, conn.resolved!.seats[role] ?? null);
}

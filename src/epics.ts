/**
 * Keeping an epic's own status honest (CREW-1255).
 *
 * The poll has read the Epics table since ISSUE-384/385, but only to rank
 * tickets — nothing ever wrote an epic's status back, so it went stale the
 * moment work started and stayed stale after the last ticket shipped. Two
 * rules fix that, and both are about the epic's tickets as a whole:
 *
 *   1. every ticket of the epic is closed  -> the epic is done;
 *   2. a ticket of the epic is being worked -> the epic is in progress, even
 *      if it had already been marked done (work resumed) or was still only
 *      planned (work started).
 *
 * **Level-triggered, not event-triggered.** The rule is phrased as "when a
 * ticket closes, take stock", but the runner never sees the closing itself —
 * a lane, a Pair session, the release phase's stamp or a person may have made
 * it, on any machine. So each cycle compares what the epic says against what
 * its tickets say and plans the difference. That converges whoever moved the
 * ticket, and a cycle with nothing to correct plans nothing.
 *
 * **Across the whole epic, never one route's slice.** An epic spans areas
 * and repos, and a route only polls its own area — judging an epic by that
 * slice alone would call it done while another project's half is still open.
 * `Tracker.epicTickets` is deliberately not area-filtered for that reason.
 *
 * What is left alone, on purpose:
 *   - a `cancelled` epic, and one at any status this contract does not name —
 *     both are a person's decision the crew has no business overruling;
 *   - an epic with no tickets at all — nothing to take stock of, and "all
 *     zero of them are closed" must not read as done;
 *   - an epic whose remaining tickets are open but untouched (`new`,
 *     `accepted`, parked, waiting on a person): it is neither finished nor
 *     being worked, so whatever it says now stands. In particular a `done`
 *     epic that merely gains a newly filed ticket stays `done` until someone
 *     actually starts on it.
 *
 * Planning is pure and performs nothing, the same split as `planSweep`/
 * `applySweep` in blocked.ts, which is what keeps `--dry-run` a real dry run.
 */

import { StaleWriteError } from '@tablation/client';
import { closedStatuses, type Contract } from './contract.ts';
import type { Ticket } from './tracker.ts';

export interface EpicRow {
  id: string;
  status?: string | null;
  updated_at?: string;
  [k: string]: unknown;
}

export type EpicAction = 'complete' | 'start' | 'reopen';

export interface EpicStep {
  action: EpicAction;
  epic: EpicRow;
  /** What a person calls this epic (`EPIC-024`), falling back to its row id. */
  label: string;
  from: string;
  to: string;
  /** Why, in terms of its tickets — "all 6 tickets closed", "CREW-12 (in_progress)". */
  reason: string;
}

const epicOf = (t: Ticket, c: Contract): string | null => {
  const v = t[c.columns.epic];
  return typeof v === 'string' && v ? v : null;
};

const statusOf = (e: EpicRow, c: Contract): string | null => {
  const v = e[c.epics.statusColumn];
  return typeof v === 'string' && v ? v : null;
};

export function epicLabel(e: EpicRow, c: Contract): string {
  const v = e[c.epics.keyColumn];
  return typeof v === 'string' && v ? v : e.id;
}

/** The epics this contract lets the crew move at all. */
export function trackedEpics(epics: EpicRow[], c: Contract): EpicRow[] {
  const s = c.epics.statuses;
  const movable = new Set([s.planned, s.building, s.done]);
  return epics.filter((e) => {
    const status = statusOf(e, c);
    return status !== null && movable.has(status);
  });
}

/**
 * A ticket somebody is actually on: being built, handed off, in QA, under
 * review, or verified and waiting for its release. Deliberately narrower
 * than "open" — see the module comment on untouched tickets.
 */
export function workedStatuses(c: Contract): Set<string> {
  const s = c.statuses;
  return new Set(
    [s.building, s.handoff, s.verifying, s.verified, s.reviewing].filter((v): v is string => !!v),
  );
}

/**
 * Which epics need their CLOSED tickets fetched before they can be judged:
 * the ones not yet done that have nothing outstanding. Only those can be
 * about to complete, and the fetch is what tells "every ticket closed" apart
 * from "never had a ticket". Every other epic is decided by its outstanding
 * tickets alone, which is what keeps this to a handful of rows per cycle
 * rather than an epic's whole history.
 */
export function epicsNeedingClosedCheck(epics: EpicRow[], outstanding: Ticket[], c: Contract): string[] {
  const hasOutstanding = new Set(outstanding.map((t) => epicOf(t, c)));
  return trackedEpics(epics, c)
    .filter((e) => statusOf(e, c) !== c.epics.statuses.done && !hasOutstanding.has(e.id))
    .map((e) => e.id);
}

/**
 * What the epic sync would change, and nothing more.
 *
 * `outstanding` is every not-closed ticket of these epics; `closed` is the
 * closed tickets of the epics `epicsNeedingClosedCheck` named. A ticket at a
 * closed status that turns up in `outstanding` anyway is ignored rather than
 * trusted, so a caller that over-fetches cannot hold an epic open.
 */
export function planEpicSync(
  epics: EpicRow[], outstanding: Ticket[], closed: Ticket[], c: Contract,
): EpicStep[] {
  const s = c.epics.statuses;
  const isClosed = new Set(closedStatuses(c));
  const worked = workedStatuses(c);

  const openByEpic = new Map<string, Ticket[]>();
  for (const t of outstanding) {
    const id = epicOf(t, c);
    if (!id || isClosed.has(t.status)) continue;
    openByEpic.set(id, [...(openByEpic.get(id) ?? []), t]);
  }
  const closedCount = new Map<string, number>();
  for (const t of closed) {
    const id = epicOf(t, c);
    if (!id || !isClosed.has(t.status)) continue;
    closedCount.set(id, (closedCount.get(id) ?? 0) + 1);
  }

  const steps: EpicStep[] = [];
  for (const epic of trackedEpics(epics, c)) {
    const from = statusOf(epic, c)!;
    const open = openByEpic.get(epic.id) ?? [];
    const label = epicLabel(epic, c);

    if (open.length === 0) {
      const n = closedCount.get(epic.id) ?? 0;
      if (from !== s.done && n > 0) {
        steps.push({
          action: 'complete', epic, label, from, to: s.done,
          reason: n === 1 ? 'its only ticket is closed' : `all ${n} tickets closed`,
        });
      }
      continue;
    }

    const active = open.filter((t) => worked.has(t.status));
    if (active.length && from !== s.building) {
      steps.push({
        action: from === s.done ? 'reopen' : 'start',
        epic, label, from, to: s.building,
        reason: active.map((t) => `${t.issue_tag ?? t.issue_id} (${t.status})`).join(', '),
      });
    }
  }
  return steps;
}

export interface EpicWriter {
  updateEpic(id: string, patch: Record<string, unknown>, expectedUpdatedAt?: string): Promise<unknown>;
}

type Log = {
  emit(msg: string, extra?: Record<string, unknown>): unknown;
  warn(msg: string, extra?: Record<string, unknown>): unknown;
};

export const describeEpicStep = (s: EpicStep): string =>
  `epic ${s.label}: ${s.from} -> ${s.to} (${s.reason})`;

/**
 * Apply the plan. Each write is conditional on the epic not having moved
 * since it was read: two routes of one workspace plan the same correction in
 * the same fleet-wide run, and a person may be editing the epic at that very
 * moment. Losing that race is not a failure — the epic is re-judged from
 * scratch next cycle, by which point the other write is simply what it says.
 */
export async function applyEpicSync(
  writer: EpicWriter, steps: EpicStep[], c: Contract, log: Log,
): Promise<{ updated: number; contended: number; failed: number }> {
  let updated = 0;
  let contended = 0;
  let failed = 0;
  for (const step of steps) {
    const data = { epic: step.label, from: step.from, to: step.to };
    try {
      await writer.updateEpic(step.epic.id, { [c.epics.statusColumn]: step.to }, step.epic.updated_at);
      updated++;
      log.emit(describeEpicStep(step), { step: 'sweep', data });
    } catch (e) {
      if (e instanceof StaleWriteError) {
        contended++;
        log.emit(`epic ${step.label} changed since it was read — left for the next cycle`, { step: 'sweep', data });
        continue;
      }
      failed++;
      log.warn(`could not move epic ${step.label} to ${step.to}: ${(e as Error).message}`, { step: 'sweep', data });
    }
  }
  return { updated, contended, failed };
}

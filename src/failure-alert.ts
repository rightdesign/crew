/**
 * The fallback for a release failure when nobody has wired a notify hook.
 *
 * `notify()` (notify.ts) is a thin pass-through to whatever the operator
 * configured on `route.hooks.notify` — and that key has been accepted since
 * the Node port (ISSUE-343) and invoked for exactly nobody, because nothing
 * is configured there by default. A release that stops on a failure
 * (`describeRelease`'s `level: 'fail'` outcomes — tests, deploy, or build)
 * is worth more than a log line: contrast synthesis's bash dev-loop.sh,
 * which has always auto-filed a ticket on a release/deploy failure
 * (`file_deploy_failure_ticket`). This is that same behaviour for the
 * Node runner, built in rather than left to per-route configuration, so it
 * fires with no `crew.yaml` wiring at all.
 *
 * A recurring failure updates the same ticket instead of piling up a new
 * one every cycle — matched on the exact headline, which is deterministic
 * per route and per failure kind (`"route: build FAILED"` etc).
 */

import type { Notification } from './notify.ts';
import type { Ticket } from './tracker.ts';

/** A marker in the ticket body, so a repeat is recognisable as this path's. */
export const FAILURE_ALERT_MARKER = '<!-- crew:failure-alert -->';

export interface FailureAlertWriter {
  fileTicket(fields: Record<string, unknown>): Promise<Ticket>;
  postEvent(ticketId: string, body: string, memberId: string): Promise<void>;
}

export interface FailureAlertLog {
  emit(msg: string, extra?: Record<string, unknown>): unknown;
  warn(msg: string, extra?: Record<string, unknown>): unknown;
}

export type FailureAlertOutcome =
  | { kind: 'filed'; issueId?: string }
  | { kind: 'commented'; issueId?: string }
  | { kind: 'failed'; why: string };

/** An already-open ticket this same path filed for this exact failure. */
export function findOpenFailureAlert(tickets: Ticket[], headline: string): Ticket | undefined {
  return tickets.find((t) => t.title === headline);
}

function ticketBody(n: Notification, route: string): string {
  return `${FAILURE_ALERT_MARKER}\n${n.detail ?? n.headline}\n\nFiled automatically — no ` +
    `\`notify\` hook is configured for route \`${route}\`, so this is the crew's built-in ` +
    'fallback rather than a silent log line. Configure `hooks.notify` on this route to replace it.';
}

/**
 * File a new ticket for this failure, or comment on one already open for the
 * same headline. Never throws — the same reasoning as `notify()` itself and
 * `stranded-verified.ts`'s apply: this runs after the release has already
 * done everything it can, and a tracker blip here must not turn a good
 * outcome into a failed one.
 */
export async function applyFailureAlert(
  writer: FailureAlertWriter,
  n: Notification,
  route: string,
  openTickets: Ticket[],
  memberId: string,
  log: FailureAlertLog,
  dryRun: boolean,
): Promise<FailureAlertOutcome> {
  const existing = findOpenFailureAlert(openTickets, n.headline);

  if (existing) {
    if (dryRun) {
      log.emit(`would comment on ${existing.issue_id} — same failure recurring`, { step: 'release' });
      return { kind: 'commented', issueId: existing.issue_id };
    }
    try {
      await writer.postEvent(existing.id, `${FAILURE_ALERT_MARKER}\nStill failing: ${n.detail ?? n.headline}`, memberId);
      log.warn(`release failure recurring — commented on ${existing.issue_id}`, { step: 'release' });
      return { kind: 'commented', issueId: existing.issue_id };
    } catch (e) {
      return { kind: 'failed', why: (e as Error).message };
    }
  }

  if (dryRun) {
    log.emit(`would file a ticket: ${n.headline}`, { step: 'release' });
    return { kind: 'filed' };
  }
  try {
    const created = await writer.fileTicket({
      title: n.headline,
      description: ticketBody(n, route),
      report_type: 'bug',
      severity: 's2',
      reporter_name: 'Crew release',
    });
    log.warn(`release failure — filed ${created.issue_id ?? created.id}`, { step: 'release' });
    return { kind: 'filed', issueId: created.issue_id };
  } catch (e) {
    return { kind: 'failed', why: (e as Error).message };
  }
}

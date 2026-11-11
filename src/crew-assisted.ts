/**
 * Mark a ticket `crew_assisted` when a Dev or QA run starts on it (CREW-3258).
 *
 * The column is an optional Yes/No on Issues that records the fact "the crew's
 * building or verifying lane has worked this ticket", which `agent_runs`
 * (every role, triage included) cannot say. Rules, all deliberate:
 *
 *  - only the roles in the route's `assistedRoles` count (default dev + qa);
 *    an empty list turns the marking off for the route;
 *  - a table without the column has not adopted the feature: no read, no write;
 *  - it is never written back to false, and a ticket already true costs no
 *    write at all (the caller passes the row it already read);
 *  - it is called only after a run is cleared to launch, so a run refused
 *    earlier (no hold, signed-out harness, paused seat) never reaches it;
 *  - a failed write is logged by the caller and never stops the run.
 */

import { DEFAULT_ASSISTED_ROLES, type RoleName, type Route } from './config.ts';
import type { Contract } from './contract.ts';
import type { Ticket } from './tracker.ts';

export interface AssistedTracker {
  contract: Contract;
  hasCrewAssistedColumn(): Promise<boolean>;
  updateTicket(id: string, patch: Record<string, unknown>): Promise<unknown>;
}

/** True when a run of `role` on this route counts as the crew having worked the ticket. */
export function countsAsAssisted(route: Pick<Route, 'assistedRoles'>, role: RoleName): boolean {
  return (route.assistedRoles ?? DEFAULT_ASSISTED_ROLES).includes(role);
}

/**
 * Set `crew_assisted` true on `ticket` if this run should. Returns whether a
 * write was made. `ticket` is the row as already read for the run.
 */
export async function markCrewAssisted(
  tracker: AssistedTracker, route: Pick<Route, 'assistedRoles'>, role: RoleName, ticket: Ticket,
): Promise<boolean> {
  if (!countsAsAssisted(route, role)) return false;
  const column = tracker.contract.columns.crewAssisted;
  if (ticket[column] === true) return false;
  if (!(await tracker.hasCrewAssistedColumn())) return false;
  await tracker.updateTicket(ticket.id, { [column]: true });
  return true;
}

/**
 * The call a launch site makes once its run is cleared to start. `ticket` is
 * the row when the site already read it; otherwise the row is read here, and
 * only for a role that counts. Never throws: the marking is a convenience and
 * must not stop the run, so a failure goes to `warn`.
 */
export async function markCrewAssistedAtLaunch(
  tracker: AssistedTracker & { ticket(id: string): Promise<Ticket> },
  route: Pick<Route, 'assistedRoles'>, role: RoleName, ticketId: string | null, ticket: Ticket | undefined,
  warn: (msg: string) => void,
): Promise<void> {
  if (!ticketId || !countsAsAssisted(route, role)) return;
  try {
    await markCrewAssisted(tracker, route, role, ticket ?? (await tracker.ticket(ticketId)));
  } catch (e) {
    warn(`could not mark the ticket crew-assisted: ${(e as Error).message}`);
  }
}

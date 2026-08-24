/**
 * Closing out a release on the board.
 *
 * After a release ships, the tickets it carried move from `verified` to
 * `deployed` and record which version carried them. That is the only place
 * `released_version` is written, and it is what turns "this shipped" from a
 * commit message into something the board can be filtered by.
 *
 * Deliberately NOT fatal: this runs *after* a successful deploy, and a
 * tracker that is briefly unreachable must not turn a good release into a
 * failed one. The stamp is retried next cycle, because the tickets are still
 * at `verified` and still named in commits past the last release.
 */

import type { Tracker, Ticket } from './tracker.ts';
import type { Contract } from './contract.ts';
import type { Emitter } from './events.ts';
import { commitBodies } from './git.ts';

export interface StampPlan {
  ticket: Ticket;
  /** Why it is being stamped: named in the released range. */
  reason: string;
}

/**
 * Which verified tickets this release actually carried.
 *
 * Read from the commits in the released range rather than from whatever the
 * merge phase happened to merge this cycle: a ticket merged on an earlier
 * cycle whose deploy failed is carried by THIS release, and would otherwise
 * sit at `verified` forever with its work already live.
 */
export function planStamp(
  cwd: string, tickets: Ticket[], contract: Contract,
  fromSha: string | null, toSha: string,
): StampPlan[] {
  if (!fromSha) return [];
  const bodies = commitBodies(cwd, `${fromSha}..${toSha}`);
  return tickets
    .filter((t) => t.status === contract.statuses.verified)
    .filter((t) => new RegExp(`(^|[^0-9A-Za-z_-])${t.issue_id}([^0-9]|$)`).test(bodies))
    .map((t) => ({ ticket: t, reason: `named in ${fromSha.slice(0, 8)}..${toSha.slice(0, 8)}` }));
}

export async function applyStamp(
  tracker: Tracker, plan: StampPlan[], version: string | undefined,
  contract: Contract, emit: Emitter, dryRun: boolean,
): Promise<number> {
  let stamped = 0;
  const at = new Date().toISOString();
  for (const { ticket } of plan) {
    if (dryRun) {
      emit.emit(`would stamp -> ${contract.statuses.deployed}${version ? ` (${version})` : ''}`, {
        ticket: ticket.issue_id,
      });
      stamped++;
      continue;
    }
    try {
      await tracker.updateTicket(ticket.id, {
        status: contract.statuses.deployed,
        ...(version ? { released_version: version, released_at: at } : {}),
      });
      emit.emit(`stamped ${contract.statuses.deployed}${version ? ` (${version})` : ''}`, {
        ticket: ticket.issue_id,
      });
      stamped++;
    } catch (e) {
      // One ticket failing must not abandon the rest, and none of it fails
      // the release — the work is already live.
      emit.warn(`could not stamp: ${(e as Error).message}`, { ticket: ticket.issue_id });
    }
  }
  return stamped;
}

/**
 * Ship affinity (CREW-1386): a ticket one ship has claimed is off-limits to
 * every other ship until it is released, handed to QA, or the ship is dead.
 *
 * Before this, ownership was the assignee SEAT, seats are per ship, and every
 * hand-back (a QA bounce, a merge-conflict hand-back) clears the seat — which
 * `buildingRoleHasWork` reads as "back up for grabs" to EVERY ship. Two ships
 * built CREW-1383 that way. `Issues.held_by_ship_id` is the ship-level ownership the
 * board was missing: the claim stamps it, hand-backs leave it alone (they only
 * clear `assignee_id`), and selection on any other ship skips the ticket.
 *
 * Pure: `select.ts` and `claim.ts` decide with these, nothing here writes.
 */

import type { ShipRow, Ticket } from './tracker.ts';
import type { Contract } from './contract.ts';

/**
 * The launchd fire interval in seconds and how many missed cycles make a ship
 * dead. Mirrors `cli.ts`'s `CYCLE_SECONDS`/`STALE_CYCLES` (ISSUE-380), which
 * cannot be imported (cli.ts is a script). Deliberately a little more patient
 * than the "not seen recently" display threshold's 3 cycles: this decides
 * whether another ship may TAKE OVER a held ticket, and a false "dead" is the
 * duplicated-effort bug this whole ticket exists to stop.
 */
const CYCLE_SECONDS = 120;
export const SHIP_DEAD_AFTER_CYCLES = 10;

export interface AffinityContext {
  /** This ship's own Ships row id; null when it has none (affinity cannot apply). */
  myShipId: string | null;
  ships: ShipRow[];
  contract: Contract;
  /** Epoch ms; injectable for tests. */
  now?: number;
}

/** Whether a ship has heartbeated recently enough to still own what it claimed. */
export function shipIsAlive(ship: ShipRow | undefined, now: number): boolean {
  if (!ship?.last_seen) return false;
  const seen = Date.parse(ship.last_seen);
  return Number.isFinite(seen) && now - seen <= SHIP_DEAD_AFTER_CYCLES * CYCLE_SECONDS * 1000;
}

/** The ship a ticket is held by, or null if it carries no (or an empty) `held_by_ship_id`. */
export function ticketHolderShipId(t: Ticket, contract: Contract): string | null {
  const v = t[contract.columns.heldBy];
  return typeof v === 'string' && v ? v : null;
}

/**
 * True when ANOTHER, still-living ship holds this ticket.
 *
 * The hold is the dedicated `held_by_ship_id` column, not `ship_id` ("filed
 * from", CREW-1371), so it holds at EVERY status a building role can see —
 * `accepted` included. That is what makes an operator's re-`accepted` of a
 * held ticket a resume rather than a fresh claim: the owning ship's hold
 * survives the status flip. Only `fixed`/`qa` are exempt: those are QA's, and
 * any ship's QA may verify once the branch is on origin.
 *
 * A ship id that matches no Ships row at all reads as dead: the row was
 * deleted, so nobody is left to resume it.
 */
export function heldByOtherShip(t: Ticket, a: AffinityContext): boolean {
  const statuses = a.contract.statuses;
  if ([statuses.handoff, statuses.verifying].includes(t.status)) return false;
  return heldByLiveOtherShip(t, a);
}

/**
 * `heldByOtherShip` WITHOUT the `fixed`/`qa` exemption: true when another
 * living ship holds the ticket at any status. The claim needs this one: a QA
 * seat may verify a held `qa` ticket, but a resumption must never overwrite a
 * live ship's stamp to do so (the CREW-1394 defect).
 */
export function heldByLiveOtherShip(t: Ticket, a: AffinityContext): boolean {
  if (!a.myShipId) return false;
  const holder = ticketHolderShipId(t, a.contract);
  if (!holder || holder === a.myShipId) return false;
  const owner = a.ships.find((s) => s.id === holder);
  return shipIsAlive(owner, a.now ?? Date.now());
}

/** The ship's display name for a comment; never a bare uuid when a name is known. */
export function shipName(ships: ShipRow[], id: string | null | undefined): string {
  if (!id) return 'an unknown ship';
  return ships.find((s) => s.id === id)?.name?.trim() || id;
}

/**
 * This ship's Ships row id, matched by name the way `Tracker.myShipRow` does
 * (exact string; ambiguous or absent is no id — affinity then simply does not
 * apply rather than guessing).
 */
export function shipIdByName(ships: ShipRow[], name: string): string | null {
  const mine = ships.filter((r) => (r.name ?? '').trim() === name.trim());
  return mine.length === 1 ? mine[0]!.id : null;
}

/**
 * CREW-1386 rule 4: the operator set a ticket back to `accepted` while THIS
 * ship held it. The hold survives the flip, so the claim is a resume; say so
 * once, as an `event` comment, so the operator learns the flip was
 * unnecessary. Best effort — a failed comment never blocks the work.
 */
export async function noteReaccepted(
  tracker: { postEvent(ticketId: string, body: string, memberId: string): Promise<void> },
  result: { ticket: Ticket | null; reaccepted: boolean },
  seat: string,
  shipLabel: string,
): Promise<void> {
  if (!result.reaccepted || !result.ticket) return;
  try {
    await tracker.postEvent(
      result.ticket.id,
      `Re-accepted while held by ${shipLabel}; resuming there, not re-claiming. Setting a held ticket back to \`accepted\` is not needed — to move it to another ship, clear \`held_by_ship_id\`.`,
      seat,
    );
  } catch {
    // an audit comment; the resume itself already happened
  }
}

/**
 * CREW-1386 rule 3: the hold is for the BUILDING roles, so it ends when the
 * ticket leaves them — `fixed` (handed to QA) or `verified`. The personas tell
 * the agent to clear it in the same write, but that is an instruction to a
 * model; this is the runner's own guarantee, applied from the poll's view of
 * the board so a hold an agent forgot (or a session that died after setting
 * `fixed`) cannot linger. Closed tickets are outside every poll and never
 * reach this; their hold is inert (selection never offers them).
 */
export function planHoldReleases(tickets: Ticket[], contract: Contract): Ticket[] {
  const ends = [contract.statuses.handoff, contract.statuses.verified];
  return tickets.filter((t) => ends.includes(t.status) && ticketHolderShipId(t, contract) !== null);
}

/** Clear the hold on each planned ticket. Conditional and best effort: a ticket that moved is left for the next poll. */
export async function applyHoldReleases(
  writer: { updateTicket(id: string, patch: Record<string, unknown>, expectedUpdatedAt?: string): Promise<unknown> },
  tickets: Ticket[],
  contract: Contract,
  emit: { emit(msg: string, extra?: Record<string, unknown>): unknown; warn(msg: string, extra?: Record<string, unknown>): unknown },
): Promise<number> {
  let cleared = 0;
  for (const t of tickets) {
    try {
      await writer.updateTicket(t.id, { [contract.columns.heldBy]: null }, t.updated_at);
      cleared++;
      emit.emit(`released ship hold (${t.status})`, { ticket: t.issue_id, step: 'sweep' });
    } catch (e) {
      emit.warn(`could not release ship hold: ${(e as Error).message}`, { ticket: t.issue_id, step: 'sweep' });
    }
  }
  return cleared;
}

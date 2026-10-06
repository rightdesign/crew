/**
 * Staleness sweep (CREW-1401): the mirror of `strandedNeedsInfo` for work a
 * ship has gone quiet on. An `in_progress`, `fixed` or `qa` ticket whose last
 * activity is older than `STALLED_AFTER_CYCLES` cycles and which no ship is
 * engaged on has stopped moving, and nothing else in the loop notices: the
 * ticket is not `needs_info`, not blocked, and its holder simply is not
 * running. CREW-1383 and CREW-1389 each sat that way until a person read the
 * comments.
 *
 * A stalled ticket's status and assignee are never written. A ticket is
 * either held (`held_by_ship_id`) or unheld, and an unheld `fixed` or `qa`
 * ticket is just waiting in line for any QA seat, as is an unheld `in_progress`
 * one QA bounced back to the building lane: a backed-up queue, `crew pause` or
 * a machine asleep overnight all look like silence, and pulling a merely queued
 * ticket out of its lane to `needs_info` would be the sweep causing the stall.
 * So in both cases a `crew:stalled` event comment is posted once, and:
 *
 *   - a holding ship raises a `stalled:<key>` ship-attention item on itself
 *     (each ship runs this sweep over the same board, so the holder raises its
 *     own — no ship writes another ship's attention);
 *   - an unheld ticket gets the comment alone.
 *
 * Never touched: a ticket assigned to a hold row (a person is driving it), and
 * one whose holder is engaged on it right now.
 *
 * Pure planning here; `applyStalled` writes. Nothing is stored: activity is
 * read off the ticket and its comments, and the event comment's marker is the
 * only memory, so one stall produces one comment however many cycles it lasts.
 */

import type { Contract } from './contract.ts';
import type { Comment, ShipRow, Ticket } from './tracker.ts';
import { shipName, ticketHolderShipId } from './ship-affinity.ts';
import { raiseShipAttention, clearShipAttention, type ShipAttentionItem } from './ship-attention.ts';
import type { Emitter } from './events.ts';
import type { Route, Ship } from './config.ts';
import type { State } from './state.ts';

/** Cycles of silence before an unengaged ticket counts as stalled. */
export const STALLED_AFTER_CYCLES = 30;
/** Mirrors `ship-affinity.ts`'s `CYCLE_SECONDS`, which is not exported. */
const CYCLE_MS = 120 * 1000;
export const STALLED_AFTER_MS = STALLED_AFTER_CYCLES * CYCLE_MS;

export const STALLED_MARKER = '<!-- crew:stalled -->';

/** The key of a ticket's ship-attention item. */
export const stalledKey = (issueId: string): string => `stalled:${issueId}`;

export interface Stalled {
  ticket: Ticket;
  /** The holding ship's row id, or null when the ticket carries no hold. */
  holderShipId: string | null;
  /** Epoch ms of the most recent activity on the ticket. */
  lastActivityAt: number;
  /** True once a `crew:stalled` event newer than that activity is already on the ticket. */
  announced: boolean;
}

const ms = (iso: string | null | undefined): number => {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/**
 * `holds` is the set of roster hold ids. `now` is injectable for tests.
 * Comments for tickets this poll did not fetch are simply absent, which only
 * ever makes a ticket look quieter than it is — the ticket's own `updated_at`
 * is the floor.
 */
export function planStalled(
  tickets: Ticket[],
  comments: Comment[],
  ships: ShipRow[],
  contract: Contract,
  holds: Set<string> = new Set(),
  now: number = Date.now(),
): Stalled[] {
  const watched = new Set([contract.statuses.building, contract.statuses.handoff, contract.statuses.verifying]);
  const byTicket = new Map<string, Comment[]>();
  for (const c of comments) {
    const list = byTicket.get(c.ticket_id);
    if (list) list.push(c);
    else byTicket.set(c.ticket_id, [c]);
  }
  const out: Stalled[] = [];
  for (const t of tickets) {
    if (!watched.has(t.status)) continue;
    if (t.assignee_id && holds.has(t.assignee_id)) continue;
    const mine = byTicket.get(t.id) ?? [];
    const lastMarker = Math.max(0, ...mine.filter((c) => (c.body ?? '').includes(STALLED_MARKER)).map((c) => ms(c.created_at)));
    const lastActivityAt = Math.max(
      ms(t.updated_at),
      ...mine.filter((c) => !(c.body ?? '').includes(STALLED_MARKER)).map((c) => ms(c.created_at)),
    );
    if (now - lastActivityAt < STALLED_AFTER_MS) continue;
    if (ships.some((s) => s.engaged && s.engaged_ticket_id === t.id)) continue;
    out.push({
      ticket: t, holderShipId: ticketHolderShipId(t, contract), lastActivityAt, announced: lastMarker > lastActivityAt,
    });
  }
  return out;
}

export function stalledComment(s: Stalled, ships: ShipRow[], now: number = Date.now()): string {
  const mins = Math.round((now - s.lastActivityAt) / 60_000);
  const who = s.holderShipId
    ? `Held by ${shipName(ships, s.holderShipId)}, which is not engaged on it. That ship has an attention item open; the ticket is otherwise left as it is, and resumes the moment the ship picks it back up.`
    : `No ship holds it and none is engaged on it. It is waiting for the next ship that polls its lane; its status and assignee are left as they are.`;
  return `${STALLED_MARKER}
**Stalled — no activity on \`${s.ticket.issue_id}\` for ${mins} minutes (\`${s.ticket.status}\`).**

${who}`;
}

export interface StalledWriter {
  postEvent(ticketId: string, body: string, memberId: string): Promise<void>;
}

export interface StalledLog {
  emit(msg: string, extra?: Record<string, unknown>): unknown;
  warn(msg: string, extra?: Record<string, unknown>): unknown;
}

export interface StalledResult {
  announced: number;
  failed: number;
  /** Attention items this ship should hold, for the caller to raise; the rest it should clear. */
  attention: ShipAttentionItem[];
}

/**
 * Writes the event comment once per stall. Returns the attention items for the tickets this
 * ship holds; `stalled:*` items not among them are the caller's to clear.
 * Best effort per ticket: one failed write never stops the rest.
 */
export async function applyStalled(
  writer: StalledWriter,
  stalled: Stalled[],
  ships: ShipRow[],
  memberId: string,
  myShipId: string | null,
  log: StalledLog,
  dryRun: boolean,
  now: number = Date.now(),
): Promise<StalledResult> {
  const r: StalledResult = { announced: 0, failed: 0, attention: [] };
  for (const s of stalled) {
    const x = { ticket: s.ticket.issue_id, step: 'sweep' };
    if (s.holderShipId && s.holderShipId === myShipId) {
      r.attention.push({
        kind: 'stalled', key: stalledKey(s.ticket.issue_id),
        message: `${s.ticket.issue_id} is held by this ship but has been quiet for ${Math.round((now - s.lastActivityAt) / 60_000)} minutes with nothing engaged on it`,
        since: new Date(s.lastActivityAt + STALLED_AFTER_MS).toISOString(),
      });
    }
    if (s.announced) continue;
    if (dryRun) {
      log.emit('would flag as stalled', x);
      continue;
    }
    try {
      await writer.postEvent(s.ticket.id, stalledComment(s, ships, now), memberId);
      r.announced++;
      log.warn(`stalled at ${s.ticket.status} — ${s.holderShipId ? 'flagged on the holder' : 'commented, no holder'}`, x);
    } catch (e) {
      r.failed++;
      log.warn(`could not flag as stalled: ${(e as Error).message}`, x);
    }
  }
  return r;
}

/**
 * The poll's stalled plan, applied: the comments and hand-offs from
 * `applyStalled`, then this ship's `stalled:*` attention items raised for the
 * tickets it holds and cleared for every one that is no longer stalled (moved
 * on, engaged again, or closed), so the flag resolves itself.
 */
export async function runStalledSweep(
  o: {
    tracker: StalledWriter & { contract: Contract };
    state: State;
    emit: Emitter;
    route?: Route;
    ship?: Ship;
    ships: ShipRow[];
    memberId: string;
    myShipId: string | null;
    dryRun?: boolean;
  },
  stalled: Stalled[],
): Promise<StalledResult> {
  const r = await applyStalled(
    o.tracker, stalled, o.ships, o.memberId, o.myShipId, o.emit, o.dryRun ?? false,
  );
  if (o.dryRun) return r;
  const keep = new Set(r.attention.map((i) => i.key));
  for (const item of r.attention) await raiseShipAttention({ state: o.state, emit: o.emit, route: o.route, ship: o.ship }, item);
  for (const open of o.state.shipAttention().previous()) {
    if (open.kind === 'stalled' && !keep.has(open.key)) clearShipAttention(o.state, open.key);
  }
  return r;
}

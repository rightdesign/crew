/**
 * A configured seat whose Crew row is gone (CREW-3449). A route's seat id can
 * outlive its row (an auto-created agent row deleted in the UI); the lane for
 * that role then only takes tickets assigned to an id that matches nothing,
 * and nothing says so. `crew agents sync` reported it (CREW-3389), but most
 * operators never run that by hand. This is the one detector `crew status`,
 * `crew doctor` and the run cycle share.
 *
 * Only a definite 404 counts as missing. A network failure, a 403 or a 5xx is
 * `unknown`: it raises nothing and clears nothing, so an outage never reads as
 * a deleted seat. Nothing here repairs anything; picking the replacement row
 * is `crew connect`'s job.
 */

import { TablationApiError } from '@tablation/client';
import { ROLE_NAMES, routeSlug, type RoleName, type Route } from './config.ts';
import type { DoctorProblem } from './doctor-problems.ts';
import type { ShipAttentionItem } from './ship-attention.ts';

export type SeatPresence = 'present' | 'missing' | 'unknown';

export interface SeatProbe {
  /** A role name, or `release` for the release phase's own seat. */
  role: RoleName | 'release';
  seatId: string;
  state: SeatPresence;
  /** `unknown` only: why the read could not decide. */
  detail?: string;
}

/** What an operator does about a missing seat. */
export const SEAT_MISSING_REMEDY = 'run `crew connect` to pick a seat';

/** Reads one Crew row: the row, or null when the tracker answers 404. Any other failure throws. */
export type CrewRowReader = (id: string) => Promise<unknown | null>;

/** Every distinct seat id the route stores (the polled roles, `pair`, and an explicit release seat), probed once each. */
export async function probeSeats(route: Route, read: CrewRowReader): Promise<SeatProbe[]> {
  const r = route.resolved;
  if (!r) return [];
  const wanted: Array<{ role: SeatProbe['role']; seatId: string }> = [];
  for (const role of ROLE_NAMES) if (r.seats[role]) wanted.push({ role, seatId: r.seats[role]! });
  if (r.releaseSeat) wanted.push({ role: 'release', seatId: r.releaseSeat });
  const byId = new Map<string, Promise<{ state: SeatPresence; detail?: string }>>();
  const probeOne = async (id: string): Promise<{ state: SeatPresence; detail?: string }> => {
    try {
      return { state: (await read(id)) === null ? 'missing' : 'present' };
    } catch (e) {
      if (e instanceof TablationApiError && e.status === 404) return { state: 'missing' };
      return { state: 'unknown', detail: (e as Error).message };
    }
  };
  for (const w of wanted) if (!byId.has(w.seatId)) byId.set(w.seatId, probeOne(w.seatId));
  return Promise.all(wanted.map(async (w) => ({ ...w, ...(await byId.get(w.seatId)!) })));
}

/** The key of a seat's `seat_missing` item: one per route and role, so two roles never mask each other. */
export const seatMissingKey = (route: string, role: string): string => `seat_missing:${route}:${role}`;

export function seatMissingMessage(route: string, role: string): string {
  return `${route}: the ${role} seat's Crew row no longer exists, so that role is skipped — ${SEAT_MISSING_REMEDY}. Clears automatically once the seat resolves`;
}

export function seatMissingItem(route: string, role: string, nowIso = new Date().toISOString()): ShipAttentionItem {
  return { kind: 'seat_missing', key: seatMissingKey(route, role), since: nowIso, message: seatMissingMessage(route, role) };
}

/**
 * Raises an item for each missing seat and clears the item of each seat that
 * is present. An `unknown` seat is left exactly as it was.
 */
export async function reconcileSeatAttention(
  route: Route, probes: SeatProbe[],
  io: { raise: (item: ShipAttentionItem) => Promise<unknown>; clear: (key: string) => void },
): Promise<void> {
  const slug = routeSlug(route.route);
  for (const p of probes) {
    if (p.state === 'missing') await io.raise(seatMissingItem(slug, p.role));
    else if (p.state === 'present') io.clear(seatMissingKey(slug, p.role));
  }
}

/** Roles (not `release`) whose seat is missing. */
export const missingRoles = (probes: SeatProbe[]): Array<RoleName | 'release'> =>
  probes.filter((p) => p.state === 'missing').map((p) => p.role);

/**
 * `open` as `status` should show it: the stored `seat_missing` items, corrected
 * by a live probe so a seat that came back disappears and one that vanished
 * appears without waiting for the next cycle. An `unknown` seat keeps whatever
 * is stored; an item already stored keeps its `since`.
 */
export function mergeSeatAttention(open: ShipAttentionItem[], route: Route, probes: SeatProbe[], nowIso = new Date().toISOString()): ShipAttentionItem[] {
  const slug = routeSlug(route.route);
  const settled = new Map(probes.filter((p) => p.state !== 'unknown').map((p) => [seatMissingKey(slug, p.role), p.state] as const));
  const kept = open.filter((i) => i.kind !== 'seat_missing' || !settled.has(i.key) || settled.get(i.key) === 'missing');
  const have = new Set(kept.map((i) => i.key));
  const added = probes
    .filter((p) => p.state === 'missing' && !have.has(seatMissingKey(slug, p.role)))
    .map((p) => seatMissingItem(slug, p.role, nowIso));
  return [...kept, ...added];
}

/** One failing `crew doctor` finding per missing seat, with the same remedy the attention item carries. */
export function seatMissingProblems(route: Route, probes: SeatProbe[]): DoctorProblem[] {
  return probes.filter((p) => p.state === 'missing').map((p) => ({
    severity: 'blocker' as const, kind: 'seat_missing', route: route.route,
    message: `route ${route.route}: the ${p.role} seat's Crew row (${p.seatId}) no longer exists, so that role is skipped`,
    remedy: SEAT_MISSING_REMEDY,
  }));
}

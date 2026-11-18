/**
 * Display tags for runs shown by `status` (CREW-3648).
 *
 * A run names its ticket by `issue_id` (`ISSUE-157`), and the same number can
 * exist on two routes' boards with different prefixes (Tablation `TABL-157`,
 * Paul's Database `FINC-157`). The tag therefore has to be resolved on the
 * tracker of the route the run belongs to (the sidecar's `route` slug), never
 * on the route `status` happened to be asked about. A run whose route has no
 * reachable tracker keeps its raw key rather than borrowing another route's tag.
 */
import { displayKey, type Ticket } from './tracker.ts';

/** The two lookups a route's tracker offers that tagging needs. */
export interface TagSource {
  ticketsByIds(ids: string[]): Promise<Ticket[]>;
  ticketsByKeys(keys: string[]): Promise<Ticket[]>;
}

export interface TaggedRef {
  route?: string;
  ticket?: string | null;
  ticketRecordId?: string | null;
}

const slot = (route: string, key: string): string => `${route}\u0000${key}`;

/**
 * Looks every ref's ticket up once per route and returns `tagOf(route, key)`.
 * `sourceFor` returns the route's tracker, or undefined when it cannot be
 * built; a lookup that throws leaves that route's keys untagged.
 */
export async function resolveRunTags(
  refs: TaggedRef[],
  sourceFor: (routeSlug: string) => TagSource | undefined,
): Promise<(route: string | undefined, key: string | null | undefined) => string | null> {
  const byRoute = new Map<string, { ids: Set<string>; keys: Set<string> }>();
  for (const r of refs) {
    if (!r.route) continue;
    const want = byRoute.get(r.route) ?? { ids: new Set<string>(), keys: new Set<string>() };
    if (r.ticketRecordId) want.ids.add(r.ticketRecordId);
    if (r.ticket) want.keys.add(r.ticket);
    byRoute.set(r.route, want);
  }
  const tags = new Map<string, string>();
  await Promise.all([...byRoute].map(async ([route, want]) => {
    const source = sourceFor(route);
    if (!source) return;
    const found = [
      ...(want.ids.size ? await source.ticketsByIds([...want.ids]).catch(() => []) : []),
      ...(want.keys.size ? await source.ticketsByKeys([...want.keys]).catch(() => []) : []),
    ];
    for (const t of found) tags.set(slot(route, t.issue_id), displayKey(t));
  }));
  return (route, key) => (key ? (route ? tags.get(slot(route, key)) : undefined) ?? key : null);
}

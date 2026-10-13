/**
 * Per-seat agent API keys (CREW-1603).
 *
 * Every tracker write a lane makes used to authenticate as the ship's human
 * key, so the event log and the table rule context (`actor.kind`) could not
 * tell a seat from a person. The platform mints workspace-scoped keys that
 * authenticate as an Agents-table row's own principal
 * (`POST /workspaces/:ws/agents/:agentId/api-keys`); this module mints one per
 * seat persona, keeps it in the OS keychain beside the ship key, and resolves
 * it per role.
 *
 * Minting happens only in `crew connect` / `crew agents sync`
 * (`mintMissingSeatKeys`), never inside a polling cycle: the raw key is shown
 * once, so a box with no keychain would mint a fresh one on every pass. The
 * daemon only reads (`resolveSeatKey`), and a seat with no stored key falls
 * back to the ship key with a warning, never a failed cycle.
 */

import { getSessionStore, hostFromUrl, type SessionStore } from '@tablation/client';
import { ROLE_NAMES, resolveApiKey, splitRoute, type RoleName, type Route } from './config.ts';

/** `pair` stays on the ship key: a Pair session is a person's, and must keep writing as `user`. */
export const SEAT_KEY_ROLES: readonly RoleName[] = ROLE_NAMES.filter((r) => r !== 'pair');

export type SeatIdentity =
  /** The seat writes as its own agent principal. */
  | { kind: 'agent'; apiKey: string; agentId: string }
  /** No seat key: the seat writes with the ship key, and `reason` says why. */
  | { kind: 'ship'; apiKey: string; reason: string };

/** Keychain slug for one agent's key: unique per workspace + agent, distinct from the ship key's plain workspace slug. */
export function seatKeySlug(workspaceSlug: string, agentId: string): string {
  return `${workspaceSlug}#agent:${agentId}`;
}

function slugFor(route: Route, agentId: string): string {
  const [workspaceSlug] = splitRoute(route.route);
  return seatKeySlug(workspaceSlug, agentId);
}

/** The Agents row backing `role`'s seat, as `crew agents sync` last linked it. */
export function seatAgentId(route: Route, role: RoleName): string | undefined {
  return route.resolved?.agentPersonas?.[role]?.agentId;
}

/**
 * The key `role` should write with. The keychain read is async; this never
 * throws, and an unavailable keychain or a missing key is a `ship` identity
 * carrying the reason.
 */
export async function resolveSeatKey(
  route: Route,
  role: RoleName,
  getStore: () => SessionStore = getSessionStore,
): Promise<SeatIdentity> {
  const ship = (reason: string): SeatIdentity => ({ kind: 'ship', apiKey: resolveApiKey(route), reason });
  if (!SEAT_KEY_ROLES.includes(role)) return ship(`${role} always writes as the ship`);
  const agentId = seatAgentId(route, role);
  if (!agentId) return ship('seat has no linked Agents row (run `crew agents sync`)');
  try {
    const session = await getStore().get(hostFromUrl(route.baseUrl), slugFor(route, agentId));
    if (session?.apiKey) return { kind: 'agent', apiKey: session.apiKey, agentId };
    return ship('no agent key stored for this seat (run `crew agents sync`)');
  } catch {
    return ship('OS keychain unavailable');
  }
}

export interface MintOutcome {
  role: RoleName;
  action: 'minted' | 'already_stored' | 'no_agent' | 'failed';
  detail?: string;
}

/**
 * Mints a key for every seat persona that is linked to an Agents row and does
 * not already have one stored. Uses the ship key once per mint. `dryRun`
 * reports what would be minted without touching the server or keychain.
 */
export async function mintMissingSeatKeys(
  route: Route,
  o: { userAgent?: string; dryRun?: boolean; shipName?: string; getStore?: () => SessionStore; fetchImpl?: typeof fetch },
): Promise<MintOutcome[]> {
  const out: MintOutcome[] = [];
  if (!route.resolved) return out;
  const resolved = route.resolved;
  const doFetch = o.fetchImpl ?? fetch;
  const seated = SEAT_KEY_ROLES.filter((r) => resolved.seats[r]);
  let store: SessionStore;
  try {
    store = (o.getStore ?? getSessionStore)();
  } catch (e) {
    return seated.map((role) => ({
      role, action: 'failed' as const, detail: `OS keychain unavailable: ${(e as Error).message}`,
    }));
  }
  const host = hostFromUrl(route.baseUrl);
  const base = route.baseUrl.replace(/\/+$/, '');
  for (const role of seated) {
    const agentId = seatAgentId(route, role);
    if (!agentId) { out.push({ role, action: 'no_agent' }); continue; }
    const slug = slugFor(route, agentId);
    try {
      if ((await store.get(host, slug))?.apiKey) { out.push({ role, action: 'already_stored' }); continue; }
      if (o.dryRun) { out.push({ role, action: 'minted', detail: 'dry run' }); continue; }
      const res = await doFetch(`${base}/api/workspaces/${resolved.workspaceId}/agents/${agentId}/api-keys`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resolveApiKey(route)}`,
          'Content-Type': 'application/json',
          'User-Agent': o.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0',
        },
        body: JSON.stringify({ name: `crew ${o.shipName ?? 'ship'} ${role}` }),
      });
      if (!res.ok) { out.push({ role, action: 'failed', detail: `${res.status} ${res.statusText}` }); continue; }
      const body = (await res.json()) as { key?: string };
      if (!body.key) { out.push({ role, action: 'failed', detail: 'response carried no key' }); continue; }
      // StoredSession is the ship-login shape; only `apiKey` is read back.
      await store.set(host, slug, {
        apiKey: body.key,
        shipId: o.shipName ?? '',
        workspaceId: resolved.workspaceId,
        identityId: agentId,
        createdAt: new Date().toISOString(),
      });
      out.push({ role, action: 'minted' });
    } catch (e) {
      out.push({ role, action: 'failed', detail: (e as Error).message });
    }
  }
  return out;
}

export function describeMintOutcome(o: MintOutcome): string {
  switch (o.action) {
    case 'minted': return `${o.role}: agent key minted${o.detail ? ` (${o.detail})` : ''}`;
    case 'already_stored': return `${o.role}: agent key already stored`;
    case 'no_agent': return `${o.role}: no linked Agents row — writes as the ship until \`crew agents sync\` links one`;
    case 'failed': return `${o.role}: could not mint an agent key (${o.detail ?? 'unknown'}) — writes as the ship`;
  }
}

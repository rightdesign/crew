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

import { getSessionStore, hostFromUrl, type SessionStore, type StoredSession } from '@tablation/client';
import { ROLE_NAMES, resolveApiKey, splitRoute, type RoleName, type Route } from './config.ts';

/** `pair` stays on the ship key: a Pair session is a person's, and must keep writing as `user`. */
export const SEAT_KEY_ROLES: readonly RoleName[] = ROLE_NAMES.filter((r) => r !== 'pair');

/**
 * CREW-1797: the persona/skill rows and seat keys belong to a workspace admin,
 * so a non-admin key's doctor hints must not tell it to run what only an admin
 * can finish. An unrecorded role is treated as admin (the old wording).
 */
function keyIsAdmin(route: Route): boolean {
  const role = route.resolved?.role;
  return role === undefined || role === 'WORKSPACE_ADMIN' || role === 'PLATFORM_ADMIN';
}

const MEMBER_NO_ROW = "has no linked Agents row — a workspace admin's `crew agents sync` creates the persona rows; run it here afterwards to link this ship's seats";
// CREW-1802: the server decides who may mint (an admin, or a project role with
// the "Mint agent keys" capability, TABL-1801), so a non-admin is pointed at sync.
const MEMBER_NO_KEY = 'no agent key for this seat — run `crew agents sync` (needs the "Mint agent keys" capability on your role)';
const FORBIDDEN_LINE = 'seat keys: not minted — your role does not grant "Mint agent keys"; ask a workspace admin to add it to your project role (or run sync with an admin key)';

/** What the keychain holds for a seat: the ship-login session shape plus the server id of the key, so this ship can revoke it. */
type SeatSession = StoredSession & { keyId?: string };

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
 * The key the release phase writes with (CREW-1605): the ship's own "Release"
 * Crew row is not a `RoleName` seat, so its Agents row is tracked on its own
 * (`resolved.releaseAgentId`, written by `crew agents sync`) and the same
 * ship-key fallback applies.
 */
export async function resolveReleaseKey(
  route: Route,
  getStore: () => SessionStore = getSessionStore,
): Promise<SeatIdentity> {
  const ship = (reason: string): SeatIdentity => ({ kind: 'ship', apiKey: resolveApiKey(route), reason });
  const agentId = route.resolved?.releaseAgentId;
  if (!agentId) return ship(keyIsAdmin(route) ? 'release seat has no linked Agents row (run `crew agents sync`)' : `release seat ${MEMBER_NO_ROW}`);
  try {
    const session = await getStore().get(hostFromUrl(route.baseUrl), slugFor(route, agentId));
    if (session?.apiKey) return { kind: 'agent', apiKey: session.apiKey, agentId };
    return ship(keyIsAdmin(route) ? 'no agent key stored for the release seat (run `crew agents sync`)' : MEMBER_NO_KEY);
  } catch {
    return ship('OS keychain unavailable');
  }
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
  if (!agentId) return ship(keyIsAdmin(route) ? 'seat has no linked Agents row (run `crew agents sync`)' : `seat ${MEMBER_NO_ROW}`);
  try {
    const session = await getStore().get(hostFromUrl(route.baseUrl), slugFor(route, agentId));
    if (session?.apiKey) return { kind: 'agent', apiKey: session.apiKey, agentId };
    return ship(keyIsAdmin(route) ? 'no agent key stored for this seat (run `crew agents sync`)' : MEMBER_NO_KEY);
  } catch {
    return ship('OS keychain unavailable');
  }
}

/**
 * CREW-1800: a keychain error must never reach the terminal as-is. The macOS
 * store shells out to `security add-generic-password ... -w <session json>`,
 * and Node's `execFile` error message is `Command failed: <full argv>`, so the
 * freshly minted key is inside it. Only a fixed reason is ever returned.
 */
export function describeStoreError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/User interaction is not allowed/i.test(msg)) {
    return 'keychain unavailable (User interaction is not allowed — run from a logged-in session, or `security unlock-keychain` first)';
  }
  return 'keychain unavailable (could not write to the OS keychain)';
}

export interface MintOutcome {
  role: RoleName | 'release';
  action: 'minted' | 'already_stored' | 'no_agent' | 'failed' | 'forbidden';
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
  // The release seat is not a RoleName, so it is minted for alongside the roles.
  const targets: Array<{ role: RoleName | 'release'; agentId: string | undefined }> = [
    ...SEAT_KEY_ROLES.filter((r) => resolved.seats[r]).map((role) => ({ role, agentId: seatAgentId(route, role) })),
    ...(resolved.releaseSeat ? [{ role: 'release' as const, agentId: resolved.releaseAgentId }] : []),
  ];
  let store: SessionStore;
  try {
    store = (o.getStore ?? getSessionStore)();
  } catch (e) {
    return targets.map(({ role }) => ({
      role, action: 'failed' as const, detail: describeStoreError(e),
    }));
  }
  const host = hostFromUrl(route.baseUrl);
  const base = route.baseUrl.replace(/\/+$/, '');
  // Probe the keychain once, before any mint: a key that cannot be stored is a
  // live credential nobody holds, and a locked keychain would strand one per seat.
  if (!o.dryRun) {
    const probeSlug = seatKeySlug(splitRoute(route.route)[0], '_probe');
    try {
      await store.set(host, probeSlug, {
        apiKey: 'probe', shipId: '', workspaceId: resolved.workspaceId, identityId: '_probe', createdAt: new Date().toISOString(),
      });
      await store.clear(host, probeSlug);
    } catch (e) {
      const detail = `${describeStoreError(e)}; no keys minted`;
      return targets.map(({ role, agentId }) => (agentId ? { role, action: 'failed' as const, detail } : { role, action: 'no_agent' as const }));
    }
  }
  for (const { role, agentId } of targets) {
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
      if (res.status === 403) {
        // The capability is the caller's, not the seat's: every remaining mint
        // would be refused the same way, so stop and report once per run.
        out.push({ role, action: 'forbidden' });
        break;
      }
      if (!res.ok) { out.push({ role, action: 'failed', detail: `${res.status} ${res.statusText}` }); continue; }
      const body = (await res.json()) as { key?: string; id?: string };
      if (!body.key) { out.push({ role, action: 'failed', detail: 'response carried no key' }); continue; }
      try {
        // StoredSession is the ship-login shape; only `apiKey` is read back.
        const session: SeatSession = {
          apiKey: body.key,
          shipId: o.shipName ?? '',
          workspaceId: resolved.workspaceId,
          identityId: agentId,
          createdAt: new Date().toISOString(),
          ...(body.id ? { keyId: body.id } : {}),
        };
        await store.set(host, slug, session);
      } catch (e) {
        // Minted but unstorable: revoke it so no live key exists that nobody holds.
        let revoked = false;
        if (body.id) {
          try {
            const del = await doFetch(`${base}/api/workspaces/${resolved.workspaceId}/agents/${agentId}/api-keys/${body.id}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${resolveApiKey(route)}`, 'User-Agent': o.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0' },
            });
            revoked = del.ok;
          } catch { revoked = false; }
        }
        out.push({
          role, action: 'failed',
          detail: revoked
            ? `minted but could not be stored (${describeStoreError(e)}); revoked`
            : `a key for ${role} is live on the server and not stored (${describeStoreError(e)}) — revoke it from that seat's Agents row`,
        });
        continue;
      }
      out.push({ role, action: 'minted' });
    } catch (e) {
      // Redacted: a network/keychain error message can carry argv or key material.
      out.push({ role, action: 'failed', detail: /Command failed|security|sk_|-w /i.test((e as Error).message) ? describeStoreError(e) : (e as Error).message });
    }
  }
  return out;
}

export function describeMintOutcome(o: MintOutcome): string {
  switch (o.action) {
    case 'minted': return `${o.role}: agent key minted${o.detail ? ` (${o.detail})` : ''}`;
    case 'already_stored': return `${o.role}: agent key already stored`;
    case 'no_agent': return `${o.role}: no linked Agents row — writes as the ship until \`crew agents sync\` links one`;
    case 'forbidden': return FORBIDDEN_LINE;
    case 'failed': return `${o.role}: could not mint an agent key (${o.detail ?? 'unknown'}) — writes as the ship`;
  }
}

export interface RevokeOutcome {
  role: RoleName | 'release';
  action: 'revoked' | 'not_stored' | 'no_agent' | 'failed';
  detail?: string;
}

/**
 * CREW-1802: deletes the agent keys this ship holds, server-side first and then
 * from the keychain, so an engineer can rotate their own ship's keys. A stored
 * key from before the mint response's id was recorded cannot be revoked from
 * here; it is left in place (clearing it would orphan a live key) and reported.
 */
export async function revokeSeatKeys(
  route: Route,
  o: { userAgent?: string; dryRun?: boolean; getStore?: () => SessionStore; fetchImpl?: typeof fetch },
): Promise<RevokeOutcome[]> {
  const out: RevokeOutcome[] = [];
  if (!route.resolved) return out;
  const resolved = route.resolved;
  const doFetch = o.fetchImpl ?? fetch;
  const targets: Array<{ role: RoleName | 'release'; agentId: string | undefined }> = [
    ...SEAT_KEY_ROLES.filter((r) => resolved.seats[r]).map((role) => ({ role, agentId: seatAgentId(route, role) })),
    ...(resolved.releaseSeat ? [{ role: 'release' as const, agentId: resolved.releaseAgentId }] : []),
  ];
  let store: SessionStore;
  try {
    store = (o.getStore ?? getSessionStore)();
  } catch (e) {
    return targets.map(({ role }) => ({ role, action: 'failed' as const, detail: describeStoreError(e) }));
  }
  const host = hostFromUrl(route.baseUrl);
  const base = route.baseUrl.replace(/\/+$/, '');
  for (const { role, agentId } of targets) {
    if (!agentId) { out.push({ role, action: 'no_agent' }); continue; }
    const slug = slugFor(route, agentId);
    try {
      const session = (await store.get(host, slug)) as SeatSession | undefined;
      if (!session?.apiKey) { out.push({ role, action: 'not_stored' }); continue; }
      if (!session.keyId) {
        out.push({ role, action: 'failed', detail: "no key id was recorded when this key was minted — revoke it from the seat's Agents row" });
        continue;
      }
      if (o.dryRun) { out.push({ role, action: 'revoked', detail: 'dry run' }); continue; }
      const del = await doFetch(`${base}/api/workspaces/${resolved.workspaceId}/agents/${agentId}/api-keys/${session.keyId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${resolveApiKey(route)}`, 'User-Agent': o.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0' },
      });
      // 404 means the server has no such key (already revoked), so the stored copy is dead weight.
      if (!del.ok && del.status !== 404) { out.push({ role, action: 'failed', detail: `${del.status} ${del.statusText}` }); continue; }
      await store.clear(host, slug);
      out.push({ role, action: 'revoked', detail: del.ok ? undefined : 'server already had no such key' });
    } catch (e) {
      out.push({ role, action: 'failed', detail: /Command failed|security|sk_|-w /i.test((e as Error).message) ? describeStoreError(e) : (e as Error).message });
    }
  }
  return out;
}

export function describeRevokeOutcome(o: RevokeOutcome): string {
  switch (o.action) {
    case 'revoked': return `${o.role}: agent key revoked and cleared from the keychain${o.detail ? ` (${o.detail})` : ''}`;
    case 'not_stored': return `${o.role}: no agent key stored on this ship`;
    case 'no_agent': return `${o.role}: no linked Agents row`;
    case 'failed': return `${o.role}: could not revoke the agent key (${o.detail ?? 'unknown'}) — left in the keychain`;
  }
}

/**
 * Whether the ship key may mint agent keys: `GET .../api-keys` on a linked seat's
 * agent answers 200 to an admin or a capability holder and 403 to anyone else
 * (there is no dry-run mint). `undefined` when no seat is linked or the answer
 * is neither.
 */
export async function canMintAgentKeys(
  route: Route,
  o: { userAgent?: string; fetchImpl?: typeof fetch } = {},
): Promise<boolean | undefined> {
  const resolved = route.resolved;
  if (!resolved) return undefined;
  const agentId = seatAgentId(route, 'dev') ?? SEAT_KEY_ROLES.map((r) => seatAgentId(route, r)).find(Boolean);
  if (!agentId) return undefined;
  try {
    const res = await (o.fetchImpl ?? fetch)(`${route.baseUrl.replace(/\/+$/, '')}/api/workspaces/${resolved.workspaceId}/agents/${agentId}/api-keys`, {
      headers: { Authorization: `Bearer ${resolveApiKey(route)}`, 'User-Agent': o.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0' },
    });
    if (res.ok) return true;
    return res.status === 403 ? false : undefined;
  } catch { return undefined; }
}

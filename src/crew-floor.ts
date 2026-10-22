/**
 * The workspace's minimum crew version (EPIC-053 Map §4). The platform's
 * project read carries `crewMinVersion`, and its crew-write guard answers 426
 * to a `CrewAgent/<version>` below it. crew reads the floor itself so a
 * too-old crew stops cleanly — no ticket picked, heartbeat still running, one
 * `crew_outdated` ship attention item naming both versions — instead of
 * failing every write mid-cycle.
 */

import { TablationApiError } from '@tablation/client';
import type { Route, Ship } from './config.ts';
import {
  clearShipAttention, raiseShipAttention, type RaiseOptions, type ShipAttentionItem,
} from './ship-attention.ts';
import { resolveApiKey } from './config.ts';

export const CREW_OUTDATED_KEY = 'crew_outdated';

/** `x.y.z` (a leading `v` and any `-pre`/`+build` suffix ignored) as numbers, or null when it is not one. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when `a` < `b`, 0 when equal, positive when `a` > `b`; null when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  return 0;
}

/** True only when both parse and `have` is below `floor`; an unreadable floor never stops a ship. */
export function belowFloor(have: string, floor: string | null | undefined): boolean {
  if (!floor) return false;
  const c = compareVersions(have, floor);
  return c !== null && c < 0;
}

export function outdatedItem(have: string, floor: string, nowIso = new Date().toISOString()): ShipAttentionItem {
  return {
    kind: 'crew_outdated', key: CREW_OUTDATED_KEY, since: nowIso,
    message: `crew ${have} is below this workspace's minimum ${floor} — no ticket will be picked until it is updated ` +
      '(the Crew app updates it, or `npm install -g @tablation/crew`). Resumes automatically once the version satisfies the floor',
  };
}

/**
 * The version the server sees: the `CrewAgent/<version>` marker in the ship's
 * User-Agent. Null when it carries none (a custom agent string), in which case
 * the server enforces nothing and neither do we.
 */
export function sentVersion(ship: Pick<Ship, 'userAgent'>): string | null {
  return /CrewAgent\/(\d+\.\d+\.\d+\S*)/.exec(ship.userAgent)?.[1] ?? null;
}

/** Reads the project's `crewMinVersion`: null for none, undefined when it could not be read. */
export async function readCrewFloor(route: Route, ship: Pick<Ship, 'userAgent'>): Promise<string | null | undefined> {
  const r = route.resolved;
  if (!r?.projectId) return undefined;
  try {
    const res = await fetch(`${route.baseUrl}/api/projects/${encodeURIComponent(r.projectId)}?workspaceId=${r.workspaceId}`, {
      headers: { Authorization: `Bearer ${resolveApiKey(route)}`, 'User-Agent': ship.userAgent },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { crewMinVersion?: string | null };
    return body.crewMinVersion ?? null;
  } catch {
    return undefined;
  }
}

/**
 * Raises or clears `crew_outdated` from the project's floor. A floor that
 * cannot be read leaves the item as it was. Returns the floor message while
 * the ship is stopped, else null.
 */
export async function checkCrewFloor(
  o: RaiseOptions & { route: Route; ship: Ship },
  deps: { version?: string; read?: typeof readCrewFloor } = {},
): Promise<string | null> {
  const have = deps.version ?? sentVersion(o.ship);
  if (!have) return null;
  const floor = await (deps.read ?? readCrewFloor)(o.route, o.ship);
  if (floor === undefined) return openOutdated(o.state);
  if (belowFloor(have, floor)) {
    const item = outdatedItem(have, floor!);
    await raiseShipAttention(o, item);
    return item.message;
  }
  clearShipAttention(o.state, CREW_OUTDATED_KEY);
  return null;
}

function openOutdated(state: RaiseOptions['state']): string | null {
  return state.shipAttention().previous().find((i) => i.key === CREW_OUTDATED_KEY)?.message ?? null;
}

/** A 426 from a write: the floor was raised while this process ran. */
export function isUpgradeRequired(err: unknown): err is TablationApiError {
  return err instanceof TablationApiError && err.status === 426;
}

/**
 * Raises `crew_outdated` from a 426 reply, once (an already-open item is not
 * re-announced). The reply's message names the required version; ours comes
 * from the install.
 */
export async function raiseFromUpgradeRequired(
  o: RaiseOptions & { ship: Ship }, err: TablationApiError,
): Promise<void> {
  const have = sentVersion(o.ship) ?? 'unknown';
  const floor = /(\d+\.\d+\.\d+)/.exec(err.message.replace(have, ''))?.[1] ?? 'a newer version';
  await raiseShipAttention(o, outdatedItem(have, floor));
}

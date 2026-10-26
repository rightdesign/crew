/**
 * Can each seat's agent key actually READ the Issues table? (CREW-2549)
 *
 * Seat keys are minted as a workspace membership plus the project's
 * `defaultAgentRoleId`. A project with no such role mints keys that
 * authenticate fine but carry no project role, so the Issues table answers
 * 403 "No READ access to this model". Nothing earlier noticed: the poll phase
 * runs on the ship key (a workspace admin), and doctor only checked that a key
 * was stored. This module is the read probe doctor, connect and agents sync
 * share, plus the shape of the 403 the release phase raises as one attention
 * item instead of one log line per repository per cycle.
 */

import type { SessionStore } from '@tablation/client';
import type { RoleName, Route } from './config.ts';
import { SEAT_KEY_ROLES, resolveReleaseKey, resolveSeatKey } from './seat-keys.ts';
import type { ShipAttentionItem } from './ship-attention.ts';

/** What an operator does about a seat that cannot read Issues. */
export const SEAT_NO_READ_REMEDY =
  'the project has no default role for agent keys — update the Issues app\'s template, then re-mint with ' +
  '`crew agents sync --revoke-seat-keys`, or assign the Crew seat role to the agent members';

export type SeatProbeState = 'ok' | 'forbidden' | 'unknown';

export interface SeatProbeResult {
  role: RoleName | 'release';
  state: SeatProbeState;
  /** `unknown` only: why the probe could not decide (network, 5xx). */
  detail?: string;
}

/** `GET …/records?limit=1` on Issues with `apiKey`: 403 is a refusal, any other failure is undecided. */
export async function probeIssuesRead(
  route: Route,
  apiKey: string,
  o: { userAgent?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ state: SeatProbeState; detail?: string }> {
  const resolved = route.resolved;
  if (!resolved?.models?.issues) return { state: 'unknown', detail: 'route has no resolved Issues table' };
  const url = `${route.baseUrl.replace(/\/+$/, '')}/api/workspaces/${resolved.workspaceId}/data-models/${resolved.models.issues}/records?limit=1`;
  try {
    const res = await (o.fetchImpl ?? fetch)(url, {
      headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': o.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0' },
    });
    if (res.ok) return { state: 'ok' };
    if (res.status === 403) return { state: 'forbidden' };
    return { state: 'unknown', detail: `HTTP ${res.status}` };
  } catch (e) {
    return { state: 'unknown', detail: (e as Error).message };
  }
}

/**
 * Probes every seat (and the release seat) that writes as its own agent. A seat
 * on the ship key is skipped: the ship key is a workspace admin's, and the
 * fallback is already reported as "writes as the ship".
 */
export async function probeSeatReads(
  route: Route,
  o: { userAgent?: string; fetchImpl?: typeof fetch; getStore?: () => SessionStore } = {},
): Promise<SeatProbeResult[]> {
  const out: SeatProbeResult[] = [];
  const roles: Array<RoleName | 'release'> = [...SEAT_KEY_ROLES.filter((r) => route.resolved?.seats[r]), ...(route.resolved?.releaseSeat ? ['release' as const] : [])];
  for (const role of roles) {
    const id = role === 'release' ? await resolveReleaseKey(route, o.getStore) : await resolveSeatKey(route, role, o.getStore);
    if (id.kind !== 'agent') continue;
    out.push({ role, ...(await probeIssuesRead(route, id.apiKey, o)) });
  }
  return out;
}

/** The ERROR line doctor, connect and sync print for a seat that cannot read Issues. */
export function describeSeatForbidden(role: string): string {
  return `seat read:        ERROR ${role} agent key cannot read Issues (403) — ${SEAT_NO_READ_REMEDY}`;
}

/** True when `e` is the tracker client's 403 (the release phase's per-repository failure). */
export function isForbiddenError(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  if (status === 403) return true;
  return /\b403\b/.test(e instanceof Error ? e.message : String(e));
}

export const SEAT_FORBIDDEN_KEY = 'seat_forbidden:release';

/** The one ship-attention item the release phase raises instead of a 403 per repository per cycle. */
export function seatForbiddenItem(now = new Date()): ShipAttentionItem {
  return {
    kind: 'seat_forbidden',
    key: SEAT_FORBIDDEN_KEY,
    message: `release seat cannot read the Issues table (403) — ${SEAT_NO_READ_REMEDY}`,
    since: now.toISOString(),
  };
}

/** The concise per-repository line that replaces the raw 403 URL. */
export function seatForbiddenRepoLine(scope: string): string {
  return `${scope}: skipped — release seat cannot read Issues (see attention)`;
}

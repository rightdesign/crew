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

export interface SeatTableProbe { table: string; state: SeatProbeState; detail?: string }

export interface SeatProbeResult {
  role: RoleName | 'release';
  /** Worst state across `tables`: forbidden beats unknown beats ok. */
  state: SeatProbeState;
  /** `unknown` only: why the probe could not decide (network, 5xx). */
  detail?: string;
  /** Every table probed with this seat's own key. */
  tables: SeatTableProbe[];
}

/** One table a seat touches by its own key, and the name the operator knows it by. */
export interface ProbeTable { name: string; modelId: string }

/** The tables a route resolves for the probe: Issues, Comments, Crew and, when the workspace has one, Ships. */
export function probeTables(route: Route): ProbeTable[] {
  const m = route.resolved?.models;
  if (!m) return [];
  const r = route.resolved;
  return [
    { name: 'Issues', modelId: m.issues },
    { name: 'Comments', modelId: m.comments },
    { name: 'Crew', modelId: m.crew },
    { name: 'Ships', modelId: r?.shipsModelId ?? '' },
  ].filter((t) => !!t.modelId);
}

/** `GET /api/data-models/<id>/records?limit=1` with `apiKey`: 403 is a refusal, any other failure is undecided. */
export async function probeTableRead(
  route: Route,
  modelId: string,
  apiKey: string,
  o: { userAgent?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ state: SeatProbeState; detail?: string }> {
  // The records route is unprefixed by workspace; the workspace-prefixed form 404s for every key (CREW-2602).
  const url = `${route.baseUrl.replace(/\/+$/, '')}/api/data-models/${modelId}/records?limit=1`;
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

/** Issues read, kept as the entry point the callers and tests already use. */
export async function probeIssuesRead(
  route: Route,
  apiKey: string,
  o: { userAgent?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ state: SeatProbeState; detail?: string }> {
  const issues = route.resolved?.models?.issues;
  if (!issues) return { state: 'unknown', detail: 'route has no resolved Issues table' };
  return probeTableRead(route, issues, apiKey, o);
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
    const tables: SeatTableProbe[] = [];
    for (const t of probeTables(route)) tables.push({ table: t.name, ...(await probeTableRead(route, t.modelId, id.apiKey, o)) });
    const bad = tables.find((t) => t.state === 'forbidden') ?? tables.find((t) => t.state === 'unknown');
    out.push({ role, state: bad?.state ?? (tables.length ? 'ok' : 'unknown'), detail: bad?.detail ?? (tables.length ? undefined : 'route has no resolved tables'), tables });
  }
  return out;
}

/** What a 403 refused: the request, the table (name when the route resolves it) and the verb. */
export interface ForbiddenDetail {
  method?: string;
  path?: string;
  table?: string;
  verb?: 'READ' | 'WRITE';
}

/** Parses the tracker client's `METHOD /path -> 403: No WRITE access to this model` message. */
export function forbiddenDetail(e: unknown, route?: Route): ForbiddenDetail {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /^([A-Z]+) (\S+) -> 403/.exec(msg);
  const verb = /No (READ|WRITE) access/i.exec(msg)?.[1]?.toUpperCase() as 'READ' | 'WRITE' | undefined;
  const modelId = /\/data-models\/([\w-]+)/i.exec(m?.[2] ?? '')?.[1];
  const r = route?.resolved;
  const known: Array<[string | undefined, string]> = [
    [r?.models?.issues, 'Issues'], [r?.models?.comments, 'Comments'], [r?.models?.crew, 'Crew'],
    [r?.shipsModelId, 'Ships'], [r?.locksModelId, 'Locks'], [r?.epicsModelId, 'Epics'], [r?.periscopesModelId, 'Periscopes'], [r?.reposModelId, 'Repos'],
  ];
  const table = modelId ? known.find(([id]) => id && id === modelId)?.[1] ?? `table ${modelId}` : undefined;
  return { method: m?.[1], path: m?.[2], table, verb };
}

/** The remedy for a refusal: a grant on a named table, or the project-role fix when Issues read has no role at all. */
export function remedyFor(d: ForbiddenDetail, roleName = 'the agent role'): string {
  if (d.table && d.verb && !(d.table === 'Issues' && d.verb === 'READ')) {
    return `grant ${d.verb} on ${d.table} to ${roleName}`;
  }
  return SEAT_NO_READ_REMEDY;
}

/** The ERROR line doctor, connect and sync print for a seat that cannot read a table. */
export function describeSeatForbidden(role: string, tables: SeatTableProbe[] = []): string {
  const bad = tables.filter((t) => t.state === 'forbidden').map((t) => t.table);
  const what = bad.length ? bad.join(', ') : 'Issues';
  const remedy = bad.length && !(bad.length === 1 && bad[0] === 'Issues') ? bad.map((t) => remedyFor({ table: t, verb: 'READ' })).join('; ') : SEAT_NO_READ_REMEDY;
  return `seat read:        ERROR ${role} agent key cannot read ${what} (403) — ${remedy}`;
}

/** Per-table ok / 403 / error summary for doctor. */
export function describeSeatTables(role: string, tables: SeatTableProbe[]): string {
  const cells = tables.map((t) => `${t.table} ${t.state === 'ok' ? 'ok' : t.state === 'forbidden' ? '403' : `error (${t.detail ?? '?'})`}`);
  return `seat read:        ${role}: ${cells.join(', ')}`;
}

/** True when `e` is the tracker client's 403 (the release phase's per-repository failure). */
export function isForbiddenError(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  if (status === 403) return true;
  return /\b403\b/.test(e instanceof Error ? e.message : String(e));
}

export const SEAT_FORBIDDEN_KEY = 'seat_forbidden:release';

/** The one ship-attention item the release phase raises instead of a 403 per repository per cycle. */
export function seatForbiddenItem(now = new Date(), e?: unknown, route?: Route): ShipAttentionItem {
  const d = e === undefined ? {} : forbiddenDetail(e, route);
  const what = d.method && d.table ? `${d.method} ${d.table}${d.verb ? ` -> 403 No ${d.verb} access` : ' -> 403'}` : 'cannot read the Issues table (403)';
  return {
    kind: 'seat_forbidden',
    key: SEAT_FORBIDDEN_KEY,
    message: `release seat: ${what} — ${remedyFor(d)}`,
    since: now.toISOString(),
  };
}

/** The concise per-repository line that replaces the raw 403 URL. */
export function seatForbiddenRepoLine(scope: string): string {
  return `${scope}: skipped — release seat was refused by the tracker (see attention)`;
}

// ---- Write access (CREW-2963) ----------------------------------------------

/**
 * The Issues columns a seat writes at claim and hand-off (plus the counters it
 * stamps). A READ answer on any of them is a hand-off that will be refused
 * with 403 after the work is done, so doctor names them before a run is spent.
 */
export const SEAT_WRITE_ISSUE_FIELDS = [
  'status', 'assignee_id', 'held_by_ship_id', 'work_started_at', 'commit_sha', 'merged_at', 'resolved_at',
  'released_version', 'released_at', 'resolution_note',
  'agent_runs', 'tokens_in', 'tokens_out', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd',
] as const;

export interface SeatWriteProbe {
  table: string;
  state: SeatProbeState;
  /** `forbidden` only: the columns (Issues) the seat can read but not write; empty for a whole-table refusal. */
  fields: string[];
  detail?: string;
}

export interface SeatWriteResult {
  role: RoleName | 'release';
  state: SeatProbeState;
  tables: SeatWriteProbe[];
}

const canWrite = (level: unknown): boolean => level === 'WRITE' || level === 'DELETE';

/** Pure mapping of the `/field-access` body to the claim/hand-off columns it refuses; absent columns are not judged. */
export function refusedIssueFields(body: unknown, columns: readonly string[] = SEAT_WRITE_ISSUE_FIELDS): string[] {
  const fields = (body as { fields?: Record<string, unknown> } | null)?.fields;
  if (!fields || typeof fields !== 'object') return [];
  return columns.filter((c) => c in fields && !canWrite(fields[c]));
}

async function getJson(url: string, apiKey: string, o: { userAgent?: string; fetchImpl?: typeof fetch }): Promise<{ status: number; body?: unknown }> {
  const res = await (o.fetchImpl ?? fetch)(url, {
    headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': o.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0' },
  });
  if (!res.ok) return { status: res.status };
  try { return { status: res.status, body: await res.json() }; } catch { return { status: 0 }; }
}

/** The tables a seat writes besides Issues: Crew status, the Ships heartbeat, and the Locks and Periscopes rows. */
export function writeTables(route: Route): ProbeTable[] {
  const r = route.resolved;
  return [
    { name: 'Crew', modelId: r?.models?.crew ?? '' },
    { name: 'Ships', modelId: r?.shipsModelId ?? '' },
    { name: 'Locks', modelId: r?.locksModelId ?? '' },
    { name: 'Periscopes', modelId: r?.periscopesModelId ?? '' },
  ].filter((t) => !!t.modelId);
}

/** Effective write access of one key: Issues field by field, the other tables as a whole. Uses the access endpoints, never a trial write. */
export async function probeKeyWrites(
  route: Route, apiKey: string, o: { userAgent?: string; fetchImpl?: typeof fetch } = {},
): Promise<SeatWriteProbe[]> {
  const base = route.baseUrl.replace(/\/+$/, '');
  const out: SeatWriteProbe[] = [];
  const issues = route.resolved?.models?.issues;
  const guard = async (table: string, fn: () => Promise<SeatWriteProbe>): Promise<void> => {
    try { out.push(await fn()); } catch (e) { out.push({ table, state: 'unknown', fields: [], detail: (e as Error).message }); }
  };
  if (issues) {
    await guard('Issues', async () => {
      const r = await getJson(`${base}/api/data-models/${issues}/field-access`, apiKey, o);
      if (r.status === 403) return { table: 'Issues', state: 'forbidden', fields: [] };
      if (!r.body) return { table: 'Issues', state: 'unknown', fields: [], detail: `HTTP ${r.status}` };
      const fields = refusedIssueFields(r.body);
      return { table: 'Issues', state: fields.length ? 'forbidden' : 'ok', fields };
    });
  }
  for (const t of writeTables(route)) {
    await guard(t.name, async () => {
      const r = await getJson(`${base}/api/data-models/${t.modelId}/access`, apiKey, o);
      if (r.status === 403) return { table: t.name, state: 'forbidden', fields: [] };
      if (!r.body) return { table: t.name, state: 'unknown', fields: [], detail: `HTTP ${r.status}` };
      return { table: t.name, state: canWrite((r.body as { access?: unknown }).access) ? 'ok' : 'forbidden', fields: [] };
    });
  }
  return out;
}

/** `probeSeatReads`' write-side twin: every seat that writes as its own agent. */
export async function probeSeatWrites(
  route: Route,
  o: { userAgent?: string; fetchImpl?: typeof fetch; getStore?: () => SessionStore; only?: string } = {},
): Promise<SeatWriteResult[]> {
  const out: SeatWriteResult[] = [];
  const all: Array<RoleName | 'release'> = [...SEAT_KEY_ROLES.filter((r) => route.resolved?.seats[r]), ...(route.resolved?.releaseSeat ? ['release' as const] : [])];
  const roles = o.only ? all.filter((r) => r === o.only) : all;
  for (const role of roles) {
    const id = role === 'release' ? await resolveReleaseKey(route, o.getStore) : await resolveSeatKey(route, role, o.getStore);
    if (id.kind !== 'agent') continue;
    const tables = await probeKeyWrites(route, id.apiKey, o);
    const bad = tables.find((t) => t.state === 'forbidden') ?? tables.find((t) => t.state === 'unknown');
    out.push({ role, state: bad?.state ?? 'ok', tables });
  }
  return out;
}

/** What a seat cannot write, as "Issues (status, assignee_id), Ships". */
export function describeWriteRefusals(tables: SeatWriteProbe[]): string {
  return tables.filter((t) => t.state === 'forbidden').map((t) => (t.fields.length ? `${t.table} (${t.fields.join(', ')})` : t.table)).join(', ');
}

/** The remedy doctor and the attention item share. */
export const SEAT_NO_WRITE_REMEDY =
  'raise the grants on that role to WRITE, or point the project\'s default agent role at the Issues app template\'s';

/** Doctor's blocker message for a seat that can read but not write what a hand-off needs. */
export function seatCannotWriteMessage(role: string, tables: SeatWriteProbe[]): string {
  return `${role} agent key cannot write ${describeWriteRefusals(tables)}`;
}

export const seatCannotWriteKey = (role: string): string => `seat_cannot_write:${role}`;

/** The ship-attention item for a seat whose hand-off or status write was refused with 403. */
export function seatCannotWriteItem(role: string, detail: string, nowIso = new Date().toISOString()): ShipAttentionItem {
  return { kind: 'seat_cannot_write', key: seatCannotWriteKey(role), since: nowIso, message: `${role} seat: ${detail} (403) — ${SEAT_NO_WRITE_REMEDY}` };
}

/**
 * Whether a seat held by a `seat_cannot_write` item is still refused. The item
 * stops dispatch, so no run can clear it by succeeding; the daemon asks the
 * access endpoints instead, each cycle. A probe that cannot decide keeps the hold.
 */
export async function seatWriteStillRefused(
  route: Route, role: RoleName, o: { userAgent?: string; fetchImpl?: typeof fetch; getStore?: () => SessionStore } = {},
): Promise<boolean> {
  try {
    const [r] = await probeSeatWrites(route, { ...o, only: role });
    return !!r && r.state !== 'ok';
  } catch {
    return true;
  }
}

/**
 * `crew agents sync` — pushes crew's four built-in personas (Developer,
 * Design, QA, Triage) into a workspace's Agents system table (ISSUE-416).
 *
 * Scope, per docs/WORKSPACE_AGENTS_PLAN.md's 2026-08-27 revision: the three
 * Agents tables now auto-provision on every workspace (ISSUE-465), so this
 * no longer creates the table — it only adds crew's own rows to one that's
 * already there, and keeps them in sync with crew's own local prompt files
 * (`prompts/common.md` + `prompts/lane-<role>.md`, the exact static content
 * `agent.ts`'s `assemblePrompt` concatenates ahead of the per-run
 * roster/environment/digest sections) without ever clobbering a workspace
 * admin's own edit to a persona's Prompt field.
 *
 * Divergence is decided with the same compare-and-swap primitive the
 * tracker's ticket writes already use (`RecordsResource.update`'s
 * `expectedUpdatedAt`, `StaleWriteError` on a mismatch) rather than a
 * separate read-then-compare step of our own — the row's `updated_at` at
 * the time crew last wrote it IS "crew's last-known value" the plan calls
 * for, and the server enforces the compare atomically.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TablationClient, StaleWriteError, TablationApiError } from '@tablation/client';
import type { Route, RoleName } from './config.ts';
import { ROLE_NAMES, resolveApiKey } from './config.ts';

// The SDK's own `FieldType` is deliberately trimmed to what the client
// package has needed so far (id/name/kind/baseType/isSystem) — augmenting
// it here instead of casting lets `ensureCrewAgentField` below read
// `targetModelId`/`isMultiple` off a `dataModels.get()` response's
// `field.fieldType` with no `as unknown as` (see the "no double type cast"
// convention).
declare module '@tablation/client' {
  interface FieldType {
    targetModelId?: string | null;
    isMultiple?: boolean;
  }
}

/** Persona row `Name` values — matches WORKSPACE_AGENTS_PLAN.md and ISSUE-416's own wording. */
export const PERSONA_NAME: Record<RoleName, string> = {
  dev: 'Developer', design: 'Design', qa: 'QA', triage: 'Triage',
};

/** The field `ensureCrewAgentField` provisions on the tracker's own Crew table (Migration section, WORKSPACE_AGENTS_PLAN.md). */
const CREW_AGENT_FIELD_NAME = 'Agent';
const CREW_AGENT_COLUMN = 'agent_id';

export class AgentsSyncError extends Error {}

/**
 * The static, workspace-independent portion of a role's prompt — everything
 * `assemblePrompt()` (agent.ts) concatenates ahead of the per-run
 * roster/environment/digest sections. This is the value crew seeds a new
 * persona row with, and the value it re-pushes on a later sync once its own
 * copy of `common.md`/`lane-<role>.md` has moved on — never anything a
 * workspace admin typed into the row directly.
 */
export function personaDefaultPrompt(crewHome: string, role: RoleName): string {
  const commonPath = join(crewHome, 'prompts', 'common.md');
  const briefPath = join(crewHome, 'prompts', `lane-${role}.md`);
  if (!existsSync(commonPath)) throw new AgentsSyncError(`no shared policy at ${commonPath}`);
  if (!existsSync(briefPath)) throw new AgentsSyncError(`no brief at ${briefPath}`);
  return `${readFileSync(commonPath, 'utf8')}${readFileSync(briefPath, 'utf8')}`;
}

interface AgentRow {
  id: string;
  name: string;
  prompt: string;
  updated_at: string;
}

interface CrewRow {
  id: string;
  [CREW_AGENT_COLUMN]?: string | null;
}

/** Raw shape of `GET /workspaces/:id/field-types` — no SDK resource covers this endpoint yet. */
interface FieldTypeSummary {
  id: string;
  kind: string;
  targetModelId?: string | null;
  isMultiple?: boolean;
}

export type PersonaSyncAction = 'created' | 'updated' | 'unchanged' | 'diverged';

export interface PersonaSyncOutcome {
  role: RoleName;
  action: PersonaSyncAction;
  agentId: string;
}

/** Whether this role's Crew row (`route.resolved.seats[role]`) got pointed at its Agents row this pass. */
export type CrewLinkAction = 'linked' | 'already_linked' | 'no_seat' | 'persona_diverged';

export interface CrewLinkOutcome {
  role: RoleName;
  action: CrewLinkAction;
}

export interface SyncPersonasResult {
  outcomes: PersonaSyncOutcome[];
  /**
   * The new `route.resolved.agentPersonas` — every role synced this pass
   * (created/updated/unchanged all refresh their entry; `diverged` keeps
   * whatever was cached before, since crew did not write the row this
   * time). The caller persists this into the resolved state file; nothing
   * here touches disk itself.
   */
  agentPersonas: Partial<Record<RoleName, { agentId: string; lastSyncedUpdatedAt: string }>>;
  /**
   * Migration section, WORKSPACE_AGENTS_PLAN.md: "Crew records switched to
   * reference Agents instead [of embedding prompt/config data]". Empty on
   * a dry run — provisioning the field and writing the reference are both
   * real writes, so `--dry-run` skips this step entirely rather than
   * reporting a linkage it didn't check.
   */
  crewLinks: CrewLinkOutcome[];
}

/**
 * `route.resolved.workspaceId` and `resolveApiKey(route)` are required —
 * same as every other tracker-talking command, this only works on a route
 * `crew connect` has already resolved.
 */
export async function syncPersonas(
  route: Route,
  opts: { crewHome: string; userAgent?: string; dryRun?: boolean },
): Promise<SyncPersonasResult> {
  if (!route.resolved) {
    throw new AgentsSyncError(`route "${route.route}" has no resolved ids — run \`crew connect\` first`);
  }
  const workspaceId = route.resolved.workspaceId;
  const client = new TablationClient({
    baseUrl: `${route.baseUrl}/api`,
    apiKey: resolveApiKey(route),
    headers: { 'User-Agent': opts.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0' },
  } as ConstructorParameters<typeof TablationClient>[0]);

  let agentsModel: Awaited<ReturnType<typeof client.dataModels.get>>;
  try {
    agentsModel = await client.dataModels.get('agents', workspaceId);
  } catch (e) {
    if (e instanceof TablationApiError && e.status === 404) {
      throw new AgentsSyncError(
        `workspace ${workspaceId} has no Agents table yet — every workspace auto-provisions one (ISSUE-465); ` +
          `an older workspace may still need its one-time backfill`,
      );
    }
    throw e;
  }

  const rows = await client.records.list<AgentRow>(agentsModel.id, { limit: 200 });
  const cache = route.resolved.agentPersonas ?? {};
  const outcomes: PersonaSyncOutcome[] = [];
  const agentPersonas: SyncPersonasResult['agentPersonas'] = { ...cache };

  for (const role of ROLE_NAMES) {
    const name = PERSONA_NAME[role];
    const defaultPrompt = personaDefaultPrompt(opts.crewHome, role);
    const row = rows.find((r) => r.name === name);

    if (!row) {
      if (opts.dryRun) { outcomes.push({ role, action: 'created', agentId: '(dry run)' }); continue; }
      const created = await client.records.create<AgentRow>(agentsModel.id, { name, prompt: defaultPrompt });
      agentPersonas[role] = { agentId: created.id, lastSyncedUpdatedAt: created.updated_at };
      outcomes.push({ role, action: 'created', agentId: created.id });
      continue;
    }

    if (row.prompt === defaultPrompt) {
      // In sync content-wise regardless of who wrote it last — nothing to
      // push, just (re)anchor the cache to the row's current updated_at so
      // a later sync's compare-and-swap has the right baseline.
      agentPersonas[role] = { agentId: row.id, lastSyncedUpdatedAt: row.updated_at };
      outcomes.push({ role, action: 'unchanged', agentId: row.id });
      continue;
    }

    const knownBaseline = cache[role]?.agentId === row.id ? cache[role]?.lastSyncedUpdatedAt : undefined;
    if (!knownBaseline) {
      // No cache entry for this row — crew has never synced it (or the
      // state dir was wiped) and cannot prove the current content is its
      // own last write, so this is diverged by definition: an unwritten
      // `expectedUpdatedAt` below would skip the compare-and-swap
      // entirely and silently clobber whatever is actually there.
      outcomes.push({ role, action: 'diverged', agentId: row.id });
      continue;
    }

    if (opts.dryRun) {
      outcomes.push({ role, action: 'updated', agentId: row.id });
      continue;
    }

    try {
      const updated = await client.records.update<AgentRow>(
        agentsModel.id, row.id, { prompt: defaultPrompt }, knownBaseline,
      );
      agentPersonas[role] = { agentId: row.id, lastSyncedUpdatedAt: updated.updated_at };
      outcomes.push({ role, action: 'updated', agentId: row.id });
    } catch (e) {
      if (e instanceof StaleWriteError) {
        // A workspace admin (or anything else) changed this row since crew
        // last wrote it — never overwrite, per WORKSPACE_AGENTS_PLAN.md's
        // resolved "Diverged-persona UX" decision. Leave the cache exactly
        // as it was; the caller surfaces this as a warning.
        outcomes.push({ role, action: 'diverged', agentId: row.id });
        continue;
      }
      throw e;
    }
  }

  const crewLinks = opts.dryRun
    ? []
    : await linkCrewSeats(route, client, agentsModel.id, agentPersonas, opts.userAgent);

  return { outcomes, agentPersonas, crewLinks };
}

/**
 * Provisions the `Agent` REFERENCE field on the tracker's own Crew table
 * (once per workspace, idempotent) and points each role's seat row at the
 * Agents row `syncPersonas` just resolved for it — the Migration section of
 * WORKSPACE_AGENTS_PLAN.md's "Crew records switched to reference Agents
 * instead" line. There is no legacy prompt/config data embedded on Crew
 * records to move (the table has never had such a field — `Name`, `Email`,
 * `Ship`, `Emoji`, `Status`, `Current Issue`, `Status Updated At` is the
 * whole schema as of ISSUE-416), so this is additive, not a backfill.
 */
async function linkCrewSeats(
  route: Route,
  client: TablationClient,
  agentsModelId: string,
  agentPersonas: SyncPersonasResult['agentPersonas'],
  userAgent: string | undefined,
): Promise<CrewLinkOutcome[]> {
  const seats = route.resolved!.seats;
  const rolesWithSeats = ROLE_NAMES.filter((role) => seats[role] && agentPersonas[role]);
  if (rolesWithSeats.length === 0) {
    // Distinguish "no seat configured" from "seat configured, but this
    // role's persona diverged this pass" (see CrewLinkAction's `persona_diverged`)
    // even when nothing qualifies for linking at all — a role with a seat
    // but no synced persona must not read as if the seat itself were missing.
    return ROLE_NAMES.map((role) => ({ role, action: seats[role] ? 'persona_diverged' as const : 'no_seat' as const }));
  }

  const crewModelId = route.resolved!.models.crew;
  const crewModel = await client.dataModels.get(crewModelId);
  const columnName = await ensureCrewAgentField(route, client, crewModel, agentsModelId, userAgent);

  const outcomes: CrewLinkOutcome[] = [];
  for (const role of ROLE_NAMES) {
    const seatId = seats[role];
    const agentId = agentPersonas[role]?.agentId;
    if (!seatId) { outcomes.push({ role, action: 'no_seat' }); continue; }
    if (!agentId) { outcomes.push({ role, action: 'persona_diverged' }); continue; }

    const seatRow = await client.records.get<CrewRow>(crewModelId, seatId);
    if (seatRow[CREW_AGENT_COLUMN] === agentId) { outcomes.push({ role, action: 'already_linked' }); continue; }

    await client.records.update<CrewRow>(crewModelId, seatId, { [columnName]: agentId });
    outcomes.push({ role, action: 'linked' });
  }
  return outcomes;
}

/**
 * Finds the existing single-valued REFERENCE-to-Agents field on the Crew
 * table, or creates it. `dataModels.get()`'s typed `fields` already carries
 * `fieldType.targetModelId`/`isMultiple` at runtime (declared above via
 * module augmentation) — reference fields are matched by pointing at the
 * Agents table, not by field name, since a workspace could have renamed it.
 */
async function ensureCrewAgentField(
  route: Route,
  client: TablationClient,
  crewModel: Awaited<ReturnType<TablationClient['dataModels']['get']>>,
  agentsModelId: string,
  userAgent: string | undefined,
): Promise<string> {
  const existing = crewModel.fields.find(
    (f) => f.fieldType?.kind === 'REFERENCE' && f.fieldType.targetModelId === agentsModelId && f.fieldType.isMultiple === false,
  );
  if (existing) return existing.columnName;

  const workspaceId = route.resolved!.workspaceId;
  const baseUrl = route.baseUrl.replace(/\/+$/, '');
  const apiKey = resolveApiKey(route);
  const headers = { Authorization: `Bearer ${apiKey}`, 'User-Agent': userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0' };

  const typesRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/field-types`, { headers });
  if (!typesRes.ok) throw new AgentsSyncError(`field-types lookup failed: ${typesRes.status} ${typesRes.statusText}`);
  const types = (await typesRes.json()) as FieldTypeSummary[];
  const fieldType = types.find((t) => t.kind === 'REFERENCE' && t.targetModelId === agentsModelId && t.isMultiple === false);
  if (!fieldType) {
    throw new AgentsSyncError(
      `workspace ${workspaceId} has no single-valued Agents-reference field type — every table auto-provisions one (see the pseudo-builtin reference types convention); an older Agents table may need its one-time backfill`,
    );
  }

  const createRes = await fetch(`${baseUrl}/api/data-models/${crewModel.id}/fields`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: CREW_AGENT_FIELD_NAME,
      columnName: CREW_AGENT_COLUMN,
      fieldTypeId: fieldType.id,
      description: "The Agents-table row backing this seat's persona — set by `crew agents sync` (ISSUE-416), never edited by hand.",
    }),
  });
  if (!createRes.ok) throw new AgentsSyncError(`creating the Crew table's Agent field failed: ${createRes.status} ${createRes.statusText}`);
  const created = (await createRes.json()) as { columnName: string };
  return created.columnName;
}

/** One human-readable line per persona, for `crew agents sync`'s own stdout. */
export function describeSyncOutcome(o: PersonaSyncOutcome): string {
  const label = PERSONA_NAME[o.role];
  switch (o.action) {
    case 'created': return `${label}: created (${o.agentId})`;
    case 'updated': return `${label}: prompt updated from crew's local default`;
    case 'unchanged': return `${label}: already in sync`;
    case 'diverged': return `${label}: HAS LOCAL EDITS — crew's default is newer but was NOT applied; review ${o.agentId} in the app before syncing again`;
  }
}

/** One human-readable line per persona, for the Crew-table linkage step of `crew agents sync`'s stdout. */
export function describeCrewLink(o: CrewLinkOutcome): string {
  const label = PERSONA_NAME[o.role];
  switch (o.action) {
    case 'linked': return `${label}: Crew row now references its Agents row`;
    case 'already_linked': return `${label}: Crew row already references its Agents row`;
    case 'no_seat': return `${label}: no seat configured for this role — skipped linking`;
    case 'persona_diverged': return `${label}: persona has local edits and was not synced this pass — skipped linking until it's resolved`;
  }
}

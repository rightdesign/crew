/**
 * `crew agents sync` — pushes crew's built-in personas (Developer, Design,
 * QA, Triage, Pair) into a workspace's Agents system table (ISSUE-416).
 *
 * Scope, per docs/WORKSPACE_AGENTS_PLAN.md's 2026-08-27 revision: the three
 * Agents tables now auto-provision on every workspace (ISSUE-465), so this
 * no longer creates the table — it only adds crew's own rows to one that's
 * already there, and keeps them in sync with crew's own local prompt files
 * (`route.promptsDir`'s `common.md` + `lane-<role>.md` — see the README's
 * "Prompt sets" section — the exact static content
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
 *
 * `pair` rides the same sync as a fifth persona, but it is not a polled
 * seat — nothing in select.ts/poll.ts ever assigns it a ticket, and
 * `crew connect`'s Crew-seat resolution never looks for a "pair" row. Its
 * Agents-table row exists so a live, human-paired session can fetch its own
 * persona prompt on demand — see `currentPersonaPrompt` below and
 * `crew agents prompt`.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TablationClient, StaleWriteError, TablationApiError } from '@tablation/client';
import type { Route, RoleName } from './config.ts';
import { ROLE_NAMES, resolveApiKey } from './config.ts';
import { TIERS, type Tier } from './toolchain.ts';

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
  dev: 'Developer', design: 'Design', qa: 'QA', triage: 'Triage', pair: 'Pair',
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
export function personaDefaultPrompt(promptsDir: string, role: RoleName): string {
  const briefPath = join(promptsDir, 'personas', `lane-${role}.md`);
  if (!existsSync(briefPath)) throw new AgentsSyncError(`no brief at ${briefPath}`);
  // `common.md` is the polling loop's shared policy (worktrees, one
  // stateless invocation per cycle, the three-lane hand-off protocol) — none
  // of it describes `pair`, an interactive session with full conversation
  // context and no lane of its own, so its brief is self-contained instead
  // of being prefixed with policy prose that would misdescribe it.
  if (role === 'pair') return readFileSync(briefPath, 'utf8');
  const commonPath = join(promptsDir, 'personas', 'common.md');
  if (!existsSync(commonPath)) throw new AgentsSyncError(`no shared policy at ${commonPath}`);
  return `${readFileSync(commonPath, 'utf8')}${readFileSync(briefPath, 'utf8')}`;
}

interface AgentRow {
  id: string;
  name: string;
  prompt: string;
  model?: string | null;
  /** `light` | `standard` | `deep`; null on a workspace that predates TABL-1512. */
  tier?: unknown;
  /** `anthropic` | `openai` | `google` | `openrouter`; null = inherit. */
  vendor?: unknown;
  updated_at: string;
}

/**
 * Which Agent row backs `role` on this route right now.
 *
 * `agentPersonas[role].agentId` — set the first time `crew agents sync` has
 * run for this route — is the fast path, and wins when present so an
 * explicit sync's own CAS-tracked row stays authoritative. Absent that (a
 * route `crew connect` has provisioned, ISSUE-609/610, but nobody has ever
 * run `crew agents sync` on this machine), fall back to reading the seat's
 * own `Crew.agent_id` — `discover()` (connect.ts) already links a freshly
 * created Crew row to the matching persona's Agent record at provisioning
 * time (ISSUE-611), so a session should not need a separate local sync step
 * just to see the workspace's own copy of its prompt/model.
 */
export async function resolveAgentId(
  route: Route,
  role: RoleName,
  opts: { userAgent?: string },
): Promise<string | undefined> {
  const cached = route.resolved?.agentPersonas?.[role]?.agentId;
  if (cached) return cached;

  const seatId = route.resolved?.seats?.[role];
  if (!seatId || !route.resolved) return undefined;

  const client = new TablationClient({
    baseUrl: `${route.baseUrl}/api`,
    apiKey: resolveApiKey(route),
    headers: { 'User-Agent': opts.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0' },
  } as ConstructorParameters<typeof TablationClient>[0]);

  try {
    const row = await client.records.get<{ agent_id?: string | null }>(route.resolved.models.crew, seatId);
    return row.agent_id ?? undefined;
  } catch {
    // A deleted seat row or an unreachable tracker — same "never block a
    // run" reasoning as the row fetches below.
    return undefined;
  }
}

/**
 * The live prompt for `role`'s Agent row on `route`'s workspace, when a
 * workspace admin has edited it directly in Tablation (ISSUE-526) — or
 * `undefined` when it still matches the local template, or when there is
 * nothing to compare against yet.
 *
 * Deliberately its own single-row lookup rather than reusing
 * `syncPersonas`'s four-role sync: `planAgentRun` runs once per role, every
 * cycle, and syncing is a person's explicit `crew agents sync` step, not
 * something the runner should trigger (or wait on) just to start a session.
 *
 * Per-route by construction: `route.resolved.workspaceId` (and so the
 * Agents-table row this fetches) is a route's own resolved id, never shared
 * across routes, so a customization on one workspace cannot leak into
 * another route's runs.
 */
export async function fetchDivergedPrompt(
  route: Route,
  role: RoleName,
  opts: { userAgent?: string },
): Promise<string | undefined> {
  const agentId = await resolveAgentId(route, role, opts);
  if (!agentId || !route.resolved) return undefined;

  const client = new TablationClient({
    baseUrl: `${route.baseUrl}/api`,
    apiKey: resolveApiKey(route),
    headers: { 'User-Agent': opts.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0' },
  } as ConstructorParameters<typeof TablationClient>[0]);

  let row: AgentRow;
  let agentsModelId: string;
  try {
    const agentsModel = await client.dataModels.get('agents', route.resolved.workspaceId);
    agentsModelId = agentsModel.id;
    row = await client.records.get<AgentRow>(agentsModelId, agentId);
  } catch {
    // A missing table, a deleted row, an unreachable tracker — none of
    // these should block a run that has always worked without this check;
    // the local template is always a safe fallback.
    return undefined;
  }

  const defaultPrompt = personaDefaultPrompt(route.promptsDir, role);
  if (row.prompt === defaultPrompt) return undefined;

  // ISSUE-1382: a row whose prompt merely differs from the local file is
  // not necessarily a workspace admin's edit — it may be a copy crew itself
  // wrote on an earlier sync, now stale because `common.md` /
  // `lane-<role>.md` moved on since. Apply `syncPersonas`'s own test: the
  // row only overrides the local file when its prompt no longer matches the
  // history entry crew cached for its last write. A row that still matches
  // that entry is crew's own stale copy, and the local file wins.
  //
  // With no cached baseline, or when the history lookup fails, nothing
  // proves crew wrote this row — so it keeps winning, as it always has: an
  // admin's edit must never be silently dropped.
  const cached = route.resolved.agentPersonas?.[role];
  if (cached?.agentId === agentId && cached.historyId) {
    const lastSynced = await fetchLastSyncedPrompt(route, agentsModelId, agentId, cached.historyId, opts.userAgent);
    if (lastSynced !== undefined && lastSynced === row.prompt) return undefined;
  }
  return row.prompt;
}

/**
 * The prompt crew wrote at history entry `historyId` for this row — the
 * baseline `syncPersonas` and `fetchDivergedPrompt` compare the live
 * `prompt` against to tell a stale crew write from a real admin edit.
 * `undefined` when that entry has rolled out of the history window or the
 * lookup fails; callers treat that as "no baseline" and never overwrite.
 */
async function fetchLastSyncedPrompt(
  route: Route,
  agentsModelId: string,
  recordId: string,
  historyId: string,
  userAgent: string | undefined,
): Promise<string | undefined> {
  try {
    const entries = await fetchHistoryEntries(route, agentsModelId, recordId, userAgent);
    return entries.find((e) => e.history_id === historyId)?.prompt;
  } catch {
    return undefined;
  }
}

/** What a seat's linked Agents row says about the model it wants (EPIC-035 §4). */
export interface SeatPersona {
  /** Exact model id, honored only when it belongs to the resolved toolchain's vendor. */
  model?: string;
  tier?: Tier;
  vendor?: string;
}

/** A choice column reads back as its key, or (tolerantly) as `{value|key}`. */
function choiceValue(v: unknown): string | undefined {
  const raw = typeof v === 'string' ? v : v && typeof v === 'object' ? ((v as Record<string, unknown>).value ?? (v as Record<string, unknown>).key) : undefined;
  return typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : undefined;
}

/**
 * What `role`'s linked Agent row asks for, straight from the tracker —
 * ISSUE-611's other half of "use its prompt/model fields directly at
 * runtime", widened by CREW-1515 to the `tier` and `vendor` columns
 * (TABL-1512). Unlike the prompt, none of these has a local template to
 * diverge from: they are first-class pieces of that row's own config, so
 * they are returned whenever the linked row has them set, whichever of
 * `resolveAgentId`'s two paths found the row. Each field is `undefined` when
 * unset, and the whole result is `undefined` (not synced yet, no seat, no
 * `agent_id` on the seat, an unreachable tracker) when there is nothing to
 * apply, which leaves the ship's own toolchain defaults untouched. A
 * workspace that predates the `tier`/`vendor` columns reads as `standard` /
 * inherit, i.e. both absent. An unrecognised tier is treated as absent.
 */
export async function fetchSeatPersona(
  route: Route,
  role: RoleName,
  opts: { userAgent?: string },
): Promise<SeatPersona | undefined> {
  const agentId = await resolveAgentId(route, role, opts);
  if (!agentId || !route.resolved) return undefined;

  const client = new TablationClient({
    baseUrl: `${route.baseUrl}/api`,
    apiKey: resolveApiKey(route),
    headers: { 'User-Agent': opts.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0' },
  } as ConstructorParameters<typeof TablationClient>[0]);

  try {
    const agentsModel = await client.dataModels.get('agents', route.resolved.workspaceId);
    const row = await client.records.get<AgentRow>(agentsModel.id, agentId);
    const tier = choiceValue(row.tier);
    const vendor = choiceValue(row.vendor);
    const persona: SeatPersona = {
      ...(row.model ? { model: row.model } : {}),
      ...(tier && (TIERS as readonly string[]).includes(tier) ? { tier: tier as Tier } : {}),
      ...(vendor ? { vendor } : {}),
    };
    return Object.keys(persona).length > 0 ? persona : undefined;
  } catch {
    return undefined;
  }
}

/** The model alone — the pre-CREW-1515 shape, kept for callers that only want it. */
export async function fetchSeatAgentModel(
  route: Route,
  role: RoleName,
  opts: { userAgent?: string },
): Promise<string | undefined> {
  return (await fetchSeatPersona(route, role, opts))?.model;
}

/**
 * The prompt a role's Agents row carries right now — a workspace admin's
 * live edit when there is one, else whatever `crew agents sync` last wrote
 * (which is, in turn, the local template when nobody has ever synced this
 * route). Unlike `fetchDivergedPrompt`, this always returns something: it is
 * what `crew agents prompt` prints for a caller (a `SessionStart` hook, a
 * person at a terminal) that just wants "the current text", not a diff
 * against the local file.
 */
export async function currentPersonaPrompt(
  route: Route,
  role: RoleName,
  opts: { userAgent?: string },
): Promise<string> {
  const diverged = await fetchDivergedPrompt(route, role, opts);
  return diverged ?? personaDefaultPrompt(route.promptsDir, role);
}

interface CrewRow {
  id: string;
  [CREW_AGENT_COLUMN]?: string | null;
}

/**
 * Raw shape of one row from `GET .../records/:recordId/history` — no SDK
 * resource covers this endpoint yet, same as `AgentLogTarget`'s own direct
 * `fetch` use in agent-log.ts. Newest first; every field column the record
 * has (here, `prompt`) rides along at that version's value, alongside the
 * history bookkeeping columns.
 */
export interface HistoryEntry {
  history_id: string;
  changed_at: string;
  prompt?: string;
  [column: string]: unknown;
}

/**
 * `GET .../records/:recordId/history`, newest first — no SDK resource
 * covers this endpoint yet. Exported so `logbook.ts`'s reconstruction can
 * fetch a *specific* `prompt_version` entry the same way `syncPersonas`
 * fetches the latest one below. Throws on a non-2xx response — unlike
 * `fetchLatestHistoryId`, a caller reconstructing a specific run's prompt
 * needs to know a lookup failed rather than silently treating "no rows" the
 * same as "the fetch itself broke".
 */
export async function fetchHistoryEntries(
  route: Route,
  agentsModelId: string,
  recordId: string,
  userAgent: string | undefined,
  limit = 50,
): Promise<HistoryEntry[]> {
  const url = `${route.baseUrl.replace(/\/+$/, '')}/api/data-models/${agentsModelId}/records/${recordId}/history?limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${resolveApiKey(route)}`,
      'User-Agent': userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0',
    },
  });
  if (!res.ok) throw new AgentsSyncError(`history lookup for ${recordId}: ${res.status} ${res.statusText}`);
  return (await res.json()) as HistoryEntry[];
}

/**
 * The Agents row's current version-history entry id, right after
 * `syncPersonas` has established the row's state — this is what a later
 * run's `prompt_version` (ISSUE-377/529) reconstructs against. Best-effort:
 * a lookup failure must not fail the sync it's riding along with, so this
 * returns `undefined` rather than throwing, and the caller treats an
 * undefined `historyId` exactly like a workspace `crew agents sync` has
 * never synced.
 */
async function fetchLatestHistoryId(
  route: Route,
  agentsModelId: string,
  recordId: string,
  userAgent: string | undefined,
): Promise<string | undefined> {
  try {
    const entries = await fetchHistoryEntries(route, agentsModelId, recordId, userAgent, 1);
    return entries[0]?.history_id;
  } catch {
    return undefined;
  }
}

/** Raw shape of `GET /workspaces/:id/field-types` — no SDK resource covers this endpoint yet. */
interface FieldTypeSummary {
  id: string;
  kind: string;
  targetModelId?: string | null;
  isMultiple?: boolean;
}

export type PersonaSyncAction = 'created' | 'updated' | 'unchanged' | 'diverged' | 'forced';

export interface PersonaSyncOutcome {
  role: RoleName;
  action: PersonaSyncAction;
  agentId: string;
  /** Only set for `forced` — the prompt `--force` overwrote, so the operator can see what was clobbered. */
  previousPrompt?: string;
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
  agentPersonas: Partial<Record<RoleName, { agentId: string; lastSyncedUpdatedAt: string; historyId?: string }>>;
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
  opts: { userAgent?: string; dryRun?: boolean; force?: boolean },
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
    const defaultPrompt = personaDefaultPrompt(route.promptsDir, role);
    const row = rows.find((r) => r.name === name);

    if (!row) {
      if (opts.dryRun) { outcomes.push({ role, action: 'created', agentId: '(dry run)' }); continue; }
      const created = await client.records.create<AgentRow>(agentsModel.id, { name, prompt: defaultPrompt });
      const historyId = await fetchLatestHistoryId(route, agentsModel.id, created.id, opts.userAgent);
      agentPersonas[role] = { agentId: created.id, lastSyncedUpdatedAt: created.updated_at, ...(historyId ? { historyId } : {}) };
      outcomes.push({ role, action: 'created', agentId: created.id });
      continue;
    }

    if (row.prompt === defaultPrompt) {
      // In sync content-wise regardless of who wrote it last — nothing to
      // push, just (re)anchor the cache to the row's current updated_at so
      // a later sync's compare-and-swap has the right baseline.
      const historyId = await fetchLatestHistoryId(route, agentsModel.id, row.id, opts.userAgent);
      agentPersonas[role] = { agentId: row.id, lastSyncedUpdatedAt: row.updated_at, ...(historyId ? { historyId } : {}) };
      outcomes.push({ role, action: 'unchanged', agentId: row.id });
      continue;
    }

    if (opts.force) {
      // `--force` (CREW-1055) skips the divergence check entirely — the
      // operator has already decided any local edit here is meant to be
      // discarded and re-anchored to crew's own default. Still a real
      // (non-CAS'd) write: this is the one path meant to clobber, so an
      // unlucky race with a concurrent edit is an acceptable risk here,
      // unlike every other path in this loop.
      if (opts.dryRun) { outcomes.push({ role, action: 'forced', agentId: row.id, previousPrompt: row.prompt }); continue; }
      const updated = await client.records.update<AgentRow>(agentsModel.id, row.id, { prompt: defaultPrompt });
      const historyId = await fetchLatestHistoryId(route, agentsModel.id, row.id, opts.userAgent);
      agentPersonas[role] = { agentId: row.id, lastSyncedUpdatedAt: updated.updated_at, ...(historyId ? { historyId } : {}) };
      outcomes.push({ role, action: 'forced', agentId: row.id, previousPrompt: row.prompt });
      continue;
    }

    const cached = cache[role]?.agentId === row.id ? cache[role] : undefined;
    if (!cached?.historyId) {
      // No cache entry for this row (or none with a historyId) — crew has
      // never synced it (or the state dir was wiped) and cannot prove the
      // current content is its own last write, so this is diverged by
      // definition: there's no baseline to check the prompt against.
      outcomes.push({ role, action: 'diverged', agentId: row.id });
      continue;
    }

    // CREW-1055: whether this counts as diverged is a question about the
    // `prompt` column specifically, not the row as a whole — a person (or
    // another `crew` command) moving this row between projects, or any
    // other column edit, bumps `updated_at` exactly the same as a real
    // prompt edit would, but isn't one. Compare the row's CURRENT prompt to
    // whatever crew's own last-synced history entry recorded for it: equal
    // means nothing touched the prompt since crew wrote it, so the diff
    // against `defaultPrompt` is just crew's own local template having
    // moved on, safe to push. Different means a person genuinely edited the
    // prompt in the app, which stays untouched either way.
    let lastSyncedPrompt: string | undefined;
    try {
      const entries = await fetchHistoryEntries(route, agentsModel.id, row.id, opts.userAgent);
      lastSyncedPrompt = entries.find((e) => e.history_id === cached.historyId)?.prompt;
    } catch {
      lastSyncedPrompt = undefined;
    }
    if (lastSyncedPrompt === undefined || lastSyncedPrompt !== row.prompt) {
      // Either the lookup failed, crew's last-synced version has since
      // rolled out of the history window, or the prompt itself really did
      // change since crew wrote it — none of those are safe to overwrite.
      outcomes.push({ role, action: 'diverged', agentId: row.id });
      continue;
    }

    if (opts.dryRun) {
      outcomes.push({ role, action: 'updated', agentId: row.id });
      continue;
    }

    try {
      // `row.updated_at` (not the stale cached baseline) is the correct CAS
      // target here — the content check above is what proved this write is
      // safe, and a non-prompt column change since the last sync must not
      // itself trip the compare-and-swap.
      const updated = await client.records.update<AgentRow>(
        agentsModel.id, row.id, { prompt: defaultPrompt }, row.updated_at,
      );
      const historyId = await fetchLatestHistoryId(route, agentsModel.id, row.id, opts.userAgent);
      agentPersonas[role] = { agentId: row.id, lastSyncedUpdatedAt: updated.updated_at, ...(historyId ? { historyId } : {}) };
      outcomes.push({ role, action: 'updated', agentId: row.id });
    } catch (e) {
      if (e instanceof StaleWriteError) {
        // A genuine race: something changed the row between the `list`
        // fetch above and this write. Never overwrite, per
        // WORKSPACE_AGENTS_PLAN.md's resolved "Diverged-persona UX"
        // decision. Leave the cache exactly as it was; the caller surfaces
        // this as a warning.
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
    case 'forced': return `${label}: --force overwrote local edits (previous prompt was: ${JSON.stringify(o.previousPrompt ?? '')})`;
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

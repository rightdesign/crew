/**
 * `crew logbook list` / `crew logbook show <entry> [--prompt]` — reading
 * back the Agent Log rows crew's own runs write via `reportAgentRun`
 * (agent-log.ts), including the ISSUE-377/529 prompt-reconstruction this
 * ticket exists for.
 *
 * Neither the Agent Log table nor its `history` sibling endpoint has an SDK
 * resource yet (same gap `agents.ts` already works around) — this talks to
 * both directly with the SDK's plain `records` resource plus
 * `fetchHistoryEntries` (agents.ts) for the one endpoint that has no SDK
 * coverage at all.
 */

import { createHash } from 'node:crypto';
import { TablationClient } from '@tablation/client';
import type { Route } from './config.ts';
import { resolveApiKey } from './config.ts';
import { fetchHistoryEntries } from './agents.ts';

export class LogbookError extends Error {}

/** Agent Log columns this module reads — see AGENT_LOG_COLUMNS in the synthesis backend, the source of truth for these names. */
export interface AgentLogEntry {
  id: string;
  agent_id?: string | null;
  ticket_reference?: string | null;
  outcome?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  model?: string | null;
  harness?: string | null;
  provider?: string | null;
  prompt_version?: string | null;
  prompt_sha?: string | null;
  [column: string]: unknown;
}

function client(route: Route, userAgent: string | undefined): TablationClient {
  return new TablationClient({
    baseUrl: `${route.baseUrl}/api`,
    apiKey: resolveApiKey(route),
    headers: { 'User-Agent': userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0' },
  } as ConstructorParameters<typeof TablationClient>[0]);
}

function requireWorkspace(route: Route): asserts route is Route & { resolved: NonNullable<Route['resolved']> } {
  if (!route.resolved) {
    throw new LogbookError(`route "${route.route}" has no resolved ids — run \`crew connect\` first`);
  }
}

export interface ListLogEntriesOptions {
  userAgent?: string;
  role?: string;
  ticket?: string;
  limit?: number;
}

/** Recent Agent Log entries, newest first — filterable by role (via the linked Agents row's `name`) and by ticket. */
export async function listLogEntries(route: Route, opts: ListLogEntriesOptions = {}): Promise<AgentLogEntry[]> {
  requireWorkspace(route);
  const c = client(route, opts.userAgent);
  const agentLogModel = await c.dataModels.get('agent_log', route.resolved.workspaceId);
  const filters: Array<{ columnName: string; operator: string; value: string }> = [];
  if (opts.ticket) filters.push({ columnName: 'ticket_reference', operator: 'EQ', value: opts.ticket });
  if (opts.role) {
    const agentsModel = await c.dataModels.get('agents', route.resolved.workspaceId);
    const rows = await c.records.list<{ id: string; name: string }>(agentsModel.id, { limit: 200 });
    const match = rows.find((r) => r.name.toLowerCase() === opts.role!.toLowerCase());
    if (!match) return [];
    filters.push({ columnName: 'agent_id', operator: 'EQ', value: match.id });
  }
  const entries = await c.records.list<AgentLogEntry>(agentLogModel.id, {
    limit: opts.limit ?? 20,
    ...(filters.length > 0 ? { filters: JSON.stringify(filters) } : {}),
  });
  // The records API has no documented default sort — sort newest-first
  // explicitly rather than relying on insertion order.
  return [...entries].sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')));
}

export type ReconstructionStatus = 'exact' | 'approximate' | 'not_recorded';

export interface PromptReconstruction {
  status: ReconstructionStatus;
  /** Present only for `status: 'exact' | 'approximate'`. */
  historyId?: string;
  changedAt?: string;
  prompt?: string;
  /** Why reconstruction fell short of `exact` — set for `approximate` and `not_recorded`. */
  reason?: string;
}

export interface ShowLogEntryResult {
  entry: AgentLogEntry;
  reconstruction: PromptReconstruction;
}

/**
 * Fetches one Agent Log entry and, when `withPrompt` is set, attempts to
 * reconstruct the exact prompt template that produced it: the linked
 * Agents row's history entry at `prompt_version`, hashed and compared
 * against the entry's own `prompt_sha`. Reports `exact` on a match,
 * `approximate` when the entry can be found but doesn't hash-match (the
 * local file diverged from what was synced, or the Agents row's prompt
 * changed since), and `not_recorded` when the entry predates ISSUE-377/529
 * or was never linked to an Agents row at all — every case is reported
 * rather than guessed at, per the ticket's own "must report whether the
 * reconstruction is exact" requirement.
 */
export async function showLogEntry(
  route: Route,
  entryId: string,
  opts: { userAgent?: string; withPrompt?: boolean } = {},
): Promise<ShowLogEntryResult> {
  requireWorkspace(route);
  const c = client(route, opts.userAgent);
  const agentLogModel = await c.dataModels.get('agent_log', route.resolved.workspaceId);
  let entry: AgentLogEntry;
  try {
    entry = await c.records.get<AgentLogEntry>(agentLogModel.id, entryId);
  } catch (e) {
    throw new LogbookError(`no Agent Log entry ${entryId} in this workspace (${(e as Error).message})`);
  }

  if (!opts.withPrompt) return { entry, reconstruction: { status: 'not_recorded', reason: 'not requested' } };

  if (!entry.agent_id || !entry.prompt_version) {
    return {
      entry,
      reconstruction: {
        status: 'not_recorded',
        reason: !entry.agent_id
          ? 'this entry has no linked Agents row (predates crew agents sync being run for its role)'
          : 'this entry predates ISSUE-377/529 — no prompt_version was recorded',
      },
    };
  }

  const agentsModel = await c.dataModels.get('agents', route.resolved.workspaceId);
  let historyEntries: Awaited<ReturnType<typeof fetchHistoryEntries>>;
  try {
    historyEntries = await fetchHistoryEntries(route, agentsModel.id, entry.agent_id, opts.userAgent, 200);
  } catch (e) {
    return { entry, reconstruction: { status: 'approximate', reason: `history lookup failed: ${(e as Error).message}` } };
  }

  const match = historyEntries.find((h) => h.history_id === entry.prompt_version);
  if (!match) {
    return {
      entry,
      reconstruction: {
        status: 'approximate',
        reason: `history entry ${entry.prompt_version} no longer exists on the Agents row (purged, or the row itself was recreated)`,
      },
    };
  }

  const prompt = match.prompt ?? '';
  const actualSha = createHash('sha256').update(prompt).digest('hex');
  const exact = !!entry.prompt_sha && actualSha === entry.prompt_sha;
  return {
    entry,
    reconstruction: {
      status: exact ? 'exact' : 'approximate',
      historyId: match.history_id,
      changedAt: match.changed_at,
      prompt,
      ...(exact ? {} : { reason: entry.prompt_sha ? 'stored prompt_sha does not match this history entry\'s content' : 'this entry recorded no prompt_sha to verify against' }),
    },
  };
}

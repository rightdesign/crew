/**
 * Reporting one crew run into a workspace's Agent Log / Agent Log Cycles
 * system tables, via the endpoints ISSUE-457 added
 * (`POST .../agents/log`, `POST .../agents/log/:id/cycles`).
 *
 * Neither table has an SDK resource in `@tablation/client` yet — this talks
 * to them directly with `fetch`, the same pattern `connect.ts`'s `get()`
 * already uses for `/auth/my-workspaces`.
 *
 * Best-effort by design, same reasoning as `Emitter`'s own sinks
 * (agent.ts's `openSink`): a workspace that has never run `crew agents
 * sync` (no cached persona id), or a network hiccup while reporting, must
 * never fail the agent run it is reporting on. The caller (`spawnAgent`) is
 * expected to wrap every call here in its own try/catch and only warn.
 */

export interface AgentLogTarget {
  baseUrl: string;
  workspaceId: string;
  apiKey: string;
  userAgent: string;
  /**
   * This role's Agents-table row id, from `route.resolved.agentPersonas`
   * (agents.ts / ISSUE-416's own sync command) — undefined until that has
   * been run once for this workspace. `POST .../agents/log`'s `agentId` is
   * optional, so a run reports with no Agent reference rather than being
   * skipped entirely.
   */
  agentId?: string;
}

export interface AgentCycle {
  cycleIndex: number;
  /** ISO 8601 — when this cycle was observed. */
  occurredAt: string;
  /** A thinking block's text, or an assistant conversational reply's text — see `role`. */
  thinking: string;
  /**
   * 'assistant' for a conversational text turn (ISSUE-594), tagged the same
   * way `agent-chat.service.ts`'s `logChatRun` (ISSUE-504) already tags
   * plain assistant text in this same column. Omitted for a thinking block,
   * matching crew's pre-existing cycles — the Activity Log viewer treats a
   * missing role as 'assistant' for backward compatibility either way.
   */
  role?: 'assistant';
}

export interface AgentRunReport {
  ticketReference?: string;
  outcome: string;
  startedAt: string;
  finishedAt: string;
  cycles: AgentCycle[];
  /** As reported by the run — `plan.model`, the model this ship was configured to run. */
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  /**
   * ISSUE-377/529: the Agents row's history-entry id current as of the
   * `crew agents sync` that last established this role's persona
   * (`route.resolved.agentPersonas[role].historyId`) — lets
   * `crew logbook show --prompt` fetch the exact template version that
   * produced this run.
   */
  promptVersion?: string;
  /**
   * ISSUE-377/529: hash of the actually-composed local template body
   * (`common.md` + `lane-<role>.md`) at run time — a check value for the
   * reconstruction above, not a storage key.
   */
  promptSha?: string;
}

async function post<T>(target: AgentLogTarget, path: string, body: unknown): Promise<T> {
  const url = `${target.baseUrl.replace(/\/+$/, '')}/api/workspaces/${target.workspaceId}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      // Cloudflare 403s default agents on this host — same header connect.ts sends.
      'User-Agent': target.userAgent,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/**
 * Creates the Agent Log row for this run, then flushes its buffered cycles
 * against the new row's id, in order. Cycles are posted sequentially rather
 * than concurrently — `Cycle Index` is meaningful order, and the endpoint
 * has no batch form.
 */
export async function reportAgentRun(
  target: AgentLogTarget,
  run: AgentRunReport,
): Promise<{ agentLogId: string }> {
  const entry = await post<{ id: string }>(target, '/agents/log', {
    agentId: target.agentId,
    ticketReference: run.ticketReference,
    outcome: run.outcome,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    source: 'client',
    client: 'crew',
    model: run.model,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    cacheReadTokens: run.cacheReadTokens,
    cacheWriteTokens: run.cacheWriteTokens,
    costUsd: run.costUsd,
    promptVersion: run.promptVersion,
    promptSha: run.promptSha,
  });
  for (const cycle of run.cycles) {
    await post(target, `/agents/log/${entry.id}/cycles`, {
      cycleIndex: cycle.cycleIndex,
      occurredAt: cycle.occurredAt,
      thinking: cycle.thinking,
      ...(cycle.role ? { role: cycle.role } : {}),
    });
  }
  return { agentLogId: entry.id };
}

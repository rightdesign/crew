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
  /** ISO 8601 — when this cycle's thinking block was observed. */
  occurredAt: string;
  thinking: string;
}

export interface AgentRunReport {
  ticketReference?: string;
  outcome: string;
  startedAt: string;
  finishedAt: string;
  cycles: AgentCycle[];
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
  });
  for (const cycle of run.cycles) {
    await post(target, `/agents/log/${entry.id}/cycles`, {
      cycleIndex: cycle.cycleIndex,
      occurredAt: cycle.occurredAt,
      thinking: cycle.thinking,
    });
  }
  return { agentLogId: entry.id };
}

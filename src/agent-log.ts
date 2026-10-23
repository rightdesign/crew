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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sleepBackoff } from './pending-backoff.ts';

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
   * Who ran and who served the model (CREW-1516, EPIC-035 §13; the server's
   * DTO fields from TABL-1513). Dropped and retried once when the server
   * rejects them as unknown (an older build), so they never fail a report.
   */
  harness?: string;
  provider?: string;
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

/**
 * The Agent Log row could not be created because the tracker did not answer
 * (a transport failure or a 5xx). Nothing was written, so the report can be
 * queued and sent again without duplicating a row (CREW-2363); a failure while
 * posting cycles is not this, because a row already exists by then.
 */
export class AgentLogUnreachableError extends Error {}

class AgentLogHttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
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
  if (!res.ok) throw new AgentLogHttpError(`${path}: ${res.status} ${res.statusText}`, res.status);
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
  const body = {
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
  };
  let entry: { id: string };
  try {
    entry = await post<{ id: string }>(target, '/agents/log', { ...body, harness: run.harness, provider: run.provider });
  } catch (e) {
    if (!(e instanceof AgentLogHttpError)) throw new AgentLogUnreachableError((e as Error).message);
    if (e.status >= 500) throw new AgentLogUnreachableError(e.message);
    // A server that predates the identity fields validates them away as
    // unknown properties with a 400; the run still deserves its row.
    if (!(e instanceof AgentLogHttpError) || e.status !== 400 || (!run.harness && !run.provider)) throw e;
    entry = await post<{ id: string }>(target, '/agents/log', body);
  }
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

// ---------------------------------------------------------------------------
// The queue (CREW-2363): a report the tracker could not take is kept on disk and
// sent by a later pass, instead of being dropped on the first 5xx.
// ---------------------------------------------------------------------------

export interface QueuedAgentRun {
  version: 1;
  route: string;
  role: string;
  /** The target without its key: the key is resolved again by whoever replays. */
  target: Omit<AgentLogTarget, 'apiKey'>;
  report: AgentRunReport;
  attempts: number;
  nextAttemptAt: string;
  warned?: boolean;
}

const queueDir = (stateDir: string): string => join(stateDir, 'pending-agent-logs');

export function queueAgentRun(stateDir: string, name: string, q: QueuedAgentRun): void {
  mkdirSync(queueDir(stateDir), { recursive: true });
  writeFileSync(join(queueDir(stateDir), `${name}.json`), JSON.stringify(q));
}

/**
 * Sends every due queued report for `route`. `keyFor` resolves the seat's key
 * (it may throw or return undefined, which skips the record). Returns how many
 * were sent. A record that still cannot be sent waits longer and warns once.
 */
export async function replayQueuedAgentRuns(
  stateDir: string, route: string, keyFor: (role: string) => Promise<string | undefined>,
  log: { emit(m: string): unknown; warn(m: string): unknown }, now: Date = new Date(),
): Promise<number> {
  const dir = queueDir(stateDir);
  if (!existsSync(dir)) return 0;
  let sent = 0;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const path = join(dir, f);
    let q: QueuedAgentRun;
    try { q = JSON.parse(readFileSync(path, 'utf8')) as QueuedAgentRun; } catch { continue; }
    if (q.version !== 1 || q.route !== route || now.toISOString() < q.nextAttemptAt) continue;
    try {
      const apiKey = await keyFor(q.role);
      if (!apiKey) continue;
      await reportAgentRun({ ...q.target, apiKey }, q.report);
      rmSync(path, { force: true });
      sent += 1;
      log.emit(`sent a queued Agent Log report (${f})`);
    } catch (e) {
      if (!(e instanceof AgentLogUnreachableError)) {
        rmSync(path, { force: true });   // a refusal or a half-written row: sending it again would not help or would duplicate
        log.warn(`dropped a queued Agent Log report (${f}): ${(e as Error).message}`);
        continue;
      }
      const attempts = q.attempts + 1;
      writeFileSync(path, JSON.stringify({
        ...q, attempts, warned: true,
        nextAttemptAt: new Date(now.getTime() + sleepBackoff(attempts)).toISOString(),
      }));
      if (!q.warned) log.warn(`a queued Agent Log report could not be sent yet (${(e as Error).message}); will retry`);
    }
  }
  return sent;
}

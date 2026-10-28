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
  /**
   * Where the run's ticket lives and which Issues columns accumulate its spend
   * (CREW-2580). Absent for a caller with no resolved Issues table, which
   * reports the Agent Log row alone.
   */
  tickets?: {
    issuesModelId: string;
    /** Columns a ticket reference (`ISSUE-12` or a project tag `CREW-12`) is matched on. */
    keyColumn: string;
    tagColumn: string;
    counters: CounterColumns;
  };
}

export interface CounterColumns {
  agentRuns: string;
  tokensIn: string;
  tokensOut: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
  costUsd: string;
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

/**
 * A data-model call. These routes are unprefixed (`/api/data-models/...`); the
 * workspace-prefixed form 404s on the live tracker, and only `/agents/log`
 * (see `post`) lives under `/api/workspaces/<id>`.
 */
async function request<T>(target: AgentLogTarget, method: string, path: string, body?: unknown): Promise<T> {
  const url = `${target.baseUrl.replace(/\/+$/, '')}/api${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      'User-Agent': target.userAgent,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new AgentLogHttpError(`${path}: ${res.status} ${res.statusText}`, res.status);
  return (await res.json()) as T;
}

const issueColumns = new Map<string, Promise<Set<string>>>();

/** Test hook: the per-process column probe is otherwise read once per Issues table. */
export function resetCounterColumnCache(): void { issueColumns.clear(); }

/** The columns the Issues table has, read once per process; a failed read is not remembered. */
function columnsOf(target: AgentLogTarget, modelId: string): Promise<Set<string>> {
  const key = `${target.baseUrl}|${target.workspaceId}|${modelId}`;
  let p = issueColumns.get(key);
  if (!p) {
    p = request<{ fields?: Array<{ columnName: string }> }>(target, 'GET', `/data-models/${modelId}`)
      .then((m) => new Set((m.fields ?? []).map((f) => f.columnName)));
    p.catch(() => issueColumns.delete(key));
    issueColumns.set(key, p);
  }
  return p;
}

/** The Issues record id a ticket reference names, or undefined when it cannot be resolved. */
async function findTicketRecord(target: AgentLogTarget, t: NonNullable<AgentLogTarget['tickets']>, ref: string): Promise<string | undefined> {
  const filters = {
    combinator: 'OR',
    conditions: [
      { columnName: t.keyColumn, operator: 'EQ', value: ref },
      { columnName: t.tagColumn, operator: 'EQ', value: ref },
    ],
  };
  const rows = await request<Array<{ id: string }>>(
    target, 'GET', `/data-models/${t.issuesModelId}/records?limit=2&filters=${encodeURIComponent(JSON.stringify(filters))}`,
  );
  return rows.length === 1 ? rows[0]!.id : undefined;
}

/**
 * The atomic-increment body for one run: a counter whose figure the harness did
 * not report is omitted (never 0), and only columns the table has are sent.
 * Empty when there is nothing to add.
 */
export function counterIncrements(
  run: AgentRunReport, cols: CounterColumns, have: ReadonlySet<string>,
): Record<string, { $op: 'increment'; value: number }> {
  const figures: Array<[string, number | undefined]> = [
    [cols.agentRuns, 1],
    [cols.tokensIn, run.tokensIn],
    [cols.tokensOut, run.tokensOut],
    [cols.cacheReadTokens, run.cacheReadTokens],
    [cols.cacheWriteTokens, run.cacheWriteTokens],
    [cols.costUsd, run.costUsd],
  ];
  const out: Record<string, { $op: 'increment'; value: number }> = {};
  for (const [column, value] of figures) {
    if (value !== undefined && Number.isFinite(value) && have.has(column)) out[column] = { $op: 'increment', value };
  }
  return out;
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
): Promise<{ agentLogId: string; counterWarning?: string; counterRetry?: TicketCounterWrite }> {
  // Best effort: a ticket that cannot be resolved just leaves the row pointing at its tag.
  let ticketRecordId: string | undefined;
  if (target.tickets && run.ticketReference) {
    try { ticketRecordId = await findTicketRecord(target, target.tickets, run.ticketReference); } catch { /* the row still gets written */ }
  }
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
  const workItem = target.tickets && ticketRecordId
    ? { workItemTable: target.tickets.issuesModelId, workItemRecordId: ticketRecordId }
    : {};
  let entry: { id: string };
  try {
    entry = await post<{ id: string }>(target, '/agents/log', { ...body, ...workItem, harness: run.harness, provider: run.provider });
  } catch (e) {
    if (!(e instanceof AgentLogHttpError)) throw new AgentLogUnreachableError((e as Error).message);
    if (e.status >= 500) throw new AgentLogUnreachableError(e.message);
    // A server that predates the identity or work-item fields validates them
    // away as unknown properties with a 400; the run still deserves its row.
    if (e.status !== 400 || (!run.harness && !run.provider && !ticketRecordId)) throw e;
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
  const counters = target.tickets && ticketRecordId
    ? await addRunToTicket(target, target.tickets, ticketRecordId, run)
    : undefined;
  return {
    agentLogId: entry.id,
    ...(counters?.warning ? { counterWarning: counters.warning } : {}),
    ...(counters?.retry ? { counterRetry: counters.retry } : {}),
  };
}

/**
 * One ticket's counter increment that the tracker could not take (a 5xx or no
 * answer), kept so it can be sent on its own: the Agent Log row already
 * exists, so replaying the whole report would duplicate it (CREW-2580).
 */
export interface TicketCounterWrite {
  issuesModelId: string;
  recordId: string;
  ticketReference?: string;
  /** Increments for every configured counter the run reported; the replay drops columns the table lacks. */
  body: Record<string, { $op: 'increment'; value: number }>;
  counters: CounterColumns;
}

/** Only an unanswered request is worth sending again; a 4xx would fail the same way. */
const isRetryable = (e: unknown): boolean => !(e instanceof AgentLogHttpError) || e.status >= 500;

/** Probes the table's columns, then sends only the increments it can take. Throws on a failed call. */
async function writeCounters(target: AgentLogTarget, w: TicketCounterWrite): Promise<void> {
  const have = await columnsOf(target, w.issuesModelId);
  const body = Object.fromEntries(Object.entries(w.body).filter(([column]) => have.has(column)));
  if (Object.keys(body).length === 0) return;
  await request(target, 'PATCH', `/data-models/${w.issuesModelId}/records/${w.recordId}`, body);
}

/**
 * Adds this run's usage to the ticket's counters (CREW-2580) once its Agent
 * Log row exists, so a replayed report counts exactly once. Best effort: the
 * run and its row are already recorded, so a failure comes back as a warning
 * for the caller to log instead of failing the report.
 */
async function addRunToTicket(
  target: AgentLogTarget, t: NonNullable<AgentLogTarget['tickets']>, recordId: string, run: AgentRunReport,
): Promise<{ warning?: string; retry?: TicketCounterWrite }> {
  const write: TicketCounterWrite = {
    issuesModelId: t.issuesModelId, recordId, ticketReference: run.ticketReference, counters: t.counters,
    body: counterIncrements(run, t.counters, new Set(Object.values(t.counters))),
  };
  try {
    await writeCounters(target, write);
    return {};
  } catch (e) {
    return {
      warning: `could not add run spend to ${run.ticketReference}: ${(e as Error).message}`,
      ...(isRetryable(e) ? { retry: write } : {}),
    };
  }
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
      const sentRun = await reportAgentRun({ ...q.target, apiKey }, q.report);
      if (sentRun.counterWarning) log.warn(sentRun.counterWarning);
      if (sentRun.counterRetry) queueTicketCounters(stateDir, f.replace(/\.json$/, ''), {
        version: 1, route: q.route, role: q.role, target: q.target, write: sentRun.counterRetry,
        attempts: 0, nextAttemptAt: new Date().toISOString(),
      });
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

// ---------------------------------------------------------------------------
// The counter queue (CREW-2580): an increment the tracker could not take after
// the run's Agent Log row was written. Kept apart from the report queue so a
// replay sends only the PATCH and never posts the row again.
// ---------------------------------------------------------------------------

export interface QueuedTicketCounters {
  version: 1;
  route: string;
  role: string;
  /** The target without its key: the key is resolved again by whoever replays. */
  target: Omit<AgentLogTarget, 'apiKey'>;
  write: TicketCounterWrite;
  attempts: number;
  nextAttemptAt: string;
  warned?: boolean;
}

const countersDir = (stateDir: string): string => join(stateDir, 'pending-ticket-counters');

export function queueTicketCounters(stateDir: string, name: string, q: QueuedTicketCounters): void {
  mkdirSync(countersDir(stateDir), { recursive: true });
  writeFileSync(join(countersDir(stateDir), `${name}.json`), JSON.stringify(q));
}

/**
 * Sends every due queued counter increment for `route`, each exactly once: a
 * record is removed when the PATCH lands. A refusal drops it with a warning; an
 * unanswered request waits longer and warns once. Returns how many were sent.
 */
export async function replayQueuedTicketCounters(
  stateDir: string, route: string, keyFor: (role: string) => Promise<string | undefined>,
  log: { emit(m: string): unknown; warn(m: string): unknown }, now: Date = new Date(),
): Promise<number> {
  const dir = countersDir(stateDir);
  if (!existsSync(dir)) return 0;
  let sent = 0;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const path = join(dir, f);
    let q: QueuedTicketCounters;
    try { q = JSON.parse(readFileSync(path, 'utf8')) as QueuedTicketCounters; } catch { continue; }
    if (q.version !== 1 || q.route !== route || now.toISOString() < q.nextAttemptAt) continue;
    try {
      const apiKey = await keyFor(q.role);
      if (!apiKey) continue;
      await writeCounters({ ...q.target, apiKey }, q.write);
      rmSync(path, { force: true });
      sent += 1;
      log.emit(`added a queued run's spend to ${q.write.ticketReference ?? q.write.recordId} (${f})`);
    } catch (e) {
      if (!isRetryable(e)) {
        rmSync(path, { force: true });
        log.warn(`dropped a queued ticket counter update (${f}): ${(e as Error).message}`);
        continue;
      }
      const attempts = q.attempts + 1;
      writeFileSync(path, JSON.stringify({
        ...q, attempts, warned: true,
        nextAttemptAt: new Date(now.getTime() + sleepBackoff(attempts)).toISOString(),
      }));
      if (!q.warned) log.warn(`a queued ticket counter update could not be sent yet (${(e as Error).message}); will retry`);
    }
  }
  return sent;
}

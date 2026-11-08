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
import type { BeforeFirstEdit } from './tool-classify.ts';
import { sleepBackoff } from './pending-backoff.ts';
import { ACCEPTANCE_BOUNCED_MARKER } from './handoff-guard.ts';

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
   * The seat that performs the run (CREW-3116): the Crew table's model id and the seat's row id,
   * stamped on the Agent Log row as `actor_table` / `actor_record_id` so the platform can say which
   * agent instance ran it. Absent for a route with no resolved seat.
   */
  actor?: { table: string; recordId: string };
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
   * API calls the run made (the result line's `num_turns`) and the input plus
   * cache-creation tokens of its first call. Omitted when unknown — never 0.
   */
  numTurns?: number;
  prefixTokens?: number;
  /**
   * Tool calls before the run's first edit (CREW-2879). Written to the row
   * only for the columns the workspace's Agent Log has (`writeBeforeFirstEdit`).
   */
  beforeFirstEdit?: BeforeFirstEdit;
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
  /**
   * CREW-2980: set for an `auth: workspace` run. The workspace endpoint wrote one `inference`
   * row per model call with this run id, so those rows are the accounting: the run row itself
   * carries no tokens or cost, and `reportAgentRun` sums the inference rows into the ticket's
   * counters (counted once).
   */
  runId?: string;
  /**
   * CREW-3038: the Agent Log row `startAgentRunRow` posted when the run began. When set, the end of
   * the run updates that row (outcome, finish time, turns, ticket) instead of posting a second one.
   */
  rowId?: string;
  /**
   * CREW-3116: how many leading `cycles` the live reporter already delivered to the started row.
   * The end-of-run report posts only the rest, so nothing is sent twice and nothing is lost when the
   * platform lacked the lifecycle endpoints.
   */
  cyclesPosted?: number;
  /**
   * The harness's own totals for that run. Used for the ticket counters only when the endpoint
   * wrote no inference row for the run (an older server that predates the Run Id column), so a
   * run's spend is never lost; never written to the run row.
   */
  harnessTotals?: Pick<AgentRunReport, 'tokensIn' | 'tokensOut' | 'cacheReadTokens' | 'cacheWriteTokens' | 'costUsd'>;
}

/** Figures summed over a run's inference rows. */
export interface InferenceTotals {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/** The Agent Log columns an inference row's figures sit in (the server's AGENT_LOG_COLUMNS). */
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/** Sums raw Agent Log rows into totals. Pure, so `crew logbook show` and the ticket counters agree. */
export function sumInferenceRows(rows: ReadonlyArray<Record<string, unknown>>): InferenceTotals {
  const t: InferenceTotals = { calls: 0, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  for (const r of rows) {
    t.calls++;
    t.tokensIn += num(r.input_tokens);
    t.tokensOut += num(r.output_tokens);
    t.cacheReadTokens += num(r.cache_read_tokens);
    t.cacheWriteTokens += num(r.cache_write_tokens);
    t.costUsd += num(r.cost_usd);
  }
  return t;
}

const INFERENCE_PAGE = 1000;

/**
 * Every `client: inference` Agent Log row of one run (CREW-2980), read through the data-model
 * records API. `modelId` is the Agent Log table. Pages until a short page, so a long run is not
 * cut at the list cap.
 */
export async function listInferenceRows(
  target: Pick<AgentLogTarget, 'baseUrl' | 'apiKey' | 'userAgent'>, modelId: string, runId: string,
): Promise<Array<Record<string, unknown>>> {
  const filters = encodeURIComponent(JSON.stringify({
    combinator: 'AND',
    conditions: [
      { columnName: 'run_id', operator: 'EQ', value: runId },
      { columnName: 'client', operator: 'EQ', value: 'inference' },
    ],
  }));
  const out: Array<Record<string, unknown>> = [];
  for (let offset = 0; ; offset += INFERENCE_PAGE) {
    const page = await request<Array<Record<string, unknown>>>(
      target as AgentLogTarget, 'GET', `/data-models/${modelId}/records?limit=${INFERENCE_PAGE}&offset=${offset}&filters=${filters}`,
    );
    out.push(...page);
    if (page.length < INFERENCE_PAGE) return out;
  }
}

/**
 * The run's inference totals, or undefined when the endpoint wrote no row for it (or the table
 * has no `run_id` column), in which case the caller falls back to the harness's own figures.
 */
async function inferenceTotalsFor(target: AgentLogTarget, runId: string): Promise<InferenceTotals | undefined> {
  const model = await request<{ id: string }>(
    target, 'GET', `/data-models/agent_log?workspaceId=${encodeURIComponent(target.workspaceId)}`,
  );
  if (!(await columnsOf(target, model.id)).has('run_id')) return undefined;
  const rows = await listInferenceRows(target, model.id, runId);
  return rows.length > 0 ? sumInferenceRows(rows) : undefined;
}

/**
 * The Agent Log row could not be created because the tracker did not answer
 * (a transport failure or a 5xx). Nothing was written, so the report can be
 * queued and sent again without duplicating a row (CREW-2363); a failure while
 * posting cycles is not this, because a row already exists by then.
 */
export class AgentLogUnreachableError extends Error {}

export class AgentLogHttpError extends Error {
  status: number;
  /** True when the refusal was of the Agent Log row itself (not a later cycle post): the tracker is not taking this seat's reports (CREW-2832). */
  row = false;
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

/** Agent Log columns for the before-first-edit figures; each is written only when the workspace's table has it. */
export const BEFORE_EDIT_COLUMNS = {
  search: 'calls_before_edit_search',
  symbol: 'calls_before_edit_symbol',
  other: 'calls_before_edit_other',
  seconds: 'seconds_to_first_edit',
  edited: 'edited',
} as const;

/** The columns of the Agent Log row a before-first-edit write would set, before filtering to the table's own. */
export function beforeFirstEditBody(b: BeforeFirstEdit): Record<string, number | boolean> {
  return {
    [BEFORE_EDIT_COLUMNS.search]: b.calls.search,
    [BEFORE_EDIT_COLUMNS.symbol]: b.calls.symbol,
    [BEFORE_EDIT_COLUMNS.other]: b.calls.other,
    [BEFORE_EDIT_COLUMNS.edited]: b.edited,
    ...(b.secondsToFirstEdit !== undefined ? { [BEFORE_EDIT_COLUMNS.seconds]: b.secondsToFirstEdit } : {}),
  };
}

/**
 * Sets the before-first-edit figures on a new Agent Log row, for the columns
 * the workspace has. Best effort and silent: a workspace without the columns,
 * a key that may not edit the table, or any failure leaves the run's report
 * exactly as it was (CREW-2879).
 */
async function writeBeforeFirstEdit(target: AgentLogTarget, rowId: string, b: BeforeFirstEdit): Promise<void> {
  try {
    const model = await request<{ id: string }>(
      target, 'GET', `/data-models/agent_log?workspaceId=${encodeURIComponent(target.workspaceId)}`,
    );
    const have = await columnsOf(target, model.id);
    const body = Object.fromEntries(Object.entries(beforeFirstEditBody(b)).filter(([column]) => have.has(column)));
    if (Object.keys(body).length === 0) return;
    await request(target, 'PATCH', `/data-models/${model.id}/records/${rowId}`, body);
  } catch { /* the columns are optional */ }
}

/** Agent Log column counting the acceptance bounces a run's ticket had taken before this run (CREW-2970). */
export const HANDOFF_BOUNCES_COLUMN = 'handoff_bounces';

/**
 * How many times the hand-off guard bounced the ticket for a missing acceptance
 * checklist before this run ended: for the retry that finally passes, that is the
 * number of attempts it took. The guard runs after the run's own report is written,
 * so a run's own bounce shows up on the next run's row. `null` when the event log
 * cannot be read.
 */
export async function countAcceptanceBounces(target: AgentLogTarget, issuesModelId: string, ticketRecordId: string): Promise<number | null> {
  try {
    const filters = encodeURIComponent(JSON.stringify([{ columnName: 'event_type', operator: 'EQ', value: 'bounced' }]));
    const rows = await request<Array<{ record_id?: string; message?: string | null }>>(
      target, 'GET', `/data-models/${issuesModelId}/events?limit=500&filters=${filters}`,
    );
    return rows.filter((e) => e.record_id === ticketRecordId && (e.message ?? '').includes(ACCEPTANCE_BOUNCED_MARKER)).length;
  } catch { return null; }
}

/** Sets `handoff_bounces` on the new Agent Log row when the workspace's table has the column. Best effort and silent. */
async function writeHandoffBounces(target: AgentLogTarget, rowId: string, count: number): Promise<void> {
  try {
    const model = await request<{ id: string }>(
      target, 'GET', `/data-models/agent_log?workspaceId=${encodeURIComponent(target.workspaceId)}`,
    );
    if (!(await columnsOf(target, model.id)).has(HANDOFF_BOUNCES_COLUMN)) return;
    await request(target, 'PATCH', `/data-models/${model.id}/records/${rowId}`, { [HANDOFF_BOUNCES_COLUMN]: count });
  } catch { /* the column is optional */ }
}

async function post<T>(target: AgentLogTarget, path: string, body: unknown): Promise<T> {
  return send<T>(target, 'POST', path, body);
}

async function send<T>(target: AgentLogTarget, method: 'POST' | 'PATCH', path: string, body: unknown): Promise<T> {
  const url = `${target.baseUrl.replace(/\/+$/, '')}/api/workspaces/${target.workspaceId}${path}`;
  const res = await fetch(url, {
    method,
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

/** What `startAgentRunRow` writes: the run row as it reads while the run is still going. */
export interface AgentRunStart {
  /** The workspace-auth run id; absent for a run whose inference is not metered by the platform. */
  runId?: string;
  ticketReference?: string;
  startedAt: string;
  model?: string;
  harness?: string;
  provider?: string;
  promptVersion?: string;
  promptSha?: string;
  /** The seat's name when the run started, used when the Crew row cannot be read. */
  actorLabel?: string;
}

/** A started row, and whether the platform has the live-run lifecycle endpoints (CREW-3116). */
export interface StartedRow {
  id: string;
  /** False when the platform rejected the actor columns: it predates the lifecycle, so cycles go up at the end of the run. */
  live: boolean;
}

/**
 * Posts the run's Agent Log row when the run begins (CREW-3038, CREW-3116): no outcome and no finish
 * time, so the platform lists it as live and its sweep can mark it interrupted if the run goes
 * silent. The seat is stamped as the actor. Per-call inference rows (joined by `run_id`) fold under
 * it from the first call. Returns the row, or undefined when it could not be posted: best effort,
 * because the end-of-run report still posts the whole row when there is no id to update.
 */
export async function startAgentRunRow(target: AgentLogTarget, s: AgentRunStart): Promise<StartedRow | undefined> {
  // Nothing to gain from an early row: no seat to show as the actor and no metered inference to fold under it.
  if (!target.actor && !s.runId) return undefined;
  const body = {
    agentId: target.agentId,
    ticketReference: s.ticketReference,
    startedAt: s.startedAt,
    source: 'client',
    client: 'crew',
    model: s.model,
    promptVersion: s.promptVersion,
    promptSha: s.promptSha,
    runId: s.runId,
    harness: s.harness,
    provider: s.provider,
  };
  let actor: Record<string, string> = {};
  if (target.actor) {
    let label = s.actorLabel;
    try {
      const row = await request<{ name?: string | null }>(target, 'GET', `/data-models/${target.actor.table}/records/${target.actor.recordId}`);
      if (row.name) label = row.name;
    } catch { /* the label is a convenience */ }
    actor = { actorTable: target.actor.table, actorRecordId: target.actor.recordId, ...(label ? { actorLabel: label } : {}) };
  }
  try {
    const entry = await post<{ id: string }>(target, '/agents/log', { ...body, ...actor });
    return { id: entry.id, live: target.actor !== undefined };
  } catch (e) {
    // A platform that predates the actor columns rejects them as unknown properties (400):
    // it has no lifecycle either, so the row is still started and everything else waits for the end.
    if (!(e instanceof AgentLogHttpError) || e.status !== 400 || Object.keys(actor).length === 0) return undefined;
  }
  // Without a run id there is nothing to fold under an early row either: the end-of-run report posts it whole.
  if (!s.runId) return undefined;
  try {
    const entry = await post<{ id: string }>(target, '/agents/log', body);
    return { id: entry.id, live: false };
  } catch {
    return undefined;
  }
}

/** Agent Log columns the end-of-run update of a started row writes (the rest were set at the start). */
function finishedRowBody(run: AgentRunReport, workItem: { workItemTable?: string; workItemRecordId?: string }): Record<string, unknown> {
  const values: Record<string, unknown> = {
    ticket_reference: run.ticketReference,
    outcome: run.outcome,
    finished_at: run.finishedAt,
    model: run.model,
    input_tokens: run.tokensIn,
    output_tokens: run.tokensOut,
    cache_read_tokens: run.cacheReadTokens,
    cache_write_tokens: run.cacheWriteTokens,
    cost_usd: run.costUsd,
    num_turns: run.numTurns,
    prefix_tokens: run.prefixTokens,
    prompt_version: run.promptVersion,
    prompt_sha: run.promptSha,
    harness: run.harness,
    provider: run.provider,
    work_item_table: workItem.workItemTable,
    work_item_record_id: workItem.workItemRecordId,
  };
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
}

/**
 * Updates the row `startAgentRunRow` posted. Only columns the table has are sent. A 404 (the row
 * was deleted) returns false so the caller posts the row whole; an unanswered request is the same
 * "nothing written, safe to send again" failure as a failed post.
 */
async function updateStartedRow(target: AgentLogTarget, rowId: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const model = await request<{ id: string }>(
      target, 'GET', `/data-models/agent_log?workspaceId=${encodeURIComponent(target.workspaceId)}`,
    );
    const have = await columnsOf(target, model.id);
    const values = Object.fromEntries(Object.entries(body).filter(([column]) => have.has(column)));
    await request(target, 'PATCH', `/data-models/${model.id}/records/${rowId}`, values);
    return true;
  } catch (e) {
    if (!(e instanceof AgentLogHttpError)) throw new AgentLogUnreachableError((e as Error).message);
    if (e.status === 404) return false;
    if (e.status >= 500) throw new AgentLogUnreachableError(e.message);
    e.row = true;
    throw e;
  }
}

/** CREW-3118: one operator note as the platform hands it back (`pendingMessages`, TABL-3111). */
export interface PendingMessage {
  id: string;
  agentLogId?: string;
  authorId: string | null;
  text: string;
  occurredAt: string | null;
  deliveryState?: 'queued' | 'delivered' | 'carried_forward';
}

/** How a note reached the agent, as the platform records it. */
export type MessageDeliveryState = 'delivered' | 'carried_forward';

/** Tells the platform what became of a note. Best effort: a note left `queued` is still picked up by the next run's brief. */
export async function markMessage(target: AgentLogTarget, rowId: string, messageId: string, state: MessageDeliveryState): Promise<boolean> {
  try {
    await send(target, 'PATCH', `/agents/log/${rowId}/messages/${messageId}`, { deliveryState: state });
    return true;
  } catch { return false; }
}

/** Queued and carried-forward notes across every run of a work item, oldest first; empty when the platform predates them. */
export async function fetchPendingMessages(target: AgentLogTarget, workItem: { table: string; recordId: string }): Promise<PendingMessage[]> {
  try {
    const res = await request<{ messages?: PendingMessage[] }>(
      target, 'GET', `/workspaces/${target.workspaceId}/agents/log/pending-messages?workItem=${encodeURIComponent(`${workItem.table}:${workItem.recordId}`)}`,
    );
    return Array.isArray(res.messages) ? res.messages : [];
  } catch { return []; }
}

/** Workspace member id → display name, for framing a note with its author. Empty when the list cannot be read. */
export async function memberNames(target: AgentLogTarget): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const rows = await request<Array<{ id: string; name?: string | null; email?: string | null }>>(target, 'GET', `/workspaces/${target.workspaceId}/members`);
    for (const m of Array.isArray(rows) ? rows : []) {
      const n = m.name || m.email;
      if (n) names.set(m.id, n);
    }
  } catch { /* the note is still delivered, attributed to "the operator" */ }
  return names;
}

/** The one line an operator note takes in the agent's turn. The authority sentence travels with it so no persona edit is needed. */
export function frameNote(m: Pick<PendingMessage, 'text'>, author: string | undefined): string {
  return `Note from ${author ?? 'the operator'} (operator): ${m.text}`;
}

/**
 * The "Operator notes since the last run" section of a brief (CREW-3118), or '' when there are none.
 * Names and timestamps are included; the standing instruction about authority and acknowledgment is
 * here because this section, like a live note, reaches every persona without editing each one.
 */
export function operatorNotesSection(notes: PendingMessage[], names: Map<string, string>): string {
  if (notes.length === 0) return '';
  const lines = notes.map((m) => {
    const who = (m.authorId && names.get(m.authorId)) || 'the operator';
    return `- ${m.occurredAt ?? 'earlier'} — ${who}: ${m.text.replace(/\n/g, '\n  ')}`;
  });
  return [
    '## Operator notes since the last run',
    '',
    'A person responsible for this work left these notes while no run could read them. They carry the operator\'s authority, within the limits of your persona and the rules above; acknowledge them in your first text turn.',
    '',
    ...lines,
  ].join('\n');
}

/** The server's cap on one cycle's text (TABL-3105); the client trims first so a batch stays small. */
export const CYCLE_BODY_LIMIT_BYTES = 2048;
const CYCLE_TRUNCATION_MARKER = ' …[truncated]';
/** The server accepts at most this many cycles in one post. */
const MAX_CYCLES_PER_BATCH = 200;

/** Trims a cycle's text to the 2 KB body limit, on a character boundary, with a marker. Pure. */
export function capCycleText(text: string): string {
  if (Buffer.byteLength(text) <= CYCLE_BODY_LIMIT_BYTES) return text;
  const room = CYCLE_BODY_LIMIT_BYTES - Buffer.byteLength(CYCLE_TRUNCATION_MARKER);
  let out = text.slice(0, room);
  while (Buffer.byteLength(out) > room) out = out.slice(0, -1);
  return out + CYCLE_TRUNCATION_MARKER;
}

export interface LiveRunOptions {
  /** How often buffered cycles go up as one batch. Default 4 s (the 3-5 s window). */
  windowMs?: number;
  /** A heartbeat goes up when nothing else has been sent for this long. Default 30 s, inside the platform's 60 s cadence. */
  heartbeatMs?: number;
  /** Called after cycles are delivered with the running total, so a restart can resume where this left off. */
  onPosted?: (posted: number) => void;
  /**
   * CREW-3118: operator notes the platform returned on a batch or heartbeat response, each handed over once
   * (a note that stays `queued` until the callback marks it is not repeated). The callback owns marking it.
   */
  onMessages?: (messages: PendingMessage[]) => void | Promise<void>;
}

/**
 * Reports a started run while it happens (CREW-3116): batches the run's cycles into one post per
 * window, and sends a bare heartbeat PATCH when nothing else went out for a while, so the platform
 * keeps the row live and can tell a silent run from a working one.
 *
 * Best effort and self-disabling. A 404/4xx from a lifecycle endpoint means the platform predates
 * them: reporting stops for the rest of the run (detected once) and `posted` says how much the
 * end-of-run report must still send. A 5xx or a dropped request keeps the buffer for the next window.
 * Cycles are deduplicated by index, so a restarted daemon replaying the stream cannot re-send them.
 */
export class LiveRunReporter {
  /** Cycles delivered to the row, from the start of the run. */
  posted = 0;
  live = true;
  private nextIndex = 0;
  private readonly pending: AgentCycle[] = [];
  private readonly seenMessages = new Set<string>();
  private lastSent = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private readonly windowMs: number;
  private readonly heartbeatMs: number;

  private readonly target: AgentLogTarget;
  readonly rowId: string;
  private readonly o: LiveRunOptions;

  constructor(target: AgentLogTarget, rowId: string, o: LiveRunOptions = {}, alreadyPosted = 0) {
    this.target = target;
    this.rowId = rowId;
    this.o = o;
    this.windowMs = o.windowMs ?? 4000;
    this.heartbeatMs = o.heartbeatMs ?? 30_000;
    this.posted = alreadyPosted;
    this.nextIndex = alreadyPosted;
  }

  start(): void {
    if (this.timer || !this.live) return;
    this.timer = setInterval(() => { void this.tick(); }, this.windowMs);
    this.timer.unref?.();
  }

  /** Buffers one cycle for the next batch. A cycle already delivered or buffered is ignored. */
  add(c: AgentCycle): void {
    if (!this.live || c.cycleIndex < this.nextIndex) return;
    this.nextIndex = c.cycleIndex + 1;
    this.pending.push({ ...c, thinking: capCycleText(c.thinking) });
  }

  /** One window: send the buffered cycles, or a heartbeat when idle too long. Serialized. */
  tick(): Promise<void> {
    this.inFlight = this.inFlight.then(() => this.step());
    return this.inFlight;
  }

  /** Stops the timer and waits out a send in flight. What is still buffered is left to the end-of-run report. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  /** Passes the response's not-yet-seen notes to `onMessages`. A failing callback never disturbs reporting. */
  private async handOver(res: { pendingMessages?: PendingMessage[] } | undefined): Promise<void> {
    const fresh = (Array.isArray(res?.pendingMessages) ? res.pendingMessages : []).filter((m) => m && typeof m.id === 'string' && !this.seenMessages.has(m.id));
    if (fresh.length === 0 || !this.o.onMessages) return;
    for (const m of fresh) this.seenMessages.add(m.id);
    try { await this.o.onMessages(fresh); } catch { /* a note that was not marked stays queued and reaches the next run's brief */ }
  }

  private async step(): Promise<void> {
    if (!this.live) return;
    try {
      if (this.pending.length > 0) {
        const batch = this.pending.slice(0, MAX_CYCLES_PER_BATCH);
        const res = await post<{ pendingMessages?: PendingMessage[] } | undefined>(this.target, `/agents/log/${this.rowId}/cycles`, batch.map((c) => ({
          cycleIndex: c.cycleIndex, occurredAt: c.occurredAt, thinking: c.thinking, ...(c.role ? { role: c.role } : {}),
        })));
        this.pending.splice(0, batch.length);
        this.posted = batch[batch.length - 1]!.cycleIndex + 1;
        this.lastSent = Date.now();
        this.o.onPosted?.(this.posted);
        await this.handOver(res);
      } else if (Date.now() - this.lastSent >= this.heartbeatMs) {
        const res = await send<{ pendingMessages?: PendingMessage[] } | undefined>(this.target, 'PATCH', `/agents/log/${this.rowId}`, {});
        this.lastSent = Date.now();
        await this.handOver(res);
      }
    } catch (e) {
      // A 4xx (no such endpoint, a refusal) will not get better; a 5xx or no answer is tried again next window.
      if (e instanceof AgentLogHttpError && e.status < 500) {
        this.live = false;
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        this.pending.length = 0;
      }
    }
  }
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
    numTurns: run.numTurns,
    prefixTokens: run.prefixTokens,
    promptVersion: run.promptVersion,
    promptSha: run.promptSha,
  };
  // A server that predates the Run Id column rejects `runId` as unknown (a 400), so the
  // fallback post below drops it.
  const { runId, ...legacyBody } = { ...body, runId: run.runId };
  const workItem = target.tickets && ticketRecordId
    ? { workItemTable: target.tickets.issuesModelId, workItemRecordId: ticketRecordId }
    : {};
  let entry: { id: string } | undefined;
  if (run.rowId && (await updateStartedRow(target, run.rowId, finishedRowBody(run, workItem)))) entry = { id: run.rowId };
  if (!entry) {
    try {
      entry = await post<{ id: string }>(target, '/agents/log', { ...body, ...(runId ? { runId } : {}), ...workItem, harness: run.harness, provider: run.provider });
    } catch (e) {
      if (!(e instanceof AgentLogHttpError)) throw new AgentLogUnreachableError((e as Error).message);
      if (e.status >= 500) throw new AgentLogUnreachableError(e.message);
      // A server that predates the identity or work-item fields validates them
      // away as unknown properties with a 400; the run still deserves its row.
      if (e.status !== 400 || (!run.harness && !run.provider && !ticketRecordId && !runId)) { e.row = true; throw e; }
      try {
        entry = await post<{ id: string }>(target, '/agents/log', legacyBody);
      } catch (e2) {
        if (e2 instanceof AgentLogHttpError && e2.status < 500) e2.row = true;
        throw e2;
      }
    }
  }
  for (const cycle of run.cycles.slice(run.cyclesPosted ?? 0)) {
    await post(target, `/agents/log/${entry!.id}/cycles`, {
      cycleIndex: cycle.cycleIndex,
      occurredAt: cycle.occurredAt,
      thinking: cycle.thinking,
      ...(cycle.role ? { role: cycle.role } : {}),
    });
  }
  if (run.beforeFirstEdit) await writeBeforeFirstEdit(target, entry.id, run.beforeFirstEdit);
  if (target.tickets && ticketRecordId) {
    const bounces = await countAcceptanceBounces(target, target.tickets.issuesModelId, ticketRecordId);
    if (bounces !== null) await writeHandoffBounces(target, entry.id, bounces);
  }
  let counterWarning: string | undefined;
  let counted: AgentRunReport = run;
  if (runId && target.tickets && ticketRecordId) {
    // CREW-2980: the inference rows are the accounting under `auth: workspace`; sum them so each token counts once.
    try {
      const totals = await inferenceTotalsFor(target, runId);
      if (totals) counted = { ...run, tokensIn: totals.tokensIn, tokensOut: totals.tokensOut, cacheReadTokens: totals.cacheReadTokens, cacheWriteTokens: totals.cacheWriteTokens, costUsd: totals.costUsd };
      else counted = { ...run, ...run.harnessTotals };
    } catch (e) {
      counterWarning = `could not sum run ${runId}'s inference rows for ${run.ticketReference}: ${(e as Error).message}`;
    }
  }
  const counters = target.tickets && ticketRecordId
    ? await addRunToTicket(target, target.tickets, ticketRecordId, counted)
    : undefined;
  return {
    agentLogId: entry.id,
    ...(counters?.warning || counterWarning ? { counterWarning: [counterWarning, counters?.warning].filter(Boolean).join('; ') } : {}),
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

/**
 * The tracker, as the crew uses it.
 *
 * Replaces every `curl` in the bash runner with @tablation/client, which
 * already carries the bearer auth, the query serialisation and the error
 * shape. What stays here is crew-shaped: which statuses are open, how a
 * blocker counts as resolved, and the two writes the runner is allowed to
 * make on its own behalf.
 */

import { TablationClient } from '@tablation/client';
import type { Connection, Ship } from './config.ts';
import { ConfigError, resolveApiKey } from './config.ts';
import { DEFAULT_CONTRACT, resolveContract, type Contract } from './contract.ts';
import { acquireBoardLock as claimBoardLock, type BoardLockResult } from './board-lock.ts';

export interface Ticket {
  id: string;
  issue_id: string;
  /** The `Projects` row — the area of development this ticket belongs to. */
  project_id?: string | null;
  /**
   * The `Repos` row — which repository this ticket's work happens in.
   *
   * An area spans several repositories, so this is what decides the checkout:
   * without it a release looks for a branch in whichever directory the
   * connection happened to name, which is the wrong one for every repo but
   * the first.
   */
  repo_id?: string | null;
  title?: string | null;
  status: string;
  severity?: string | null;
  priority?: string | null;
  assignee_id?: string | null;
  needs_design?: boolean | null;
  blocked_by?: string[] | null;
  updated_at: string;
  /**
   * Whether this ticket's epic is already in progress (ISSUE-385) — computed
   * by `decideCycle` from `epicRows()`, not a column the API returns. Absent
   * on a workspace with no Epics table, which the ranker reads as "no epic".
   */
  epicInProgress?: boolean | null;
  [k: string]: unknown;
}

export interface Comment {
  id: string;
  ticket_id: string;
  body?: string | null;
  team_member_id?: string | null;
  reporter_name?: string | null;
  kind?: string | null;
  created_at: string;
}

export interface CrewRow {
  id: string;
  name?: string | null;
  email?: string | null;
  /** The `Ships` row this member runs on. */
  ship_id?: string | null;
}

/**
 * Kept as the DEFAULT workspace's sets, for callers that have no contract to
 * hand. Anything serving a real connection must use that connection's
 * contract instead — a ship follows each workspace's own rules.
 */
export const RESOLVED_STATUSES = new Set(DEFAULT_CONTRACT.statuses.resolved);

type Filter = { columnName: string; operator: string; value: unknown };
const encodeFilters = (f: Filter[]): string => JSON.stringify(f);

type Sort = { columnName: string; direction: 'asc' | 'desc' };
const encodeSort = (s: Sort[]): string => JSON.stringify(s);

/**
 * One tracker, for one connection. A ship holds several of these — one per
 * project it is connected to — which is why nothing here is ship-global.
 */
export class Tracker {
  // NB: explicit fields, not TypeScript parameter properties — node's
  // --experimental-strip-types cannot transform those, and the test runner
  // uses it. The same rule applies everywhere in src/.
  readonly conn: Connection;
  /** This workspace's rules. A ship holds several, one per connection. */
  readonly contract: Contract;
  private readonly client: TablationClient;
  private readonly models: { issues: string; comments: string; crew: string };

  constructor(conn: Connection, ship: Pick<Ship, 'userAgent'>) {
    this.conn = conn;
    if (!conn.resolved) {
      throw new ConfigError(
        `connection "${conn.name}" has no resolved ids — run \`crew connect\` to discover them from the project`,
      );
    }
    this.models = conn.resolved.models;
    this.contract = resolveContract(conn.contract);
    this.client = new TablationClient({
      baseUrl: `${conn.baseUrl}/api`,
      apiKey: resolveApiKey(conn),
      // Cloudflare 403s (error 1010) default agents on this host.
      headers: { 'User-Agent': ship.userAgent },
    } as ConstructorParameters<typeof TablationClient>[0]);
  }

  /**
   * Every non-terminal ticket for this connection's area, in one call.
   *
   * The area filter is what keeps two connections on one tracker out of each
   * other's queue: a ship working `synthesis` and `tablation-js` from the same
   * Issues project must not have either seat pick up the other's tickets. A
   * connection with no area sees everything, which is right for a tracker
   * nobody has sliced yet.
   */
  async openTickets(): Promise<Ticket[]> {
    const c = this.contract;
    const filters: Filter[] = [
      { columnName: c.columns.status, operator: 'IN', value: c.statuses.open },
    ];
    const areaId = this.conn.resolved?.areaId;
    if (areaId) filters.push({ columnName: c.columns.slice, operator: 'EQ', value: areaId });
    return this.client.records.list<Ticket>(this.models.issues, {
      filters: encodeFilters(filters),
      limit: 500,
    });
  }

  /**
   * Tickets at a terminal, no-longer-open status — the worktree sweep's
   * input (ISSUE-346).
   *
   * The exact complement of `openTickets()`: `closed_deployed`,
   * `closed_wont_fix`, `closed_duplicate`. `verified` is excluded even
   * though the contract counts it as resolved for a *blocker*'s purposes —
   * it is still pre-release, and its worktree is exactly what the release
   * phase is about to merge.
   *
   * Sorted most-recently-updated first: a board can hold far more than
   * `limit` closed tickets (this one already has), and an unordered fetch
   * has no guarantee which ones a truncated page contains. Ordering by
   * `updatedAt` descending means a truncated page still holds the tickets
   * most likely to need their worktree swept — the ones that closed most
   * recently — rather than an arbitrary, possibly stale slice (ISSUE-403).
   */
  async terminalTickets(): Promise<Ticket[]> {
    const c = this.contract;
    const statuses = c.statuses.resolved.filter((s) => s !== c.statuses.verified);
    if (!statuses.length) return [];
    const filters: Filter[] = [
      { columnName: c.columns.status, operator: 'IN', value: statuses },
    ];
    const areaId = this.conn.resolved?.areaId;
    if (areaId) filters.push({ columnName: c.columns.slice, operator: 'EQ', value: areaId });
    const params: { filters: string; limit: number; sort: string } = {
      filters: encodeFilters(filters),
      limit: 500,
      sort: encodeSort([{ columnName: c.columns.updatedAt, direction: 'desc' }]),
    };
    return this.client.records.list<Ticket>(this.models.issues, params);
  }

  /**
   * Tickets by id, for blockers that have already closed and so are absent
   * from the open set. Bounded to the ids actually referenced.
   */
  async ticketsByIds(ids: string[]): Promise<Ticket[]> {
    if (ids.length === 0) return [];
    return this.client.records.list<Ticket>(this.models.issues, {
      filters: encodeFilters([{ columnName: 'id', operator: 'IN', value: ids }]),
      limit: 500,
    });
  }

  async ticket(id: string): Promise<Ticket> {
    return this.client.records.get<Ticket>(this.models.issues, id);
  }

  async comments(limit = 500): Promise<Comment[]> {
    return this.client.records.list<Comment>(this.models.comments, { limit });
  }

  async crewRows(): Promise<CrewRow[]> {
    return this.client.records.list<CrewRow>(this.models.crew, { limit: 200 });
  }

  /**
   * The Ships rows of this workspace, if it has a Ships table.
   *
   * Optional by design: a workspace that has not adopted ships still works,
   * and the crew must not require a table it did not create.
   */
  async shipRows(): Promise<Array<{ id: string; name?: string | null; platform?: string | null }>> {
    const model = this.conn.resolved?.shipsModelId;
    if (!model) return [];
    try {
      return await this.client.records.list(model, { limit: 200 });
    } catch {
      return [];   // the table may be absent or unreadable; neither is fatal
    }
  }

  /**
   * The Epics rows of this workspace, if it has an Epics table (ISSUE-384).
   *
   * Optional by design, the same way `shipRows()` is: a workspace that has
   * not adopted epics still works, and the crew must not require a table it
   * did not create.
   */
  async epicRows(): Promise<Array<{ id: string; status?: string | null }>> {
    const model = this.conn.resolved?.epicsModelId;
    if (!model) return [];
    try {
      return await this.client.records.list(model, { limit: 500 });
    } catch {
      return [];   // the table may be absent or unreadable; neither is fatal
    }
  }

  /**
   * `expectedUpdatedAt` makes this a conditional write (ISSUE-395, the same
   * `RecordsResource.update` primitive board-lock.ts uses): pass the
   * `updated_at` this caller last read, and the write throws
   * `StaleWriteError` instead of applying if the row has moved since —
   * exactly what claim.ts needs to let a contended ticket claim fail loudly
   * rather than silently overwrite a winning ship's write.
   */
  async updateTicket(id: string, patch: Record<string, unknown>, expectedUpdatedAt?: string): Promise<Ticket> {
    return this.client.records.update<Ticket>(this.models.issues, id, patch, expectedUpdatedAt);
  }

  /**
   * Claim a board-visible lock for `scope` (ISSUE-394) — see board-lock.ts
   * for the CAS mechanics. Resolves to `{ ok: true }` immediately, with a
   * no-op release, when this workspace has no Locks table or no row
   * provisioned for `scope`: a connection that has not adopted board
   * locking keeps behaving exactly as it always has.
   */
  acquireBoardLock(scope: string, holderLabel: string, ttlMs: number): Promise<BoardLockResult> {
    return claimBoardLock(this.client.records, this.conn.resolved?.locksModelId, scope, holderLabel, ttlMs);
  }

  /**
   * Reports one crew member's live status (ISSUE-325) — "Working" for the
   * duration of an agent run, "Idle" once it ends.
   *
   * `ticketRecordId` is the ticket's own row id (`Ticket.id`), not its
   * `issue_id` label — the field it fills is a Reference, not text.
   * Omitted (as on the idle transition) leaves the column alone, so it
   * keeps reading as "current/last issue" rather than clearing to blank
   * the moment a run ends.
   */
  async setCrewStatus(
    memberId: string,
    status: 'working' | 'idle',
    ticketRecordId?: string | null,
  ): Promise<void> {
    const patch: Record<string, unknown> = { status, status_updated_at: new Date().toISOString() };
    if (ticketRecordId !== undefined) patch.current_issue_id = ticketRecordId;
    await this.client.records.update(this.models.crew, memberId, patch);
  }

  /**
   * An `event` comment — the runner's own audit trail, distinct from a
   * seat's prose. `kind` is what keeps these out of the "new comment from
   * someone else" wake signal.
   */
  async postEvent(ticketId: string, body: string, memberId: string): Promise<void> {
    await this.client.records.create(this.models.comments, {
      ticket_id: ticketId, body, team_member_id: memberId, kind: 'event',
    });
  }
}

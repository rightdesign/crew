/**
 * The tracker, as the crew uses it.
 *
 * Replaces every `curl` in the bash runner with @tablation/client, which
 * already carries the bearer auth, the query serialisation and the error
 * shape. What stays here is crew-shaped: which statuses are open, how a
 * blocker counts as resolved, and the two writes the runner is allowed to
 * make on its own behalf.
 */

import { hostname } from 'node:os';
import { TablationClient } from '@tablation/client';
import type { Route, Ship } from './config.ts';
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
   * route happened to name, which is the wrong one for every repo but
   * the first.
   */
  repo_id?: string | null;
  title?: string | null;
  status: string;
  severity?: string | null;
  priority?: string | null;
  assignee_id?: string | null;
  needs_design?: boolean | null;
  /** Human-only gate: a person still owes scoping before this ticket may be picked up or resumed. Set by a lane, cleared only by the operator. */
  needs_planning?: boolean | null;
  /** Human-only gate: a person still owes a review before an in_progress ticket carrying it is anyone's unfinished work to resume. Set by a lane, cleared only by the operator. */
  needs_review?: boolean | null;
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
  /** The linked Agents-table row (ISSUE-416's `agents.ts` `linkCrewSeats`), if synced. */
  agent_id?: string | null;
}

/**
 * A row of the `Ships` table (ISSUE-380). The heartbeat fields
 * (`last_seen` onward) are optional at the type level because a workspace
 * may still be on the two-column Ships table `doctor` already tolerated
 * before this ticket — reading one that hasn't adopted them yet must not
 * throw.
 */
export interface ShipRow {
  id: string;
  name?: string | null;
  platform?: string | null;
  last_seen?: string | null;
  engaged?: boolean | null;
  engaged_since?: string | null;
  engaged_connection?: string | null;
  engaged_ticket_id?: string | null;
  host?: string | null;
  pid?: number | null;
  host_passengers?: boolean | null;
  ssh_public_key?: string | null;
  tunnel_status?: string | null;
  mcp_url?: string | null;
}

/**
 * Kept as the DEFAULT workspace's sets, for callers that have no contract to
 * hand. Anything serving a real route must use that route's
 * contract instead — a ship follows each workspace's own rules.
 */
export const RESOLVED_STATUSES = new Set(DEFAULT_CONTRACT.statuses.resolved);

type Filter = { columnName: string; operator: string; value: unknown };
const encodeFilters = (f: Filter[]): string => JSON.stringify(f);

type Sort = { columnName: string; direction: 'asc' | 'desc' };
const encodeSort = (s: Sort[]): string => JSON.stringify(s);

/**
 * One tracker, for one route. A ship holds several of these — one per
 * project it is connected to — which is why nothing here is ship-global.
 */
export class Tracker {
  // NB: explicit fields, not TypeScript parameter properties — node's
  // --experimental-strip-types cannot transform those, and the test runner
  // uses it. The same rule applies everywhere in src/.
  readonly route: Route;
  /** This workspace's rules. A ship holds several, one per route. */
  readonly contract: Contract;
  private readonly client: TablationClient;
  private readonly models: { issues: string; comments: string; crew: string };
  private readonly userAgent: string;

  constructor(route: Route, ship: Pick<Ship, 'userAgent'>) {
    this.route = route;
    if (!route.resolved) {
      throw new ConfigError(
        `route "${route.route}" has no resolved ids — run \`crew connect\` to discover them from the project`,
      );
    }
    this.models = route.resolved.models;
    this.contract = resolveContract(route.contract);
    this.userAgent = ship.userAgent;
    this.client = new TablationClient({
      baseUrl: `${route.baseUrl}/api`,
      apiKey: resolveApiKey(route),
      // Cloudflare 403s (error 1010) default agents on this host.
      headers: { 'User-Agent': ship.userAgent },
    } as ConstructorParameters<typeof TablationClient>[0]);
  }

  /**
   * Every non-terminal ticket for this route's area, in one call.
   *
   * The area filter is what keeps two routes on one tracker out of each
   * other's queue: a ship working `synthesis` and `tablation-js` from the same
   * Issues project must not have either seat pick up the other's tickets. A
   * route with no area sees everything, which is right for a tracker
   * nobody has sliced yet.
   */
  async openTickets(): Promise<Ticket[]> {
    const c = this.contract;
    const filters: Filter[] = [
      { columnName: c.columns.status, operator: 'IN', value: c.statuses.open },
    ];
    const areaId = this.route.resolved?.areaId;
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
    const areaId = this.route.resolved?.areaId;
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
   * One row of the `Repos` table, for whatever it can tell the crew that
   * isn't in `.crew.yaml` — which `Projects` (area) row it belongs to, in
   * particular. `undefined` on a workspace with no Repos table, or if the
   * row is gone; neither is fatal to the caller.
   */
  async repoRow(id: string): Promise<{ id: string; project_id?: string | null } | undefined> {
    const model = this.route.resolved?.reposModelId;
    if (!model) return undefined;
    try {
      return await this.client.records.get<{ id: string; project_id?: string | null }>(model, id);
    } catch {
      return undefined;
    }
  }

  /**
   * One row of the `Projects` (area) table. `undefined` on a workspace
   * with no such table, or if the row is gone.
   */
  async projectRow(id: string): Promise<{ id: string; issue_prefix?: string | null } | undefined> {
    const model = this.route.resolved?.areaModelId;
    if (!model) return undefined;
    try {
      return await this.client.records.get<{ id: string; issue_prefix?: string | null }>(model, id);
    } catch {
      return undefined;
    }
  }

  /**
   * The Ships rows of this workspace, if it has a Ships table.
   *
   * Optional by design: a workspace that has not adopted ships still works,
   * and the crew must not require a table it did not create.
   */
  async shipRows(): Promise<ShipRow[]> {
    const model = this.route.resolved?.shipsModelId;
    if (!model) return [];
    try {
      return await this.client.records.list<ShipRow>(model, { limit: 200 });
    } catch {
      return [];   // the table may be absent or unreadable; neither is fatal
    }
  }

  /**
   * This ship's own row on the `Ships` table, matched by name — the same
   * exact-string match `doctor` has always used (see the callsign comment
   * on ISSUE-380: name is what an operator recognises on the board).
   * `undefined` when the workspace has no Ships table, no row named for
   * this ship, or more than one — ambiguous is not a row to write to.
   */
  private async myShipRow(shipName: string): Promise<ShipRow | undefined> {
    const rows = await this.shipRows();
    const mine = rows.filter((r) => (r.name ?? '').trim() === shipName.trim());
    return mine.length === 1 ? mine[0] : undefined;
  }

  /**
   * Ship-level heartbeat (ISSUE-380): "is this ship online" — independent
   * of any one seat's Working/Idle status (`setCrewStatus`), which only
   * exists for the duration of an actual agent run. This one fires once
   * per `crew run`/`poll` cycle **regardless of outcome**, including a
   * cycle that finds nothing to do, so a ship that stops firing (powered
   * off, asleep, closed for the weekend) simply stops updating `last_seen`
   * — silence then means exactly one thing, rather than being ambiguous
   * with "idle".
   *
   * Does not touch the `engaged*` columns — those are set only by
   * `beatEngaged`/`beatIdle`, paired around the part of the cycle that
   * actually spawns an agent, so a plain heartbeat mid-engagement can't
   * blow away `engaged_since`.
   *
   * A no-op, like `shipRows()`, on a workspace with no Ships table or no
   * row for this ship's name.
   */
  async beatShip(shipName: string): Promise<void> {
    const row = await this.myShipRow(shipName);
    if (!row) return;
    await this.client.records.update(this.route.resolved!.shipsModelId!, row.id, {
      last_seen: new Date().toISOString(),
      host: hostname(),
      pid: process.pid,
    });
  }

  /**
   * Marks this ship's row engaged, naming what it's working and since when
   * (ISSUE-380's "an engaged ship names what it is working and since
   * when"). Call once, right before `spawnAgent`, paired with
   * `beatIdle` in a `finally` — the same shape as `setCrewStatus`'s
   * working/idle pair, one level up (ship, not seat).
   */
  async beatEngaged(shipName: string, connectionName: string, ticketRecordId: string | null): Promise<void> {
    const row = await this.myShipRow(shipName);
    if (!row) return;
    await this.client.records.update(this.route.resolved!.shipsModelId!, row.id, {
      last_seen: new Date().toISOString(),
      host: hostname(),
      pid: process.pid,
      engaged: true,
      engaged_since: new Date().toISOString(),
      engaged_connection: connectionName,
      engaged_ticket_id: ticketRecordId,
    });
  }

  /**
   * Writes this ship's own tunnel state for Host Passengers (ISSUE-553):
   * `tunnel_status` (disconnected/connecting/connected) and `mcp_url`, as
   * the tunnel client (`tunnel.ts`) brings a workspace's container's tunnel
   * up or down. A no-op, like every other `myShipRow`-backed write here, on
   * a workspace with no Ships table or no row for this ship's name — the
   * tunnel client itself still runs the tunnel either way, it just has
   * nowhere on the board to report the state.
   */
  async updateTunnelState(
    shipName: string, patch: { tunnel_status: string; mcp_url?: string | null },
  ): Promise<void> {
    const row = await this.myShipRow(shipName);
    if (!row) return;
    await this.client.records.update(this.route.resolved!.shipsModelId!, row.id, patch);
  }

  /** The other half of `beatEngaged` — clears engagement back to idle. */
  async beatIdle(shipName: string): Promise<void> {
    const row = await this.myShipRow(shipName);
    if (!row) return;
    await this.client.records.update(this.route.resolved!.shipsModelId!, row.id, {
      last_seen: new Date().toISOString(),
      host: hostname(),
      pid: process.pid,
      engaged: false,
      engaged_since: null,
      engaged_connection: null,
      engaged_ticket_id: null,
    });
  }

  /**
   * The Epics rows of this workspace, if it has an Epics table (ISSUE-384).
   *
   * Optional by design, the same way `shipRows()` is: a workspace that has
   * not adopted epics still works, and the crew must not require a table it
   * did not create.
   */
  async epicRows(): Promise<Array<{ id: string; status?: string | null }>> {
    const model = this.route.resolved?.epicsModelId;
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
   * provisioned for `scope`: a route that has not adopted board
   * locking keeps behaving exactly as it always has.
   */
  acquireBoardLock(scope: string, holderLabel: string, ttlMs: number): Promise<BoardLockResult> {
    return claimBoardLock(this.client.records, this.route.resolved?.locksModelId, scope, holderLabel, ttlMs);
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

  /**
   * The public `/v/<slug>/r/<token>` link for one ticket (ISSUE-928) —
   * fetch-or-create via `POST /views/:viewId/record-links`, so a repeated
   * call for the same (view, model, record) returns the same URL and even
   * un-retires a retired one — right for a ticket that just went back to
   * `needs_info` after having been resolved once before.
   *
   * `undefined` when this route has no `recordLinkViewId` resolved, or the
   * mint call fails for any reason (network, 404, an unexpected response
   * shape) — the caller (poll.ts's attention sweep) still emits its
   * notification event without a link rather than losing the whole event.
   */
  async recordLinkUrl(recordId: string): Promise<string | undefined> {
    const viewId = this.route.resolved?.recordLinkViewId;
    if (!viewId) return undefined;
    try {
      const res = await fetch(`${this.route.baseUrl}/api/views/${viewId}/record-links`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resolveApiKey(this.route)}`,
          'User-Agent': this.userAgent,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ dataModelId: this.models.issues, recordId }),
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { url?: unknown };
      return typeof body.url === 'string' ? body.url : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * File a brand new ticket. Unlike every other write on this class, the
   * field names are the fixed Bug Reports schema (`title`, `description`,
   * `report_type`, `severity`, `reporter_name`) rather than anything in
   * `Contract.columns` — that contract only names the lifecycle fields a
   * workspace can rename, and creation-only fields like `description` are
   * not among them (`postEvent` above hardcodes its own fields the same
   * way).
   */
  async fileTicket(fields: Record<string, unknown>): Promise<Ticket> {
    return this.client.records.create<Ticket>(this.models.issues, fields);
  }
}

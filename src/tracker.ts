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
import { DEFAULT_CONTRACT, closedStatuses, resolveContract, type Contract } from './contract.ts';
import type { EpicRow } from './epics.ts';
import type { ClaimAffinity } from './claim.ts';
import { openShipAttention, type ShipAttentionItem } from './ship-attention.ts';
import { State } from './state.ts';
import { acquireBoardLock as claimBoardLock, lockRowState, type BoardLockResult, type LockRowState } from './board-lock.ts';

export interface Ticket {
  id: string;
  issue_id: string;
  /**
   * The per-project ticket key (`TABL-123`), where the workspace has one
   * (ISSUE-969's Issue Tag) — `contract.columns.tag`'s value on this row.
   * Optional at the type level for the same reason `epicInProgress` is: a
   * workspace that predates the field, or has not adopted it, simply never
   * sets it, and every caller already treats "absent" as "no tag".
   */
  issue_tag?: string | null;
  /**
   * The tag's own prefix, as the workspace cases it (`CREW`, `TABL`) — sits
   * beside `issue_tag` on the same row rather than being re-derived by
   * splitting it, since a prefix could in principle contain its own dash.
   * Every use lowercases it (a branch/worktree name is lowercase by
   * convention here), so this is left in whatever case the tracker sends.
   */
  project_issue_prefix?: string | null;
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

/**
 * A ticket's own `{prefix, tag}` for branch/worktree naming (ISSUE-969) —
 * `{}` when the ticket carries no tag (an older ticket, or a workspace that
 * has not adopted the Issue Tag field), which `effectiveBranchTemplate`/
 * `effectiveWorktreePrefix` already read as "use the plain issue-{number}
 * convention", so callers need no separate fallback branch of their own.
 */
export function ticketBranchContext(t: Ticket): { tag?: string; prefix?: string } {
  const tag = t.issue_tag ?? undefined;
  if (!tag) return {};
  const prefix = t.project_issue_prefix ? t.project_issue_prefix.toLowerCase() : undefined;
  return { tag, prefix };
}

/**
 * What to print for a ticket when a human is reading it (ISSUE-969) — the
 * per-project `TABL-123`/`CREW-969` tag where the workspace has adopted one,
 * falling back to the plain `issue_id` (`ISSUE-123`) otherwise. Purely a
 * display convenience: never use this for a lookup or a match, both of
 * which stay keyed on `issue_id` (see `ContractColumns.tag`'s own doc for
 * why `key` and `tag` must not be conflated).
 */
export function displayKey(t: Ticket): string {
  return t.issue_tag ?? t.issue_id;
}

/**
 * Every name a commit might legitimately use for this ticket (ISSUE-969) —
 * its canonical `issue_id` plus its `issue_tag`, when it has one. A commit
 * or squash-merge subject can end up naming either: crew's own generated
 * subjects still say `issue_id`, but a human-authored branch/commit now
 * follows the tag convention, so anything that searches git history for a
 * ticket reference (`findKeyOnBase`, `detectClosure`, `stamp.ts`'s own
 * regex, `planMerge`'s never-built/already-merged check) needs to try both
 * or it will call landed work "never built" just because it shipped under
 * its tag instead of its key.
 */
export function referenceKeys(t: Ticket): string[] {
  return t.issue_tag && t.issue_tag !== t.issue_id ? [t.issue_id, t.issue_tag] : [t.issue_id];
}

export interface Comment {
  id: string;
  ticket_id: string;
  body?: string | null;
  team_member_id?: string | null;
  /**
   * The identity the server stamped on the row (CREW-1304). A comment posted
   * from the app's own UI carries this and NOT `team_member_id` — only crew
   * seats set that column — so this is the one authorship signal a person's
   * reply reliably has. Joined to a Crew row through `Crew.user_id`.
   */
  created_by_id?: string | null;
  /** The `Ships` row the comment was posted from (CREW-1371); absent on older rows. */
  ship_id?: string | null;
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
  /**
   * The workspace Users row this member signs in as (CREW-1304). Users row
   * ids are identity ids — the same value every record's `created_by_id`
   * carries — so this is how a UI-posted comment is traced back to a crew
   * member. Null for an agent seat (it posts with `team_member_id` set) and
   * for a person whose row was never linked.
   */
  user_id?: string | null;
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
  /**
   * This ship's open attention items (CREW-1373). The column is optional on
   * the board: a workspace that has not taken the template update returns
   * rows with no `attention` key at all, and that absence is the probe.
   */
  attention?: ShipAttentionItem[] | null;
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
/**
 * Which of the optional authorship columns (CREW-1371) this workspace's
 * tables carry, and this ship's own `Ships` row id. A column a table does not
 * have is simply not written: the install has not taken the `crew.issues`
 * template update yet, and `crew doctor` says so rather than a write failing.
 */
export interface Authorship {
  /** Issues has the `contract.columns.author` column (`filed_by_id`). */
  issueAuthor: boolean;
  /** Issues has the `contract.columns.ship` column (`ship_id`). */
  issueShip: boolean;
  /** Issues has the `contract.columns.heldBy` column (`held_by_ship_id`). */
  issueHeld: boolean;
  /** Comments has the `contract.comments.ship` column (`ship_id`). */
  commentShip: boolean;
  /** This ship's `Ships` row id; null when there is no row for this ship's name. */
  shipId: string | null;
}

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
  private readonly shipName: string | undefined;
  /**
   * The once-per-process authorship probe (CREW-1371), memoised as a promise
   * so concurrent first writes share one round of field-metadata reads.
   */
  private authorship?: Promise<Authorship>;
  private readonly stateDir: string | undefined;

  constructor(route: Route, ship: Pick<Ship, 'userAgent'> & Partial<Pick<Ship, 'name' | 'stateDir'>>) {
    this.route = route;
    if (!route.resolved) {
      throw new ConfigError(
        `route "${route.route}" has no resolved ids — run \`crew connect\` to discover them from the project`,
      );
    }
    this.models = route.resolved.models;
    this.contract = resolveContract(route.contract);
    this.userAgent = ship.userAgent;
    this.shipName = ship.name;
    this.stateDir = ship.stateDir;
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
    const statuses = closedStatuses(c);
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

  /** Every `Projects` (area) row — what `crew repos add` offers when a new Repos row needs one. */
  async projectRows(): Promise<Array<{ id: string; name?: string }>> {
    const model = this.route.resolved?.areaModelId;
    if (!model) return [];
    return this.client.records.list<{ id: string; name?: string }>(model, { limit: 200 });
  }

  /** Create a `Repos` row. Throws when the workspace has no Repos table. */
  async createRepoRow(fields: Record<string, unknown>): Promise<{ id: string }> {
    const model = this.route.resolved?.reposModelId;
    if (!model) throw new Error('this workspace has no Repos table');
    return this.client.records.create<{ id: string }>(model, fields);
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
   * The `attention` field of a Ships-row patch (CREW-1373): this ship's open
   * items, so every heartbeat carries the current set and a cleared item
   * disappears from the board on the next one. Empty when there is nothing
   * to write: no state directory to read, or a Ships table without the
   * column (probed by the key's absence from the row, the way `owner_id` is
   * skipped on an install that has not taken the template update).
   */
  private attentionPatch(row: ShipRow): { attention: ShipAttentionItem[] | null } | Record<string, never> {
    if (!this.stateDir || !('attention' in row)) return {};
    const items = openShipAttention(new State(this.stateDir));
    return { attention: items.length ? items : null };
  }

  /**
   * Writes this ship's attention items on their own, without touching
   * `last_seen` — for the daemon, which raises one between heartbeats and
   * should not wait for the next engaged/idle beat to show it. Skips the
   * write when the row already holds the same set.
   */
  async publishShipAttention(shipName: string): Promise<void> {
    const row = await this.myShipRow(shipName);
    if (!row) return;
    const patch = this.attentionPatch(row);
    if (!('attention' in patch)) return;
    if (JSON.stringify(patch.attention) === JSON.stringify(row.attention ?? null)) return;
    await this.client.records.update(this.route.resolved!.shipsModelId!, row.id, patch);
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
      ...this.attentionPatch(row),
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
      ...this.attentionPatch(row),
    });
  }

  /**
   * Writes this ship's own tunnel state for Host Passengers (ISSUE-553):
   * `tunnel_status` (disconnected/connecting/connected), as
   * the tunnel client (`tunnel.ts`) brings a workspace's container's tunnel
   * up or down. A no-op, like every other `myShipRow`-backed write here, on
   * a workspace with no Ships table or no row for this ship's name — the
   * tunnel client itself still runs the tunnel either way, it just has
   * nowhere on the board to report the state.
   */
  async updateTunnelState(
    shipName: string, patch: { tunnel_status: string },
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
      ...this.attentionPatch(row),
    });
  }

  /**
   * The Epics rows of this workspace, if it has an Epics table (ISSUE-384).
   *
   * Optional by design, the same way `shipRows()` is: a workspace that has
   * not adopted epics still works, and the crew must not require a table it
   * did not create.
   */
  async epicRows(): Promise<EpicRow[]> {
    const model = this.route.resolved?.epicsModelId;
    if (!model) return [];
    try {
      return await this.client.records.list<EpicRow>(model, { limit: 500 });
    } catch {
      return [];   // the table may be absent or unreadable; neither is fatal
    }
  }

  /**
   * The tickets of these epics that are closed (`closed: true`) or not
   * (`closed: false`), for the epic sync (CREW-1255).
   *
   * **Not area-filtered, unlike `openTickets()`**: an epic spans areas, so
   * whether it is finished can only be judged across all of them. Also not
   * limited to `statuses.open` — a status this contract has never heard of
   * (a pre-triage `draft`, say) is still a ticket that is not closed.
   *
   * Paged, because an epic's history is unbounded and a truncated page
   * would silently read as "nothing else outstanding".
   */
  async epicTickets(epicIds: string[], o: { closed: boolean }): Promise<Ticket[]> {
    if (epicIds.length === 0) return [];
    const c = this.contract;
    const statuses = closedStatuses(c);
    if (!statuses.length) return [];
    const filters = encodeFilters([
      { columnName: c.columns.epic, operator: 'IN', value: epicIds },
      { columnName: c.columns.status, operator: o.closed ? 'IN' : 'NOT_IN', value: statuses },
    ]);
    const pageSize = 500;
    const out: Ticket[] = [];
    for (let page = 0; page < 20; page++) {
      const rows = await this.client.records.list<Ticket>(this.models.issues, {
        filters, limit: pageSize, offset: page * pageSize,
      });
      out.push(...rows);
      if (rows.length < pageSize) break;
    }
    return out;
  }

  /** Conditional on `expectedUpdatedAt`, exactly as `updateTicket` is. */
  async updateEpic(id: string, patch: Record<string, unknown>, expectedUpdatedAt?: string): Promise<unknown> {
    const model = this.route.resolved?.epicsModelId;
    if (!model) throw new ConfigError(`route "${this.route.route}" has no Epics table`);
    return this.client.records.update(model, id, patch, expectedUpdatedAt);
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
   * no-op release, only when this workspace has no Locks table at all. A
   * Locks table with no row for `scope` is `{ ok: false, reason: 'missing' }`
   * (CREW-1384): `crew connect` provisions the row.
   */
  acquireBoardLock(scope: string, holderLabel: string, ttlMs: number): Promise<BoardLockResult> {
    return claimBoardLock(this.client.records, this.route.resolved?.locksModelId, scope, holderLabel, ttlMs);
  }

  /** The Locks row for `scope` — present? held by whom? Undefined when this workspace has no Locks table. */
  async lockState(scope: string): Promise<LockRowState | undefined> {
    const model = this.route.resolved?.locksModelId;
    return model ? lockRowState(this.client.records, model, scope) : undefined;
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
    const auth = await this.authorshipProbe();
    await this.client.records.create(this.models.comments, {
      ticket_id: ticketId, body, team_member_id: memberId, kind: 'event',
      ...(auth.commentShip && auth.shipId ? { [this.contract.comments.ship]: auth.shipId } : {}),
    });
  }

  /**
   * Ship affinity for a claim (CREW-1386): stamp this ship's Ships row on the
   * ticket in the claim's own write, in the `held_by_ship_id` column (not
   * `ship_id`, which means "filed from"). `undefined` — claim exactly as
   * before — when the Issues table has no hold column or this ship has no row.
   */
  async claimAffinity(): Promise<ClaimAffinity | undefined> {
    const auth = await this.authorshipProbe();
    if (!auth.issueHeld || !auth.shipId) return undefined;
    return {
      column: this.contract.columns.heldBy,
      shipId: auth.shipId,
    };
  }

  /**
   * Which of the optional review columns (`verified_sha`, `pr_ref`) the Issues
   * table carries. A table without them has not adopted the review hand-off:
   * the crew then pushes and moves the ticket without recording either.
   */
  async reviewColumns(): Promise<{ verifiedSha: boolean; prRef: boolean }> {
    const fields = await this.columnNames(this.models.issues);
    return {
      verifiedSha: fields.has(this.contract.columns.verifiedSha),
      prRef: fields.has(this.contract.columns.prRef),
    };
  }

  /**
   * The authorship probe (CREW-1371), read once per process: which optional
   * `filed_by_id`/`ship_id` columns exist on Issues and Comments, and this
   * ship's own Ships row id. Memoised as a promise so concurrent first writes
   * share one round of metadata reads. A table whose metadata cannot be read
   * reads as "column absent", the same way `connect.ts`'s `owner_id` probe does.
   */
  authorshipProbe(): Promise<Authorship> {
    this.authorship ??= this.probeAuthorship();
    return this.authorship;
  }

  private async probeAuthorship(): Promise<Authorship> {
    const [issueFields, commentFields, shipRow] = await Promise.all([
      this.columnNames(this.models.issues),
      this.columnNames(this.models.comments),
      // No name (a caller that only beats or patches, never stamps) means no row to find.
      this.shipName ? this.myShipRow(this.shipName) : Promise.resolve(undefined),
    ]);
    return {
      issueAuthor: issueFields.has(this.contract.columns.author),
      issueShip: issueFields.has(this.contract.columns.ship),
      issueHeld: issueFields.has(this.contract.columns.heldBy),
      commentShip: commentFields.has(this.contract.comments.ship),
      shipId: shipRow?.id ?? null,
    };
  }

  private async columnNames(modelId: string): Promise<Set<string>> {
    try {
      const model = await this.client.dataModels.get(modelId);
      return new Set(model.fields.map((f) => f.columnName));
    } catch {
      return new Set();
    }
  }

  /**
   * The authorship columns this workspace is missing, as `table.column` names
   * for `crew doctor` to report (CREW-1371). Empty on a fully updated install.
   */
  async missingAuthorshipColumns(): Promise<string[]> {
    const auth = await this.authorshipProbe();
    const missing: string[] = [];
    if (!auth.issueAuthor) missing.push(`Issues.${this.contract.columns.author}`);
    if (!auth.issueShip) missing.push(`Issues.${this.contract.columns.ship}`);
    if (!auth.issueHeld) missing.push(`Issues.${this.contract.columns.heldBy}`);
    if (!auth.commentShip) missing.push(`Comments.${this.contract.comments.ship}`);
    return missing;
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
  async fileTicket(fields: Record<string, unknown>, memberId: string): Promise<Ticket> {
    const auth = await this.authorshipProbe();
    // Stamped after the caller's own fields, so the filer is never whatever a
    // caller happened to put in `fields` (CREW-1371: authorship is the seat
    // and ship this process runs as, not something a field list asserts).
    return this.client.records.create<Ticket>(this.models.issues, {
      ...fields,
      ...(auth.issueAuthor && memberId ? { [this.contract.columns.author]: memberId } : {}),
      ...(auth.issueShip && auth.shipId ? { [this.contract.columns.ship]: auth.shipId } : {}),
    });
  }
}

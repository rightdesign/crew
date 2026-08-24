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

export interface Ticket {
  id: string;
  issue_id: string;
  /** The `Projects` row — the area of development this ticket belongs to. */
  project_id?: string | null;
  title?: string | null;
  status: string;
  severity?: string | null;
  priority?: string | null;
  assignee_id?: string | null;
  needs_design?: boolean | null;
  blocked_by?: string[] | null;
  updated_at: string;
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

  async updateTicket(id: string, patch: Record<string, unknown>): Promise<Ticket> {
    return this.client.records.update<Ticket>(this.models.issues, id, patch);
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

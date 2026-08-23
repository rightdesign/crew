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
import type { CrewConfig } from './config.ts';
import { resolveApiKey } from './config.ts';

export interface Ticket {
  id: string;
  issue_id: string;
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
}

/**
 * A blocker stops counting at these. NOT `fixed`: that is an unmerged branch
 * awaiting QA, so a ticket blocked on it is still genuinely blocked.
 */
export const RESOLVED_STATUSES = new Set([
  'verified', 'closed_deployed', 'closed_wont_fix', 'closed_duplicate',
]);

/** Everything the poll considers live. Mirrors OPEN_TICKETS_FILTER in bash. */
export const OPEN_STATUSES = [
  'new', 'accepted', 'blocked', 'in_progress', 'needs_info', 'fixed', 'qa', 'verified',
];

type Filter = { columnName: string; operator: string; value: unknown };
const encodeFilters = (f: Filter[]): string => JSON.stringify(f);

export class Tracker {
  private readonly client: TablationClient;
  constructor(private readonly cfg: CrewConfig) {
    this.client = new TablationClient({
      baseUrl: `${cfg.tracker.baseUrl}/api`,
      apiKey: resolveApiKey(cfg),
      // Cloudflare 403s (error 1010) default agents on this host.
      headers: { 'User-Agent': cfg.tracker.userAgent },
    } as ConstructorParameters<typeof TablationClient>[0]);
  }

  /** Every non-terminal ticket, in one call. */
  async openTickets(): Promise<Ticket[]> {
    return this.client.records.list<Ticket>(this.cfg.tracker.models.issues, {
      filters: encodeFilters([{ columnName: 'status', operator: 'IN', value: OPEN_STATUSES }]),
      limit: 500,
    });
  }

  /**
   * Tickets by id, for blockers that have already closed and so are absent
   * from the open set. Bounded to the ids actually referenced.
   */
  async ticketsByIds(ids: string[]): Promise<Ticket[]> {
    if (ids.length === 0) return [];
    return this.client.records.list<Ticket>(this.cfg.tracker.models.issues, {
      filters: encodeFilters([{ columnName: 'id', operator: 'IN', value: ids }]),
      limit: 500,
    });
  }

  async ticket(id: string): Promise<Ticket> {
    return this.client.records.get<Ticket>(this.cfg.tracker.models.issues, id);
  }

  async comments(limit = 500): Promise<Comment[]> {
    return this.client.records.list<Comment>(this.cfg.tracker.models.comments, { limit });
  }

  async crewRows(): Promise<CrewRow[]> {
    return this.client.records.list<CrewRow>(this.cfg.tracker.models.crew, { limit: 200 });
  }

  async updateTicket(id: string, patch: Record<string, unknown>): Promise<Ticket> {
    return this.client.records.update<Ticket>(this.cfg.tracker.models.issues, id, patch);
  }

  /**
   * An `event` comment — the runner's own audit trail, distinct from a
   * seat's prose. `kind` is what keeps these out of the "new comment from
   * someone else" wake signal.
   */
  async postEvent(ticketId: string, body: string, memberId: string): Promise<void> {
    await this.client.records.create(this.cfg.tracker.models.comments, {
      ticket_id: ticketId, body, team_member_id: memberId, kind: 'event',
    });
  }
}

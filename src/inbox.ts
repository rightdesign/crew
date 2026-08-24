/**
 * `crew inbox` — one view of your own tickets, across every workspace.
 *
 * Tablation deliberately does not consolidate across workspaces, and that is
 * the right call for a product. But an operator running a crew against N
 * boards has no way to see their own queue, and the crew already holds the
 * one thing that makes a consolidated view possible: a connection per
 * workspace, each with its own contract.
 *
 * The crew normally *discards* these tickets — a ticket assigned to a person
 * is a hold, and no seat may touch it. This inverts that filter: exactly the
 * tickets the crew ignores are the ones a human wants to see.
 *
 * Read-only. It schedules nothing and writes nothing.
 */

import type { Connection, Ship } from './config.ts';
import { configuredMembers } from './config.ts';
import { Tracker, type Ticket } from './tracker.ts';
import { buildRoster, crewLabel, type Roster } from './roster.ts';
import { rankScalar, effectivePriority } from './priority.ts';
import type { Contract } from './contract.ts';

export interface InboxItem {
  connection: string;
  ticket: Ticket;
  assignee: string | null;
  /**
   * Comparable ACROSS workspaces: the contract turns each board's own
   * priority values into an index, so 0 is "most urgent here" everywhere.
   * Two boards that name their priorities differently still sort together.
   */
  rank: number;
  effective: number;
  contract: Contract;
}

export interface InboxOptions {
  /**
   * Whose tickets. Defaults to each connection's own operator — the same row
   * the crew treats as a hold.
   */
  memberIds?: Set<string>;
  /**
   * Who to look up, per connection, against that workspace's Crew table.
   *
   * **An email is an identity; a name is not.** Each workspace has its own
   * Crew table with its own rows, so matching `"chris"` across two boards can
   * resolve to two different people and look entirely plausible. An address
   * containing `@` is therefore matched EXACTLY against `email`, which is the
   * only cross-workspace identifier a Crew row currently carries.
   *
   * A name is still accepted, because it is what a human reaches for — but it
   * is a per-workspace label, and `gatherInbox` reports when one resolved to
   * different names on different boards so the ambiguity is visible rather
   * than silent.
   *
   * The durable answer is a platform-level identity on the row rather than a
   * convention; see ISSUE-270 (Workspace Users system table).
   */
  memberQuery?: string;
  /** Include tickets at terminal statuses. Off by default. */
  includeClosed?: boolean;
  /** Only these statuses, if given. */
  statuses?: Set<string>;
}

export interface MemberMatch { id: string; name: string; email: string; by: 'email' | 'name' }

/**
 * An address matches `email` exactly; anything else is a case-insensitive
 * substring of `name`. The distinction matters: only the first is an identity.
 */
export function matchMembers(
  rows: Array<{ id: string; name?: string | null; email?: string | null }>, query: string,
): MemberMatch[] {
  const q = query.trim().toLowerCase();
  const asEmail = q.includes('@');
  return rows
    .filter((r) => (asEmail
      ? (r.email ?? '').toLowerCase() === q
      : (r.name ?? '').toLowerCase().includes(q)))
    .map((r) => ({ id: r.id, name: r.name ?? '', email: r.email ?? '', by: asEmail ? 'email' as const : 'name' as const }));
}

export interface InboxResult {
  items: InboxItem[];
  errors: Array<{ connection: string; error: string }>;
  /** Per connection, who the query resolved to — or that it matched nobody. */
  resolved: Array<{ connection: string; names: string[]; emails: string[]; by: 'email' | 'name' | null }>;
  /**
   * True when a NAME query resolved to different people on different boards.
   * The queue shown is then a mixture, which is exactly the failure a name
   * lookup can produce and an email lookup cannot.
   */
  ambiguous: boolean;
}

export async function gatherInbox(
  connections: Connection[], ship: Ship, opts: InboxOptions = {},
): Promise<InboxResult> {
  const items: InboxItem[] = [];
  const errors: Array<{ connection: string; error: string }> = [];
  const resolved: InboxResult['resolved'] = [];

  // Connections are independent; one unreachable tracker must not hide the
  // rest, which is the whole point of a consolidated view.
  await Promise.all(connections.map(async (conn) => {
    try {
      const tracker = new Tracker(conn, ship);
      const [tickets, crewRows] = await Promise.all([tracker.openTickets(), tracker.crewRows()]);
      const roster: Roster = buildRoster(configuredMembers(conn), crewRows);
      let mine: Set<string>;
      if (opts.memberQuery) {
        const hits = matchMembers(crewRows, opts.memberQuery);
        resolved.push({
          connection: conn.name,
          names: hits.map((h) => h.name),
          emails: hits.map((h) => h.email).filter(Boolean),
          by: hits[0]?.by ?? null,
        });
        mine = new Set(hits.map((h) => h.id));
      } else {
        mine = opts.memberIds ?? new Set([conn.resolved?.operator].filter(Boolean) as string[]);
      }
      const c = tracker.contract;

      for (const t of tickets) {
        if (!t.assignee_id || !mine.has(t.assignee_id)) continue;
        if (opts.statuses && !opts.statuses.has(t.status)) continue;
        if (!opts.includeClosed && c.statuses.resolved.includes(t.status)) continue;
        items.push({
          connection: conn.name,
          ticket: t,
          assignee: crewLabel(roster.get(t.assignee_id)),
          rank: rankScalar(t, c),
          effective: effectivePriority(t, c),
          contract: c,
        });
      }
    } catch (e) {
      errors.push({ connection: conn.name, error: (e as Error).message });
    }
  }));

  items.sort((a, b) => a.rank - b.rank);
  // Only a NAME lookup can disagree between boards; an email is exact.
  const byName = resolved.filter((r) => r.by === 'name' && r.names.length);
  const distinct = new Set(byName.flatMap((r) => r.names));
  const ambiguous = byName.length > 1 && distinct.size > 1;
  return { items, errors, resolved, ambiguous };
}

/** Grouped by status, most urgent first within each — the shape of a to-do list. */
export function renderInbox(items: InboxItem[], byConnection = false, subject?: string): string {
  // "nothing assigned to you" while looking at a colleague's queue is exactly
  // the misreading this view has to avoid.
  if (items.length === 0) return `nothing assigned to ${subject ?? 'you'}\n`;
  const key = (i: InboxItem) => (byConnection ? i.connection : i.ticket.status);
  const groups = new Map<string, InboxItem[]>();
  for (const i of items) {
    const g = groups.get(key(i));
    if (g) g.push(i);
    else groups.set(key(i), [i]);
  }
  const out: string[] = [];
  for (const [name, group] of groups) {
    out.push(`${name}  (${group.length})`);
    for (const i of group) {
      const t = i.ticket;
      const where = byConnection ? t.status : i.connection;
      out.push(
        `  ${t.issue_id.padEnd(10)} p${i.effective} ${(t.severity ?? '--').padEnd(3)} ` +
          `${where.padEnd(14)} ${(t.title ?? '').slice(0, 62)}`,
      );
    }
    out.push('');
  }
  return out.join('\n');
}

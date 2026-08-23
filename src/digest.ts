/**
 * The queue digest — the agent's queue, rendered by the poll that woke it.
 *
 * Ported from lib/queue-digest.jq and lib/queue-digest-qa.jq. Two shapes,
 * because a building role's queue has three sections while QA's is one list
 * keyed on which role built the ticket and whether its worktree survives.
 *
 * The digest exists to stop the agent re-fetching the whole tracker at the
 * top of every run: that was ~691 KB of JSON per run, ~275 KB of it case
 * history for tickets the run would never touch. So it deliberately carries
 * NO prose — no description, repro_steps or resolution_note. The agent
 * fetches the full record of the one ticket it actually picks up.
 */

import { compareRank, effectivePriority, type Rankable } from './priority.ts';
import { crewLabel, isHold, type Roster } from './roster.ts';

export interface DigestTicket extends Rankable {
  id: string;
  issue_id: string;
  status: string;
  assignee_id?: string | null;
  needs_design?: boolean | null;
  blocked_by?: string[] | null;
  updated_at: string;
}

export interface DigestComment {
  ticket_id: string;
  team_member_id?: string | null;
  reporter_name?: string | null;
  kind?: string | null;
  created_at: string;
}

export interface DigestInput {
  tickets: DigestTicket[];
  comments: DigestComment[];
  /** The running seat's Crew row id — what "you" means in every column. */
  me: string;
  roster: Roster;
  watermark: string;
  /** Local branch names, for QA's "is there still a worktree to test?" column. */
  branches: string[];
  /** Ticket ids the poll computed as dependency-blocked (ISSUE-187). */
  blocked: Set<string>;
  /** {ticketId: {issue_id, status}} for every blocker named, closed ones included. */
  blockerInfo: Record<string, { issue_id?: string; status?: string }>;
}

/**
 * Authorship comes from team_member_id, never reporter_name: a comment
 * carries the *ticket's* reporter name, so an agent's own note can read as
 * whoever filed the ticket. Getting this backwards would make the loop treat
 * its own notes as a reply from someone else.
 */
function author(c: DigestComment, me: string, roster: Roster): string {
  if (c.team_member_id === me) return 'you';
  if (c.team_member_id === null || c.team_member_id === undefined) {
    return `${c.reporter_name ?? 'anon'} (no identity)`;
  }
  return crewLabel(roster.get(c.team_member_id)) ?? 'someone off this ship';
}

function lastComment(i: DigestInput, ticketId: string): string {
  const forTicket = i.comments
    .filter((c) => c.ticket_id === ticketId)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  const last = forTicket[forTicket.length - 1];
  if (!last) return '—';
  return `${last.created_at.slice(0, 16)}Z ${author(last, i.me, i.roster)}`;
}

/** Comments from someone other than the running seat since the poll watermark. */
function newFromOthers(i: DigestInput, ticketId: string): number {
  return i.comments.filter(
    (c) =>
      c.ticket_id === ticketId &&
      c.team_member_id !== i.me &&
      c.created_at > i.watermark &&
      (c.kind ?? 'comment') !== 'event',
  ).length;
}

/**
 * A hold is marked rather than merely named: a person is driving that ticket
 * right now, and the label is what stops the agent acting on one that is
 * still listed below.
 */
function who(t: DigestTicket, i: DigestInput): string {
  if (!t.assignee_id) return 'unassigned';
  if (t.assignee_id === i.me) return 'you';
  const label = crewLabel(i.roster.get(t.assignee_id));
  if (label === null) return 'someone off this ship';
  return isHold(i.roster, t.assignee_id) ? `**${label} — HOLD**` : label;
}

/** Every blocker this ticket names, with the status that decides whether it counts. */
function blockers(t: DigestTicket, i: DigestInput): string {
  const list = (t.blocked_by ?? []).map((id) => {
    const info = i.blockerInfo[id];
    return `${info?.issue_id ?? '?'} (${info?.status ?? 'unknown'})`;
  });
  return list.length === 0 ? '—' : list.join(', ');
}

const sorted = (ts: DigestTicket[]) => [...ts].sort(compareRank);

/**
 * The jq programs emit a comma-separated stream, and `jq -r` puts each value
 * on its own line. Joining the segments with a newline (and terminating the
 * last) is what reproduces that spacing exactly — without it every section
 * heading loses a blank line.
 */
const stream = (segments: string[]) => `${segments.join('\n')}\n`;

function table(ts: DigestTicket[], i: DigestInput, header: string, row: (t: DigestTicket) => string): string {
  if (ts.length === 0) return '\n_None._\n';
  return `\n${header}\n${sorted(ts).map(row).join('\n')}\n`;
}

/** The digest for a building role — dev or design. */
export function buildingDigest(i: DigestInput): string {
  const header =
    '| ticket | status | assignee | sev | pri | eff | updated | last comment | new since last poll |\n' +
    '|---|---|---|---|---|---|---|---|---|';
  const row = (t: DigestTicket) => {
    const n = newFromOthers(i, t.id);
    return `| ${t.issue_id} | ${t.status} | ${who(t, i)} | ${t.severity ?? '—'} | ${t.priority ?? '—'} | p${effectivePriority(t)} | ${t.updated_at.slice(0, 16)}Z | ${lastComment(i, t.id)} | ${n > 0 ? `**${n} new**` : '—'} |`;
  };
  const blockedRow = (t: DigestTicket) =>
    `| ${t.issue_id} | ${t.status} | ${who(t, i)} | p${effectivePriority(t)} | ${blockers(t, i)} |`;
  const blockedTable = (ts: DigestTicket[]) =>
    ts.length === 0
      ? '\n_None._\n'
      : `\n| ticket | status | assignee | eff | blocked by |\n|---|---|---|---|---|\n${sorted(ts).map(blockedRow).join('\n')}\n`;

  const isBlocked = (t: DigestTicket) => i.blocked.has(t.id);
  const step1 = i.tickets.filter(
    (t) =>
      (t.status === 'in_progress' && (t.assignee_id === i.me || !t.assignee_id)) ||
      t.status === 'needs_info',
  );
  const step2 = i.tickets.filter(
    (t) => (t.status === 'accepted' || t.status === 'blocked') && !isBlocked(t),
  );

  return stream([
    '## Current queue — built for you by the poll\n',
    '\nAlready filtered to your lane, and already ordered by the Step 2 rule.\nTicket bodies are deliberately omitted: fetch the full record of only the\nticket you actually pick up. **Do not re-fetch the whole tracker.** This\ndigest comes from the same API call the poll just made, moments ago.\n',
    '\n"new since last poll" counts comments from someone other than you since\nthe poll watermark — the same signal that woke this run.\n',
    '\n### Step 1 — open tickets that may be yours to act on\n',
    '\n`fixed` tickets are deliberately absent: they belong to the QA lane.\n',
    table(step1, i, header, row),
    '\n### Step 2 — accepted tickets, in pick order\n',
    '\nWork the first one you are not required to skip. Tickets waiting on an\nunresolved dependency are already out of this table — see Blocked below.\n',
    table(step2, i, header, row),
    '\n### Blocked — waiting on a dependency, not yours to start\n',
    '\nListed rather than hidden so "nothing to do" stays distinguishable from\n"everything is parked". The loop parks and restores these itself, on every\npoll: an approved ticket whose `Blocked by` entries are unresolved moves to\n`blocked`, and back to `accepted` once the last one resolves. **Do not pick\none up, do not set or clear `blocked` by hand, and do not "unblock" one by\nediting its `Blocked by` field** — if a blocker looks wrong, say so in your\nrun summary. A blocker counts as resolved at `verified`, `closed_deployed`,\n`closed_wont_fix` or `closed_duplicate`; `fixed` is still an unmerged branch\nawaiting QA, so it does not count.\n',
    blockedTable(i.tickets.filter(isBlocked)),
  ]);
}

/** The digest for the QA role. */
export function qaDigest(i: DigestInput): string {
  const header =
    '| ticket | status | built by | assignee | sev | pri | eff | branch | updated | last comment | new since last poll |\n' +
    '|---|---|---|---|---|---|---|---|---|---|---|';
  /** No branch means no worktree to test. */
  const hasBranch = (t: DigestTicket) =>
    i.branches.map((b) => `ISSUE-${b.replace(/^issue-/, '')}`).includes(t.issue_id ?? '')
      ? 'yes'
      : '**MISSING**';
  const builtBy = (t: DigestTicket) => (t.needs_design === true ? 'design' : 'dev');
  const row = (t: DigestTicket) => {
    const n = newFromOthers(i, t.id);
    return `| ${t.issue_id} | ${t.status} | ${builtBy(t)} | ${who(t, i)} | ${t.severity ?? '—'} | ${t.priority ?? '—'} | p${effectivePriority(t)} | ${hasBranch(t)} | ${t.updated_at.slice(0, 16)}Z | ${lastComment(i, t.id)} | ${n > 0 ? `**${n} new**` : '—'} |`;
  };
  return stream([
    '## Current queue — built for you by the poll\n',
    '\nAlready filtered to your lane: every ticket at `qa` ("Verification" —\nyours, unfinished) or `fixed` (nobody has checked it yet), from both\nbuilding lanes. Ticket bodies are deliberately omitted: fetch the full\nrecord and the comments of the one ticket you actually pick up. **Do not\nre-fetch the whole tracker.** This digest comes from the same API call the\npoll just made, moments ago.\n',
    '\n"new since last poll" counts comments from someone other than you since\nthe poll watermark — the same signal that woke this run.\n',
    '\n### Still in verification — yours, unfinished (take these first)\n',
    table(i.tickets.filter((t) => t.status === 'qa'), i, header, row),
    '\n### Awaiting verification, in pick order\n',
    table(i.tickets.filter((t) => t.status === 'fixed'), i, header, row),
  ]);
}

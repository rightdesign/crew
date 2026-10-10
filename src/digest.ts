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

import { modeOf, type WorkModes } from './work-mode.ts';
import { compareRank, effectivePriority, type Rankable } from './priority.ts';
import { crewLabel, isHold, memberByIdentity, type Roster } from './roster.ts';

export interface DigestTicket extends Rankable {
  id: string;
  issue_id: string;
  issue_tag?: string | null;
  status: string;
  assignee_id?: string | null;
  /** The Projects row, for the work-mode column (CREW-1495). */
  project_id?: string | null;
  needs_design?: boolean | null;
  blocked_by?: string[] | null;
  repo_id?: string | null;
  /** The Crew row that filed the ticket (CREW-1371's `filed_by_id`). */
  filed_by_id?: string | null;
  /** The Ships row it was filed from (CREW-1371's `ship_id`). */
  ship_id?: string | null;
  /** The Ships row holding the ticket (CREW-1386's `held_by_ship_id`). */
  held_by_ship_id?: string | null;
  /** Server-stamped identity, for tickets filed in the UI (CREW-1304). */
  created_by_id?: string | null;
  /** Free text; never read as authorship except as a marked last resort. */
  reporter_name?: string | null;
  updated_at: string;
}

export interface DigestComment {
  ticket_id: string;
  team_member_id?: string | null;
  /** Server-stamped author identity; the only authorship a UI-posted comment has (CREW-1304). */
  created_by_id?: string | null;
  /** The Ships row the comment was posted from (CREW-1371). */
  ship_id?: string | null;
  reporter_name?: string | null;
  kind?: string | null;
  created_at: string;
}

export interface DigestInput {
  /**
   * How this repo names branches, rendered per ticket by the crew.
   *
   * The crew cannot create the worktree itself: it does not know which ticket
   * the agent will take. The agent applies Step 1/Step 2 judgment and may
   * skip every one — a design run did exactly that, judging its only
   * candidate unbuildable and creating nothing.
   *
   * So the crew renders the NAME rather than describing the pattern, and the
   * agent copies it. A template in prose is something an agent can mistype;
   * a rendered name is not.
   */
  branchFor?: (t: DigestTicket) => string;
  /**
   * Where this ticket's worktree belongs, rendered by the crew the same way
   * `branchFor` renders the branch name (ISSUE-1028).
   *
   * Without this the agent had only `branchFor` and had to derive the
   * worktree directory itself from the Environment section's own worked
   * example — which is rendered before any ticket is picked, so it cannot
   * carry this ticket's real project prefix and can quietly disagree with
   * the branch name actually handed to the agent. Rendering the name here,
   * per ticket, removes the derivation step the same way `branchFor` already
   * does for the branch itself.
   */
  worktreeFor?: (t: DigestTicket) => string;
  /**
   * Where this ticket's work happens on this machine.
   *
   * An area spans several repos, so the checkout is a property of the TICKET,
   * not of the route. A ticket whose repo this ship has no checkout for
   * is marked, because working it in the wrong directory is worse than
   * skipping it.
   */
  dirFor?: (t: DigestTicket) => string | null;
  /**
   * Why this ticket's repo is stopped on this ship (CREW-1403), or null. A
   * stopped repo's tickets are out of the building lanes' Step 2 table and
   * named under "Held repos" with the reason, rather than disappearing.
   */
  repoStop?: (t: DigestTicket) => string | null;
  /**
   * Work modes (CREW-1445, CREW-1493). The caller has already dropped the
   * tickets the mode excludes from `tickets`; this drives the note that tells
   * the lane why a project's accepted tickets are absent. It also lets ticket
   * rows be labelled with their project's mode (CREW-1495).
   */
  workModes?: WorkModes;
  tickets: DigestTicket[];
  comments: DigestComment[];
  /** The running seat's Crew row id — what "you" means in every column. */
  me: string;
  roster: Roster;
  /** The workspace's Ships rows, for naming the ship a comment came from (CREW-1371). */
  ships?: { id: string; name?: string | null }[];
  /** This ship's own Ships row id, or null when it has none; its comments carry no suffix. */
  myShipId?: string | null;
  watermark: string;
  /**
   * The branch this ticket's work is actually on, or null when none exists.
   *
   * QA's "is there still a worktree to test?" column. Per ticket rather than
   * one flat list of the route directory's branches: an area spans
   * several repos (ISSUE-331), and a branch in the second one is invisible
   * from the first. The single-repo version reported every cross-repo
   * ticket as having no branch, which QA reads as nothing to verify
   * against (ISSUE-349).
   */
  existingBranchFor?: (t: DigestTicket) => string | null;
  /** Ticket ids the poll computed as dependency-blocked (ISSUE-187). */
  blocked: Set<string>;
  /** {ticketId: {issue_id, issue_tag, status}} for every blocker named, closed ones included. */
  blockerInfo: Record<string, { issue_id?: string; issue_tag?: string | null; status?: string }>;
}

/**
 * What to print for a ticket when a human reads the digest (ISSUE-969) — the
 * per-project tag (`TABL-123`) where the workspace has adopted one, falling
 * back to the plain `issue_id` (`ISSUE-123`) otherwise. Display only: every
 * lookup in this file (the `me`/`assignee_id` comparisons, `blockerInfo`
 * keys) stays keyed on `id`/`issue_id`, never this.
 */
function displayKey(t: { issue_id?: string; issue_tag?: string | null }): string {
  return t.issue_tag ?? t.issue_id ?? '?';
}

/**
 * Authorship comes from team_member_id, never reporter_name: a comment
 * carries the *ticket's* reporter name, so an agent's own note can read as
 * whoever filed the ticket. Getting this backwards would make the loop treat
 * its own notes as a reply from someone else.
 */
function author(c: DigestComment, i: DigestInput): string {
  const { me, roster } = i;
  if (c.team_member_id === me) return 'you';
  if (c.team_member_id === null || c.team_member_id === undefined) {
    // CREW-1304: a comment posted from the app's UI never sets
    // team_member_id — only crew seats do — but the server stamps who
    // posted it. Trace that identity to a Crew row's user_id, so the
    // operator's own answer on a ticket is not printed as anonymous (it
    // was, on TABL-1289, and the dev seat rightly refused to act on it).
    const byIdentity = memberByIdentity(roster, c.created_by_id);
    if (byIdentity) return byIdentity.id === me ? 'you' : (crewLabel(byIdentity) ?? byIdentity.name);
    return `${c.reporter_name ?? 'anon'} (no identity)`;
  }
  return (crewLabel(roster.get(c.team_member_id)) ?? 'someone off this ship') + shipSuffix(c, i);
}

/**
 * CREW-1371: a seat's comment posted from another ship says which ship, so two
 * ships under one API key are not read as the same author. Our own ship and
 * a comment with no `ship_id` (written before the column existed) get nothing.
 */
function shipSuffix(c: DigestComment, i: DigestInput): string {
  if (!c.ship_id || c.ship_id === i.myShipId) return '';
  const name = i.ships?.find((s) => s.id === c.ship_id)?.name;
  return name ? ` (${name})` : '';
}

/**
 * CREW-1371 D7: who filed a ticket. The seat a crew writer stamped
 * (`filed_by_id`) comes first, then the server-stamped identity of a UI-filed
 * ticket (`created_by_id`, via Crew.user_id), and only last the ticket's own
 * free-text `reporter_name`, marked unverified: that field is whoever the
 * form said, not who filed it (ISSUE-1370 carried the operator's identity
 * with a ship's alert).
 */
function filedBy(t: DigestTicket, i: DigestInput): string {
  const member = (t.filed_by_id ? i.roster.get(t.filed_by_id) : undefined) ?? memberByIdentity(i.roster, t.created_by_id);
  if (member) {
    if (member.id === i.me) return 'you';
    const label = crewLabel(member) ?? member.name;
    const ship = t.ship_id && t.ship_id !== i.myShipId ? i.ships?.find((s) => s.id === t.ship_id)?.name : undefined;
    return ship ? `${label} (${ship})` : label;
  }
  return t.reporter_name ? `${t.reporter_name} (unverified)` : '—';
}

function lastComment(i: DigestInput, ticketId: string): string {
  const forTicket = i.comments
    .filter((c) => c.ticket_id === ticketId)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  const last = forTicket[forTicket.length - 1];
  if (!last) return '—';
  return `${last.created_at.slice(0, 16)}Z ${author(last, i)}`;
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
  return whoAssigned(t, i) + heldBySuffix(t, i);
}

/**
 * CREW-1389: name the ship holding a ticket, by its Ships row name and never
 * the bare uuid. Nothing for a ticket this ship holds itself, or one nobody
 * holds. An id matching no Ships row says so rather than printing the id.
 */
function heldBySuffix(t: DigestTicket, i: DigestInput): string {
  if (!t.held_by_ship_id || t.held_by_ship_id === i.myShipId) return '';
  const name = i.ships?.find((s) => s.id === t.held_by_ship_id)?.name?.trim();
  return ` (held by ${name || 'an unknown ship'})`;
}

function whoAssigned(t: DigestTicket, i: DigestInput): string {
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
    return `${info ? displayKey(info) : '?'} (${info?.status ?? 'unknown'})`;
  });
  return list.length === 0 ? '—' : list.join(', ');
}

/** The ticket's project work mode (CREW-1495), or `—` when the digest was built without modes. */
function modeCell(t: DigestTicket, i: DigestInput): string {
  return i.workModes && i.workModes.modes.size > 0 ? modeOf(t, i.workModes) : '—';
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
    '| ticket | repo | branch | worktree | mode | status | assignee | filed by | sev | pri | eff | updated | last comment | new since last poll |\n' +
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const row = (t: DigestTicket) => {
    const n = newFromOthers(i, t.id);
    const branch = i.branchFor ? i.branchFor(t) : '';
    const worktree = i.worktreeFor ? i.worktreeFor(t) : '';
    const dir = i.dirFor ? i.dirFor(t) : null;
    const repo = i.dirFor ? (dir ?? '**NO CHECKOUT**') : '';
    return `| ${displayKey(t)} | ${repo} | ${branch} | ${worktree} | ${modeCell(t, i)} | ${t.status} | ${who(t, i)} | ${filedBy(t, i)} | ${t.severity ?? '—'} | ${t.priority ?? '—'} | p${effectivePriority(t)} | ${t.updated_at.slice(0, 16)}Z | ${lastComment(i, t.id)} | ${n > 0 ? `**${n} new**` : '—'} |`;
  };
  const blockedRow = (t: DigestTicket) =>
    `| ${displayKey(t)} | ${t.status} | ${who(t, i)} | p${effectivePriority(t)} | ${blockers(t, i)} |`;
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
  const stopOf = (t: DigestTicket) => (i.repoStop ? i.repoStop(t) : null);
  const step2 = i.tickets.filter(
    (t) => (t.status === 'accepted' || t.status === 'blocked') && !isBlocked(t) && stopOf(t) === null,
  );
  const held = i.tickets.filter((t) => (t.status === 'accepted' || t.status === 'blocked') && !isBlocked(t) && stopOf(t) !== null);
  const heldTable = held.length === 0 ? '' : `\n### Held repos — this ship cannot start these right now\n\nNot yours to start this run: the ship's checkout of their repo is stopped. It\nresumes by itself once the checkout is level; no one needs to change the ticket.\n\n| ticket | why |\n|---|---|\n${sorted(held).map((t) => `| ${displayKey(t)} | ${stopOf(t)} |`).join('\n')}\n`;

  return stream([
    '## Current queue — built for you by the poll\n',
    '\nAlready filtered to your lane, and already ordered by the Step 2 rule.\nTicket bodies are deliberately omitted: fetch the full record of only the\nticket you actually pick up. **Do not re-fetch the whole tracker.** This\ndigest comes from the same API call the poll just made, moments ago.\n',
    '\n"new since last poll" counts comments from someone other than you since\nthe poll watermark — the same signal that woke this run.\n',
    '\n**`repo` is the checkout a ticket\'s work happens in** — an area spans\nseveral repositories, so cut the worktree beside THAT directory, not beside\nwhichever one you started in. A ticket marked **NO CHECKOUT** is not yours:\nthis ship has no clone of its repository, and another ship may serve it.\n\n**Use the `branch` and `worktree` columns verbatim.** They are that\nrepository\'s own naming convention, rendered for THIS ticket — cut the\nworktree at `<repo>/../<worktree>`, on branch `<branch>`. Do not derive\neither yourself, and prefer these over the Environment section\'s own worked\nexample if the two ever disagree — that example is illustrative only,\nrendered before any ticket is picked.\n',
    ...(i.workModes && [...i.workModes.modes.values()].some((m) => m !== 'automatic')
      ? ['\n**Manual / hybrid projects.** Some projects on this board are not fully automatic. In a `manual` project no lane touches any ticket, and a ticket with no project is treated the same way, so none appear below. In a `hybrid` project a ticket appears below only when it is assigned to an agent. An `accepted` ticket that is absent for either reason is not yours to claim — do not go looking for it.\n']
      : []),
    '\n### Step 1 — open tickets that may be yours to act on\n',
    '\n`fixed` tickets are deliberately absent: they belong to the QA lane.\n',
    table(step1, i, header, row),
    '\n### Step 2 — accepted tickets, in pick order\n',
    '\nWork the first one you are not required to skip. Tickets waiting on an\nunresolved dependency are already out of this table — see Blocked below.\n',
    table(step2, i, header, row),
    '\n### Blocked — waiting on a dependency, not yours to start\n',
    '\nListed rather than hidden so "nothing to do" stays distinguishable from\n"everything is parked". The loop parks and restores these itself, on every\npoll: an approved ticket whose `Blocked by` entries are unresolved moves to\n`blocked`, and back to `accepted` once the last one resolves. **Do not pick\none up, do not set or clear `blocked` by hand, and do not "unblock" one by\nediting its `Blocked by` field** — if a blocker looks wrong, say so in your\nrun summary. A blocker counts as resolved at `verified`, `closed_deployed`,\n`closed_wont_fix` or `closed_duplicate`; `fixed` is still an unmerged branch\nawaiting QA, so it does not count.\n',
    blockedTable(i.tickets.filter(isBlocked)),
    ...(heldTable ? [heldTable] : []),
  ]);
}

/** The digest for the QA role. */
export function qaDigest(i: DigestInput): string {
  const header =
    '| ticket | repo | mode | status | built by | assignee | filed by | sev | pri | eff | branch | worktree | updated | last comment | new since last poll |\n' +
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  /**
   * The branch to verify, or a mark that there is none.
   *
   * Looked up in the ticket's OWN repository — see `existingBranchFor`. A
   * ticket this ship has no checkout for gets neither: there is nowhere to
   * look, and reporting `MISSING` there would say the branch is gone when
   * the truth is that nobody here can see it.
   */
  const branchCell = (t: DigestTicket) => {
    if (i.dirFor && i.dirFor(t) === null) return '—';
    if (!i.existingBranchFor) return '';
    return i.existingBranchFor(t) ?? '**MISSING**';
  };
  /**
   * Where that branch's worktree should be, rendered the same way as the
   * dev/design digest (ISSUE-1028) — not existence-checked the way
   * `branchCell` is, since crew finds a worktree by scanning for its branch
   * rather than by this constructed name; this is a sanity check for the
   * agent, not the lookup itself.
   */
  const worktreeCell = (t: DigestTicket) => {
    if (i.dirFor && i.dirFor(t) === null) return '—';
    return i.worktreeFor ? i.worktreeFor(t) : '';
  };
  const builtBy = (t: DigestTicket) => (t.needs_design === true ? 'design' : 'dev');
  const row = (t: DigestTicket) => {
    const n = newFromOthers(i, t.id);
    const dir = i.dirFor ? i.dirFor(t) : null;
    const repo = i.dirFor ? (dir ?? '**NO CHECKOUT**') : '';
    return `| ${displayKey(t)} | ${repo} | ${modeCell(t, i)} | ${t.status} | ${builtBy(t)} | ${who(t, i)} | ${filedBy(t, i)} | ${t.severity ?? '—'} | ${t.priority ?? '—'} | p${effectivePriority(t)} | ${branchCell(t)} | ${worktreeCell(t)} | ${t.updated_at.slice(0, 16)}Z | ${lastComment(i, t.id)} | ${n > 0 ? `**${n} new**` : '—'} |`;
  };
  const waiting = i.tickets.filter((t) => (t.status === 'qa' || t.status === 'fixed') && i.blocked.has(t.id));
  const takeable = (status: string) => i.tickets.filter((t) => t.status === status && !i.blocked.has(t.id));
  const waitingTable = waiting.length === 0
    ? ''
    : `\n### Waiting on blockers — not yours to verify yet\n\nA \`fixed\` or \`qa\` ticket whose \`Blocked by\` names something not yet resolved\n(\`verified\`, \`closed_deployed\`, \`closed_wont_fix\` or \`closed_duplicate\`) is held out of\nverification: its change needs the blocker released first. It becomes yours on\nthe first poll after the last blocker resolves. No one needs to change the ticket.\n\n| ticket | status | blocked by |\n|---|---|---|\n${waiting.map((t) => `| ${displayKey(t)} | ${t.status} | ${blockers(t, i)} |`).join('\n')}\n`;
  return stream([
    '## Current queue — built for you by the poll\n',
    '\nAlready filtered to your lane: every ticket at `qa` ("Verification" —\nyours, unfinished) or `fixed` (nobody has checked it yet), from both\nbuilding lanes. Ticket bodies are deliberately omitted: fetch the full\nrecord and the comments of the one ticket you actually pick up. **Do not\nre-fetch the whole tracker.** This digest comes from the same API call the\npoll just made, moments ago.\n',
    '\n"new since last poll" counts comments from someone other than you since\nthe poll watermark — the same signal that woke this run.\n',
    '\n**`repo` is the checkout the ticket\'s work happens in** — an area spans\nseveral repositories, so the worktree you verify in sits beside THAT\ndirectory, not beside whichever one this session started in. A ticket\nmarked **NO CHECKOUT** is not yours: this ship has no clone of its\nrepository, and another ship may serve it.\n\n**`branch` is that repository\'s own branch for the ticket**, found there\nrather than derived. **`<name> (on origin only)`** means another ship built it\nand pushed it: it is testable — cut a worktree from the remote branch\n(`git worktree add <worktree> <name>`). **MISSING** means the branch is gone\nlocally AND on the remote, so there is nothing left to verify — say so on the ticket. A `—` means the branch\ncould not be looked for at all, because the repo has no checkout here.\n\n**`worktree` is where that branch should be checked out**, `<repo>/../<worktree>`\n— rendered the same way the dev/design digest computes it, so you land in\nthe same directory the building lane used.\n',
    '\n### Still in verification — yours, unfinished (take these first)\n',
    table(takeable('qa'), i, header, row),
    '\n### Awaiting verification, in pick order\n',
    table(takeable('fixed'), i, header, row),
    ...(waitingTable ? [waitingTable] : []),
  ]);
}

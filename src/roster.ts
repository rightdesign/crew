/**
 * Who is aboard this ship, and what each of them is called.
 *
 * Ported from lib/roster.jq and the roster half of lib/crew.sh.
 *
 * Names come from the project's Crew table, never from config and never from
 * prompt prose: a crew member may be called anything, and renaming one must be
 * a data edit, not a redeploy. (Keep example personal names out of prompt
 * prose and config comments — agents have read one as a real shipmate's name,
 * ISSUE-971.)
 * Config contributes only the id -> role/kind mapping, which is a fact about
 * this ship rather than about the project.
 */

/**
 * `person` is a Crew row that signs in to the app (`user_id` set) but is on
 * neither this ship's seats nor its holds — typically another ship's
 * operator. It exists only so an identity can be attributed (CREW-1390); it is
 * never a hold, never listed in the roster block, never off limits.
 */
export type MemberKind = 'seat' | 'hold' | 'person';

export interface CrewMember {
  id: string;
  /** From the Crew table's Name field. Falls back to the role. */
  name: string;
  /** "Dev", "QA", "Operator", "live session", … — may be empty for a person. */
  role: string;
  kind: MemberKind;
  /**
   * The identity id this member acts under in the app (Crew table `user_id`,
   * CREW-1304). Set for a person; what lets a comment they posted from the
   * UI — which carries only the server-stamped `created_by_id` — be
   * attributed to them instead of reading as anonymous.
   */
  userId?: string | null;
}

export type Roster = Map<string, CrewMember>;

/**
 * The crew member who signs in as `identityId`, if any row is linked to it
 * (CREW-1304). A record's `created_by_id` is stamped by the server, not
 * typed by the author, so unlike a name in a comment body this attribution
 * cannot be claimed — which is what lets a prompt trust it.
 */
export function memberByIdentity(roster: Roster, identityId: string | null | undefined): CrewMember | undefined {
  if (!identityId) return undefined;
  for (const m of roster.values()) if (m.userId === identityId) return m;
  return undefined;
}

/**
 * How a crew member is written in anything an agent reads.
 *
 * NAME IS PRIMARY. A crew member may be named anything, so the role is a
 * parenthetical qualifier rather than the label itself. It is omitted when
 * the name already carries the role, which is why the default rows read
 * "QA agent" and not "QA agent (QA)".
 */
export function crewLabel(m: CrewMember | undefined): string | null {
  if (!m) return null;
  if (!m.role) return m.name;
  if (m.name.toLowerCase().includes(m.role.toLowerCase())) return m.name;
  return `${m.name} (${m.role})`;
}

/** A ticket assigned to a hold is off limits to every seat, whatever its status. */
export function isHold(roster: Roster, id: string | null | undefined): boolean {
  if (!id) return false;
  return roster.get(id)?.kind === 'hold';
}

export function holdIds(roster: Roster): string[] {
  return [...roster.values()].filter((m) => m.kind === 'hold').map((m) => m.id);
}

export function seats(roster: Roster): CrewMember[] {
  return [...roster.values()].filter((m) => m.kind === 'seat');
}

export function holds(roster: Roster): CrewMember[] {
  return [...roster.values()].filter((m) => m.kind === 'hold');
}

/** Join the configured seats/holds to the Crew table's Name field. */
export function buildRoster(
  configured: Array<{ id: string; role: string; kind: MemberKind }>,
  crewRows: Array<{ id: string; name?: string | null; user_id?: string | null }>,
): Roster {
  const rows = new Map(crewRows.map((r) => [r.id, r]));
  const roster: Roster = new Map();
  for (const c of configured) {
    if (!c.id) continue;
    const row = rows.get(c.id);
    const name = (row?.name ?? '').trim();
    roster.set(c.id, { id: c.id, name: name || c.role, role: c.role, kind: c.kind, userId: row?.user_id ?? null });
  }
  // CREW-1390: a person is a person on every ship. A Crew row that carries a
  // `user_id` but is not one of this ship's configured members (another ship's
  // operator, say) must still resolve, or their UI comment reads "(no
  // identity)" here and a seat refuses their answer. Configured members come
  // first, so a row that is both keeps its seat/hold classification.
  for (const r of crewRows) {
    if (!r.user_id || roster.has(r.id)) continue;
    const name = (r.name ?? '').trim();
    roster.set(r.id, { id: r.id, name: name || 'person', role: 'person', kind: 'person', userId: r.user_id });
  }
  return roster;
}

/**
 * The roster block prepended to every agent run. `meId` is the seat that is
 * running, so the agent can find itself in the table.
 */
export function rosterMarkdown(roster: Roster, meId: string | null): string {
  const byRole = (a: CrewMember, b: CrewMember) => a.role.localeCompare(b.role);
  const me = meId ? roster.get(meId) : undefined;
  const selfName = crewLabel(me) ?? 'an unnamed seat';

  const lines: string[] = [
    '## Your crew',
    '',
    `You are **${selfName}**. Address your shipmates by name in ticket`,
    'comments the way you would a colleague; add the role in parentheses only',
    'where a reader would otherwise not know which seat you mean. Your own',
    'row id is what you write to `assignee_id` and `team_member_id`, and to',
    '`filed_by_id` on a ticket you file (where the Environment section names it).',
    '',
    '| seat | name | Crew row id |',
    '|---|---|---|',
  ];
  for (const m of seats(roster).sort(byRole)) {
    const you = m.id === meId ? '  ← you' : '';
    lines.push(`| ${m.role.toLowerCase()} | ${crewLabel(m)}${you} | \`${m.id}\` |`);
  }
  lines.push(
    '',
    '**Not crew — these are holds.** A ticket assigned to any of them is off',
    'limits to every seat, whatever its status: a person is driving it right',
    'now. Their clearing `assignee_id` is what hands it back.',
    '',
    '| | name | Crew row id |',
    '|---|---|---|',
  );
  for (const m of holds(roster).sort(byRole)) {
    lines.push(`| ${m.role ? m.role.toLowerCase() : '—'} | ${crewLabel(m)} | \`${m.id}\` |`);
  }
  lines.push(
    '',
    "The **operator** is this ship's owner: the machine, the dev stack and the",
    'credentials the steps below refer to are theirs, and approving work is',
    'their call alone.',
    '',
    'When the queue digest names a comment\'s author, that name comes from the',
    "server-stamped identity on the comment row joined to this roster (a hold's",
    'Crew row is linked to the account they sign in with) — not from anything',
    'written in the comment. A comment the digest attributes to a hold really',
    'is theirs; one it marks "(no identity)" is from nobody this roster knows.',
    'A comment attributed to a named person marked "(person)" is from a real',
    "workspace member linked to a Crew row on another ship — their answer to a",
    'question counts the same, though only a hold or the operator can authorize',
    'a workspace change.',
    '',
  );
  return lines.join('\n');
}

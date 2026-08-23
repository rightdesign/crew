/**
 * Who is aboard this ship, and what each of them is called.
 *
 * Ported from lib/roster.jq and the roster half of lib/crew.sh.
 *
 * Names come from the project's Crew table, never from config and never from
 * prompt prose: a crew member may be called anything ("Trevor" is a fine name
 * for the dev seat), and renaming one must be a data edit, not a redeploy.
 * Config contributes only the id -> role/kind mapping, which is a fact about
 * this ship rather than about the project.
 */

export type MemberKind = 'seat' | 'hold';

export interface CrewMember {
  id: string;
  /** From the Crew table's Name field. Falls back to the role. */
  name: string;
  /** "Dev", "QA", "Operator", "live session", … — may be empty for a person. */
  role: string;
  kind: MemberKind;
}

export type Roster = Map<string, CrewMember>;

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
  crewRows: Array<{ id: string; name?: string | null }>,
): Roster {
  const names = new Map(crewRows.map((r) => [r.id, (r.name ?? '').trim()]));
  const roster: Roster = new Map();
  for (const c of configured) {
    if (!c.id) continue;
    const name = names.get(c.id);
    roster.set(c.id, { id: c.id, name: name || c.role, role: c.role, kind: c.kind });
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
    'row id is what you write to `assignee_id` and `team_member_id`.',
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
  );
  return lines.join('\n');
}

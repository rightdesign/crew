/**
 * `crew connect` — discovery half.
 *
 * A route needs fourteen uuids. Every one of them is discoverable by
 * name, and writing them out by hand is the friction ISSUE-285 exists to
 * remove. This does the READ-ONLY part of that ticket: resolve names to ids
 * and print a route block ready to paste into crew.yaml.
 *
 * What it deliberately does NOT do, because both need the keychain work in
 * ISSUE-283 that does not exist yet:
 *   - mint a workspace API key (keys are workspace-scoped; there is no
 *     platform key, so one must already exist and be supplied);
 *   - provision the Crew rows for roles the workspace lacks.
 *
 * So this is a paste-ready draft, not the finished command. It is honest
 * about the difference rather than pretending to be `crew connect`.
 */

import { DEFAULT_CONTRACT } from './contract.ts';

export interface AuthOptions {
  baseUrl: string;
  apiKey: string;
  userAgent?: string;
}

export interface DiscoverOptions extends AuthOptions {
  /** A slug or a uuid — `GET /workspaces/:idOrSlug` accepts either. */
  workspace: string;
  /** A slug, a uuid, or a name (matched case-insensitively) — omit to have
   * every project with the tables a route needs offered as a choice. */
  project?: string;
  area?: string;
}

/** One workspace this key's identity can see, whichever workspace minted it. */
export interface WorkspaceOption {
  slug: string;
  name: string;
  role: string;
}

/** One project this workspace holds, whether or not it qualifies. */
export interface ProjectOption {
  id: string;
  name: string;
  slug?: string;
  /** Missing tables, from what a route needs — `[]` means it qualifies. */
  missing: string[];
}

/** One status CHOICE option DEFAULT_CONTRACT's own status names don't cover. */
export interface UnrecognizedStatus {
  value: string;
  label?: string;
  position?: number;
}

export interface Discovered {
  workspaceId: string;
  /** The canonical slug, whatever form (slug/uuid) `workspace` was given in. */
  workspaceSlug: string;
  workspaceName?: string;
  /** This key's own role in the workspace — `/auth/me` — for the
   * no-qualifying-project message: an admin can install a template, a plain
   * member cannot. */
  role?: string;
  /** This key's own identity, from the same `/auth/me` call as `role` — used
   * to auto-match `operator` against a Crew row's email; not otherwise
   * rendered or written anywhere. */
  meEmail?: string;
  projectId?: string;
  /** The canonical slug, when the resolved project has one — building the
   * `route:` string (`workspaceSlug/projectSlug`) needs this, not the
   * display name. */
  projectSlug?: string;
  projectName?: string;
  models: Record<string, string>;
  /**
   * Status CHOICE values this project's Issues table defines that
   * DEFAULT_CONTRACT's own status names don't cover (ISSUE-467) — e.g. a
   * workspace-added terminal status like `closed_escalated`, which used to
   * require hand-editing `contract.statuses.resolved` in the resolved state
   * file to be recognised as resolving a blocker. Ordered by the field's
   * own `position`. The caller (`crew connect`, interactively) asks once
   * per value whether it means resolved/terminal, and folds the answer into
   * `contract.statuses.resolved`. Undefined when the Issues model's fields
   * couldn't be read (not fatal — ids still resolve); empty when every
   * value already matches the default.
   */
  unrecognizedStatuses?: UnrecognizedStatus[];
  areaModelId?: string;
  areaId?: string;
  areaName?: string;
  /** The `Repos` table, and repo id -> name, for ticket-repo routing. */
  reposModelId?: string;
  repoNames?: Record<string, string>;
  /** The `Repos` table's own `remote` column, id -> `owner/repo`, for auto-clone. */
  repoRemotes?: Record<string, string>;
  shipsModelId?: string;
  epicsModelId?: string;
  locksModelId?: string;
  seats: Record<string, string>;
  /** The Crew row that is the human running this — auto-matched by email
   * against `meEmail` when possible. Left unset when no hold's email matches
   * (or none is on file): the caller decides then, by asking. */
  operator?: string;
  holds: Array<{ id: string; name: string }>;
  /**
   * Set only when no `project` was given AND more than one project qualifies
   * — an ambiguity refused rather than guessed, same reasoning as a
   * route resolved with no name. The caller reruns with `--project` (or
   * `workspace/project`) naming one.
   */
  projectOptions?: ProjectOption[];
  /** Everything that could not be resolved, with what was available. */
  problems: string[];
}

/**
 * A failed `discover()` call, typed by HTTP status so the CLI can tell a bad
 * key/permission (401/403 — worth a specific "is this key a member of that
 * workspace?" hint) from anything else, instead of the caller pattern-matching
 * a plain Error's message.
 */
export class ConnectHttpError extends Error {
  status: number;
  path: string;
  constructor(status: number, path: string, statusText: string) {
    super(`${path}: ${status} ${statusText}`);
    this.name = 'ConnectHttpError';
    this.status = status;
    this.path = path;
  }
}

async function get<T>(o: AuthOptions, path: string): Promise<T> {
  const res = await fetch(`${o.baseUrl.replace(/\/+$/, '')}/api${path}`, {
    headers: {
      Authorization: `Bearer ${o.apiKey}`,
      // Cloudflare 403s default agents on this host.
      'User-Agent': o.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0',
    },
  });
  if (!res.ok) throw new ConnectHttpError(res.status, path, res.statusText);
  return (await res.json()) as T;
}

/**
 * Every workspace this key's own identity belongs to, whichever workspace
 * the key itself was minted in — `GET /auth/my-workspaces` resolves by the
 * identity behind the key, not by the key's own workspace scope, and needs
 * no role beyond being a member somewhere (unlike `GET /workspaces`, which
 * lists literally every workspace and is platform-admin-only).
 */
export async function listWorkspaces(o: AuthOptions): Promise<WorkspaceOption[]> {
  const res = await get<{ workspaces: Array<{ slug: string; name: string; role: string }> }>(
    o, '/auth/my-workspaces',
  );
  return res.workspaces.map((w) => ({ slug: w.slug, name: w.name, role: w.role }));
}

const eq = (a: string | null | undefined, b: string) => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();

/** Names a role by what its Crew row is called, so any naming works. */
function seatFor(rows: Array<{ id: string; name?: string | null }>, role: string): string | undefined {
  const r = rows.find((x) => (x.name ?? '').toLowerCase().includes(role.toLowerCase()));
  return r?.id;
}

/** The tables a route cannot work without — `Issues` alone gates whether a project qualifies. */
const REQUIRED_TABLES = ['Issues'] as const;

/** Which of `REQUIRED_TABLES` this project's own data models are missing. */
async function missingTables(o: DiscoverOptions, projectId: string): Promise<string[]> {
  const models = await get<Array<{ name: string }>>(o, `/data-models?projectId=${projectId}`);
  return REQUIRED_TABLES.filter((t) => !models.some((m) => eq(m.name, t)));
}

export async function discover(o: DiscoverOptions): Promise<Discovered> {
  const problems: string[] = [];
  // `GET /workspaces/:idOrSlug` resolves either form to the real uuid — the
  // rest of this function, and everything downstream, works in ids only.
  const ws = await get<{ id: string; slug: string; name?: string }>(o, `/workspaces/${o.workspace}`);
  const out: Discovered = {
    workspaceId: ws.id, workspaceSlug: ws.slug, workspaceName: ws.name,
    models: {}, seats: {}, holds: [], problems,
  };

  // Own role, not anyone else's — `/auth/me` derives it the same way for an
  // API key as for a session, and is the only "am I an admin here" a plain
  // member's own key can ask without a 403 (no admin-only membership list).
  try {
    const me = await get<{ role?: string; email?: string }>(o, `/auth/me?workspaceId=${ws.id}`);
    out.role = me.role;
    out.meEmail = me.email;
  } catch { /* not fatal — the no-qualifying-project message just stays generic */ }

  if (o.project) {
    // Try it as a project slug/uuid directly first — `GET /projects/:idOrSlug`
    // accepts either when `workspaceId` disambiguates a slug. Only fall back
    // to a name search (case-insensitive, as this always matched) on a miss,
    // so `--project "Issues"` (a display name, not a slug) keeps working.
    try {
      const p = await get<{ id: string; slug: string; name: string }>(
        o, `/projects/${encodeURIComponent(o.project)}?workspaceId=${ws.id}`,
      );
      out.projectId = p.id; out.projectSlug = p.slug; out.projectName = p.name;
    } catch {
      const projects = await get<Array<{ id: string; slug?: string; name: string }>>(o, `/projects?workspaceId=${ws.id}`);
      const hit = projects.find((p) => eq(p.name, o.project!));
      if (hit) { out.projectId = hit.id; out.projectSlug = hit.slug; out.projectName = hit.name; }
      else problems.push(`no project named or slugged "${o.project}" — have: ${projects.map((p) => p.name).join(', ') || '(none)'}`);
    }
  } else {
    // No project named: offer every one that has what a route needs,
    // rather than picking the first and hoping. Refuse to guess between
    // several qualifying ones — same reasoning as an unnamed route with
    // more than one candidate.
    const projects = await get<Array<{ id: string; name: string; slug?: string }>>(o, `/projects?workspaceId=${ws.id}`);
    const options: ProjectOption[] = await Promise.all(
      projects.map(async (p) => ({ id: p.id, name: p.name, slug: p.slug, missing: await missingTables(o, p.id) })),
    );
    const qualifying = options.filter((p) => p.missing.length === 0);
    if (qualifying.length === 1) {
      out.projectId = qualifying[0]!.id; out.projectSlug = qualifying[0]!.slug; out.projectName = qualifying[0]!.name;
    } else if (qualifying.length > 1) {
      out.projectOptions = qualifying;
      problems.push(
        `${qualifying.length} projects in this workspace all have the tables a route needs — ` +
          `name one: ${qualifying.map((p) => p.slug ?? p.name).join(', ')}`,
      );
    } else {
      const isAdmin = out.role === 'WORKSPACE_ADMIN' || out.role === 'PLATFORM_ADMIN';
      problems.push(
        `no project in this workspace has the tables a route needs (${REQUIRED_TABLES.join(', ')}) — ` +
          (isAdmin
            ? 'install an Issues-tracker template for this workspace (Library, in the app), then rerun.'
            : 'ask a workspace admin to set one up, then rerun.'),
      );
    }
  }

  // Nothing below means anything without a specific project: a workspace-wide
  // model search would match whichever project's "Issues" table happened to
  // come back first, silently wrong the moment a workspace holds more than
  // one Issues-shaped project.
  if (!out.projectId) return out;

  const models = await get<Array<{ id: string; name: string }>>(o, `/data-models?projectId=${out.projectId}`);
  const find = (name: string) => models.find((m) => eq(m.name, name))?.id;

  for (const [key, name] of [['issues', 'Issues'], ['comments', 'Comments'], ['crew', 'Crew']] as const) {
    const id = find(name);
    if (id) out.models[key] = id;
    else problems.push(`no "${name}" table — have: ${models.map((m) => m.name).join(', ')}`);
  }
  // Read the Issues model's own status field to find any CHOICE value
  // DEFAULT_CONTRACT doesn't already name (ISSUE-467) — the discovery
  // half of what used to require hand-editing the resolved state file's
  // `contract.statuses.resolved` (see docs/CONTRACT.md). Best-effort: a key
  // that cannot read field metadata still gets everything else `discover()`
  // found, just no status classification prompt.
  if (out.models.issues) {
    try {
      const issuesModel = await get<{
        fields: Array<{
          columnName: string;
          fieldType?: { choiceOptions?: Array<{ value: string; label?: string; position?: number | null }> };
        }>;
      }>(o, `/data-models/${out.models.issues}`);
      const statusField = issuesModel.fields.find((f) => f.columnName === DEFAULT_CONTRACT.columns.status);
      const known = new Set([...DEFAULT_CONTRACT.statuses.open, ...DEFAULT_CONTRACT.statuses.resolved]);
      out.unrecognizedStatuses = (statusField?.fieldType?.choiceOptions ?? [])
        .filter((opt) => !known.has(opt.value))
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((opt) => ({ value: opt.value, label: opt.label ?? undefined, position: opt.position ?? undefined }));
    } catch {
      // Silent, not added to `problems` — see the field's own doc comment.
    }
  }

  out.areaModelId = find('Projects');
  out.reposModelId = find('Repos');
  out.shipsModelId = find('Ships');
  // Optional, like Ships: an unmodified Issue Tracker template has no Epics
  // table, and that is a legitimate shape, not a problem to report.
  out.epicsModelId = find('Epics');
  // Optional, like Ships and Epics: a workspace that has not adopted a
  // board-visible release lock (ISSUE-394) still works with the local-only
  // pid lock it always had.
  out.locksModelId = find('Locks');

  // Optional, like Ships/Epics/Locks: a workspace with only one repo, or one
  // that has not sliced its board by repository at all, has no Repos table.
  if (out.reposModelId) {
    const repos = await get<Array<{ id: string; name?: string | null; remote?: string | null }>>(
      o, `/data-models/${out.reposModelId}/records?limit=200`,
    );
    out.repoNames = Object.fromEntries(repos.map((r) => [r.id, r.name ?? '']));
    const remotes = Object.fromEntries(
      repos.filter((r) => r.remote).map((r) => [r.id, r.remote as string]),
    );
    if (Object.keys(remotes).length > 0) out.repoRemotes = remotes;
  }

  if (o.area) {
    if (!out.areaModelId) problems.push(`--area given but this project has no "Projects" table`);
    else {
      const areas = await get<Array<{ id: string; name?: string }>>(o, `/data-models/${out.areaModelId}/records?limit=200`);
      const hit = areas.find((a) => eq(a.name, o.area!));
      if (hit) { out.areaId = hit.id; out.areaName = hit.name; }
      else problems.push(`no area named "${o.area}" — have: ${areas.map((a) => a.name).join(', ')}`);
    }
  }

  if (out.models.crew) {
    const rows = await get<Array<{ id: string; name?: string | null; email?: string | null }>>(
      o, `/data-models/${out.models.crew}/records?limit=200`,
    );
    for (const role of ['dev', 'design', 'qa', 'triage']) {
      const id = seatFor(rows, role === 'dev' ? 'develop' : role);
      if (id) out.seats[role] = id;
      else problems.push(`no Crew row looking like the ${role} seat — create one, or omit that role`);
    }
    // `pair` is optional and best-effort, unlike the four polled seats above:
    // a workspace with no interactive-session row yet is not a problem, just
    // one `crew agents sync` cannot link a persona to. Stored the same way
    // (`out.seats.pair`) so `crew agents sync`'s existing seat-linking loop
    // needs no `pair`-specific code — `configuredMembers()` (config.ts) is
    // what reclassifies this one row as a HOLD rather than a seat, since a
    // ticket Pair is working must stay off-limits to the polled seats the
    // same way one a person is driving does.
    const pairId = seatFor(rows, 'pair');
    if (pairId) out.seats.pair = pairId;
    // Anything that is not one of the seats is a person or a session: a hold.
    const seatIds = new Set(Object.values(out.seats));
    out.holds = rows.filter((r) => !seatIds.has(r.id)).map((r) => ({ id: r.id, name: r.name ?? '' }));
    if (out.holds.length === 0) {
      problems.push('no non-seat Crew rows — which row is the operator?');
    } else if (out.meEmail) {
      // The key's own identity email against each hold's Crew-row email —
      // when exactly one matches, that IS the operator, with no digging for
      // a uuid required. Ambiguous (0 or 2+ matches) is left for the caller
      // to ask about instead of guessing.
      const holdRows = rows.filter((r) => !seatIds.has(r.id));
      const matches = holdRows.filter((r) => eq(r.email, out.meEmail!));
      if (matches.length === 1) out.operator = matches[0]!.id;
    }
  }
  return out;
}

/**
 * A paste-ready route block — everything a person still has to author.
 *
 * The ids `discover()` found are NOT in here: they go straight into
 * `<stateDir>/resolved/<workspace>/<project>.json` (see `resolvedPathFor` in
 * config.ts), written by the caller, not pasted by hand.
 */
export function renderConnection(d: Discovered, route: string, dir: string, opts: { area?: string } = {}): string {
  return `  - route: ${route}
    enabled: false          # arm it deliberately, once doctor is green
${opts.area ? `    area: "${opts.area}"\n` : ''}    dir: "${dir}"
    # worktreePrefix: omitted — each repo derives its own from its checkout's
    # directory name (ISSUE-400). Only set this if every repo this route
    # serves genuinely wants the SAME prefix, which is rare once an area has
    # more than one repo.
    # What a host must be to build this — unix, macos, linux, or windows —
    # belongs in each repo's own .crew.yaml, not here (see docs/REPO_SPEC.md).
    baseUrl: "REPLACE — the same baseUrl as your other routes"
    apiKeyFile: "REPLACE — a file holding this workspace's key"
    apiKeyVar: REPLACE_KEY_VAR
`;
}

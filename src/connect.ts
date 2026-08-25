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

export interface Discovered {
  workspaceId: string;
  /** The canonical slug, whatever form (slug/uuid) `workspace` was given in. */
  workspaceSlug: string;
  workspaceName?: string;
  /** This key's own role in the workspace — `/auth/me` — for the
   * no-qualifying-project message: an admin can install a template, a plain
   * member cannot. */
  role?: string;
  projectId?: string;
  /** The canonical slug, when the resolved project has one — building the
   * `route:` string (`workspaceSlug/projectSlug`) needs this, not the
   * display name. */
  projectSlug?: string;
  projectName?: string;
  models: Record<string, string>;
  areaModelId?: string;
  areaId?: string;
  areaName?: string;
  /** The `Repos` table, and repo id -> name, for ticket-repo routing. */
  reposModelId?: string;
  repoNames?: Record<string, string>;
  shipsModelId?: string;
  epicsModelId?: string;
  locksModelId?: string;
  seats: Record<string, string>;
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

async function get<T>(o: AuthOptions, path: string): Promise<T> {
  const res = await fetch(`${o.baseUrl.replace(/\/+$/, '')}/api${path}`, {
    headers: {
      Authorization: `Bearer ${o.apiKey}`,
      // Cloudflare 403s default agents on this host.
      'User-Agent': o.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0',
    },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
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
    const me = await get<{ role?: string }>(o, `/auth/me?workspaceId=${ws.id}`);
    out.role = me.role;
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
    const repos = await get<Array<{ id: string; name?: string | null }>>(
      o, `/data-models/${out.reposModelId}/records?limit=200`,
    );
    out.repoNames = Object.fromEntries(repos.map((r) => [r.id, r.name ?? '']));
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
    // Anything that is not one of the seats is a person or a session: a hold.
    const seatIds = new Set(Object.values(out.seats));
    out.holds = rows.filter((r) => !seatIds.has(r.id)).map((r) => ({ id: r.id, name: r.name ?? '' }));
    if (out.holds.length === 0) problems.push('no non-seat Crew rows — which row is the operator?');
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

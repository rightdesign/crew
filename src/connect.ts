/**
 * `crew connect` — discovery half.
 *
 * A connection needs fourteen uuids. Every one of them is discoverable by
 * name, and writing them out by hand is the friction ISSUE-285 exists to
 * remove. This does the READ-ONLY part of that ticket: resolve names to ids
 * and print a connection block ready to paste into crew.yaml.
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

export interface DiscoverOptions {
  baseUrl: string;
  apiKey: string;
  workspaceId: string;
  /** Names, matched case-insensitively. */
  project?: string;
  area?: string;
  userAgent?: string;
}

export interface Discovered {
  workspaceId: string;
  workspaceName?: string;
  projectId?: string;
  projectName?: string;
  models: Record<string, string>;
  areaModelId?: string;
  areaId?: string;
  areaName?: string;
  shipsModelId?: string;
  epicsModelId?: string;
  seats: Record<string, string>;
  operator?: string;
  holds: Array<{ id: string; name: string }>;
  /** Everything that could not be resolved, with what was available. */
  problems: string[];
}

async function get<T>(o: DiscoverOptions, path: string): Promise<T> {
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

const eq = (a: string | null | undefined, b: string) => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();

/** Names a role by what its Crew row is called, so any naming works. */
function seatFor(rows: Array<{ id: string; name?: string | null }>, role: string): string | undefined {
  const r = rows.find((x) => (x.name ?? '').toLowerCase().includes(role.toLowerCase()));
  return r?.id;
}

export async function discover(o: DiscoverOptions): Promise<Discovered> {
  const problems: string[] = [];
  const out: Discovered = { workspaceId: o.workspaceId, models: {}, seats: {}, holds: [], problems };

  const ws = await get<{ name?: string }>(o, `/workspaces/${o.workspaceId}`);
  out.workspaceName = ws.name;

  if (o.project) {
    const projects = await get<Array<{ id: string; name: string }>>(o, `/projects?workspaceId=${o.workspaceId}`);
    const hit = projects.find((p) => eq(p.name, o.project!));
    if (hit) { out.projectId = hit.id; out.projectName = hit.name; }
    else problems.push(`no project named "${o.project}" — have: ${projects.map((p) => p.name).join(', ') || '(none)'}`);
  }

  const scope = out.projectId ? `projectId=${out.projectId}` : `workspaceId=${o.workspaceId}`;
  const models = await get<Array<{ id: string; name: string }>>(o, `/data-models?${scope}`);
  const find = (name: string) => models.find((m) => eq(m.name, name))?.id;

  for (const [key, name] of [['issues', 'Issues'], ['comments', 'Comments'], ['crew', 'Crew']] as const) {
    const id = find(name);
    if (id) out.models[key] = id;
    else problems.push(`no "${name}" table — have: ${models.map((m) => m.name).join(', ')}`);
  }
  out.areaModelId = find('Projects');
  out.shipsModelId = find('Ships');
  // Optional, like Ships: an unmodified Issue Tracker template has no Epics
  // table, and that is a legitimate shape, not a problem to report.
  out.epicsModelId = find('Epics');

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

/** A paste-ready connection block. */
export function renderConnection(d: Discovered, name: string, dir: string, opts: { area?: string } = {}): string {
  const seats = Object.entries(d.seats).map(([k, v]) => `        ${k}: "${v}"`).join('\n');
  const holds = d.holds
    .filter((h) => h.id !== d.operator)
    .map((h) => `        - id: "${h.id}"          # ${h.name}`)
    .join('\n');
  return `  - name: ${name}
    enabled: false          # arm it deliberately, once doctor is green
    workspace: ${d.workspaceName ?? d.workspaceId}
${d.projectName ? `    project: "${d.projectName}"\n` : ''}${opts.area ? `    area: "${opts.area}"\n` : ''}    dir: "${dir}"
    # worktreePrefix: omitted — each repo derives its own from its checkout's
    # directory name (ISSUE-400). Only set this if every repo this connection
    # serves genuinely wants the SAME prefix, which is rare once an area has
    # more than one repo.
    platform: unix
    baseUrl: "REPLACE — the same baseUrl as your other connections"
    apiKeyFile: "REPLACE — a file holding this workspace's key"
    apiKeyVar: REPLACE_KEY_VAR

    # Discovered, not authored. Regenerate with \`crew connect\` rather than editing.
    resolved:
      workspaceId: "${d.workspaceId}"
${d.projectId ? `      projectId: "${d.projectId}"\n` : ''}${d.areaModelId ? `      areaModelId: "${d.areaModelId}"\n` : ''}${d.areaId ? `      areaId: "${d.areaId}"\n` : ''}${d.shipsModelId ? `      shipsModelId: "${d.shipsModelId}"\n` : ''}${d.epicsModelId ? `      epicsModelId: "${d.epicsModelId}"\n` : ''}      models:
        issues: "${d.models.issues ?? 'MISSING'}"
        comments: "${d.models.comments ?? 'MISSING'}"
        crew: "${d.models.crew ?? 'MISSING'}"
      seats:
${seats}
      operator: "${d.operator ?? 'REPLACE — the Crew row for the person running this'}"
${holds ? `      holds:\n${holds}\n` : ''}`;
}

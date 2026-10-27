/**
 * `crew connect` — discovery, plus provisioning this machine's own rows.
 *
 * A route needs fourteen uuids. Every one of them is discoverable by
 * name, and writing them out by hand is the friction ISSUE-285 exists to
 * remove. Most of this file resolves names to ids and prints a route block
 * ready to paste into crew.yaml — read-only.
 *
 * Two things it does write, both opt-in via `DiscoverOptions.ship` (a plain
 * discover() call with no `ship` given, like every test in
 * `connect.test.ts`, stays exactly as read-only as before):
 *   - find-or-create the caller's own `Ships` row, matched by exact name
 *     (ISSUE-380's own convention, `Tracker.myShipRow`);
 *   - find, claim, or create a `Crew` row per polled lane (dev/design/qa/
 *     triage), scoped to that Ships row via `ship_id` (ISSUE-610).
 *
 * Minting a workspace API key needed the keychain work in ISSUE-283 too —
 * that part shipped as ISSUE-609's device-authorization handshake instead.
 */

import { DEFAULT_CONTRACT, EVENT_LOG_MISSING } from './contract.ts';
import { ensureLockRows, releaseLockScope, type LockProvisionClient } from './board-lock.ts';
import { PERSONA_NAME } from './agents.ts';
import { DEFAULT_BASE_URL, type RoleName } from './config.ts';
import { planNameSync } from './ship-name.ts';

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
  /**
   * This machine's own identity (`crew.yaml`'s `ship.name`/`ship.platform`)
   * — when given, `discover()` provisions this ship's `Ships` row and its
   * per-lane `Crew` rows (ISSUE-610). Omitted, `discover()` stays exactly
   * the read-only lookup it always was: no ship-scoping, no writes, the
   * old workspace-wide-by-name seat search.
   */
  ship?: {
    name: string; platform?: string; hostPassengers?: boolean; sshPublicKey?: string;
    /**
     * This machine's hashed id (`machine-id.ts`, ISSUE-2249). Matched against
     * the Ships row's `machine_id` before the name, so a drifted hostname does
     * not provision a second ship. Absent: name matching only, as before.
     */
    machineId?: string;
    /**
     * The ship name this route last saw agree with its Ships row (CREW-2495),
     * looked up by route string once discovery knows it. Absent: no baseline.
     */
    lastSyncedName?: (route: string) => string | undefined;
  };
  /**
   * Same meaning as everywhere else in the CLI: report what discovery would
   * do without writing anything. Provisioning (the `ship` option above) is
   * entirely skipped under a dry run, same as the resolved-state and
   * API-key files `cli.ts`'s `connect` case writes — this function makes no
   * network POST/PATCH calls at all when set.
   */
  dryRun?: boolean;
  /**
   * A person can be asked which Crew row is theirs (the CLI has a terminal).
   * When set, an operator that cannot be settled by identity/email/the only
   * candidate is left unresolved for the caller to ask about (CREW-1798);
   * otherwise `discover()` creates the operator's own Crew row rather than
   * leave the route with none.
   */
  interactive?: boolean;
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
  /** The canonical address (`path` when the server sends one, else `slug`), whatever form (segment/slug/uuid) `workspace` was given in. */
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
  /** This key's own identity id, from the same `/auth/me` call — written onto the Ships row as `owner_id` (CREW-1286). */
  meId?: string;
  /** This key's person across memberships (`/auth/me.identityId`, CREW-2423), when the server sends it — lets a Crew row linked to another membership of the same person (an alias, a re-invite) count as the operator's own. */
  meIdentityId?: string;
  /** This key's own display name, from the same `/auth/me` call — names a Crew row `connect` creates for the operator (CREW-1798). */
  meName?: string;
  /** The Crew table's id, kept so the caller can link/create the operator's row after an interactive pick. */
  crewModelId?: string;
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
  /** The record-link-only View bound to Issues (ISSUE-928) — see the field's matching doc comment on `ResolvedIds` in config.ts. */
  recordLinkViewId?: string;
  seats: Record<string, string>;
  /** This ship's "Release" Crew row (CREW-1371) — see `ResolvedIds.releaseSeat`. */
  releaseSeat?: string;
  /** The Crew row that is the human running this — auto-matched by email
   * against `meEmail` when possible. Left unset when no hold's email matches
   * (or none is on file): the caller decides then, by asking. */
  operator?: string;
  holds: Array<{ id: string; name: string; email?: string | null; user_id?: string | null; memberEmail?: string }>;
  /**
   * The subset of `holds` that can be a person: no `agent_id` and no `ship_id`
   * (CREW-2423). Seat rows and Release rows of other ships are holds for the
   * poll loop, but are never offered as the operator. `detail` is the email
   * shown under the name (the row's own, else its linked member's).
   */
  candidates: Array<{ id: string; name: string; email?: string | null; user_id?: string | null; detail?: string }>;
  /** What the operator match compared, for `--dry-run` and the `operator_row` event when no row matched (CREW-2423). */
  operatorCompared?: string;
  /**
   * Set only when no `project` was given AND more than one project qualifies
   * — an ambiguity refused rather than guessed, same reasoning as a
   * route resolved with no name. The caller reruns with `--project` (or
   * `workspace/project`) naming one.
   */
  projectOptions?: ProjectOption[];
  /**
   * Set when no `project` was named and no project in the workspace has the
   * tables a route needs (ISSUE-419) — the caller (`crew connect`, on a real
   * terminal, when `role` is an admin) can offer to install the Issues
   * library template rather than just telling the operator to do it by hand
   * in the app. Left unset for every other "unresolved" shape (a named
   * project not found, several qualifying projects tied) — those aren't
   * "nothing to install", they're "say which one".
   */
  offerTemplateInstall?: boolean;
  /** Everything that could not be resolved, with what was available. */
  problems: string[];
  /**
   * What this pass's provisioning (`DiscoverOptions.ship`, ISSUE-610)
   * actually did — a Ships row created or matched, a Crew row claimed
   * (a pre-multi-machine row with no `ship_id` yet, pointed at this ship)
   * or newly created. Empty when `ship` was omitted, this was a dry run,
   * the workspace has no `Ships` table, or nothing needed doing (every
   * row already matched). The caller (`crew connect`) prints these so
   * provisioning a machine is never a silent write.
   */
  provisioning: string[];
  /**
   * The Ships row this machine resolved to and whether this pass created it,
   * for `crew connect --json`'s `ship_row` event (CREW-2235). Unset whenever
   * `provisioning` skipped the Ships row.
   */
  shipRow?: { id: string; name: string; action: 'created' | 'matched'; matchedBy?: 'machine_id' | 'name' };
  /** The Ships row's name, when the three-way rule (ship-name.ts) says this machine takes it over crew.yaml's. */
  shipNameAdopted?: string;
  /** Per-seat outcome of the Crew-row provisioning, for the `seat` events. */
  seatRows?: Array<{ role: string; id: string; action: 'matched' | 'claimed' | 'created' | 'would-create'; shipId?: string }>;
  /** How `operator` was settled, for the `operator_row` event. */
  operatorAction?: 'matched' | 'linked' | 'created' | 'would-create';
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

export async function get<T>(o: AuthOptions, path: string): Promise<T> {
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

async function post<T>(o: AuthOptions, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${o.baseUrl.replace(/\/+$/, '')}/api${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${o.apiKey}`,
      'User-Agent': o.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ConnectHttpError(res.status, path, res.statusText);
  return (await res.json()) as T;
}

async function patch<T>(o: AuthOptions, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${o.baseUrl.replace(/\/+$/, '')}/api${path}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${o.apiKey}`,
      'User-Agent': o.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ConnectHttpError(res.status, path, res.statusText);
  return (await res.json()) as T;
}

async function del(o: AuthOptions, path: string): Promise<void> {
  const res = await fetch(`${o.baseUrl.replace(/\/+$/, '')}/api${path}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${o.apiKey}`,
      'User-Agent': o.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0',
    },
  });
  if (!res.ok) throw new ConnectHttpError(res.status, path, res.statusText);
}

/**
 * Provision the release-lock row for each repo scope of a route (CREW-1384):
 * one `Locks` row per `<route>/<repo>`, created when missing and left alone
 * otherwise, so the release phase can treat a missing row as an error rather
 * than silently releasing without a board lock. Returns the scopes created.
 * Safe to run from two ships at once — see `ensureLockRows`.
 */
export async function provisionReleaseLocks(
  o: AuthOptions, locksModelId: string, route: string, repoNames: string[],
): Promise<string[]> {
  const scopes = [...new Set(repoNames)].sort().map((r) => releaseLockScope(route, r));
  if (scopes.length === 0) return [];
  const client: LockProvisionClient = {
    // The Locks table is a handful of rows, so read it whole and match in
    // memory rather than depend on the HTTP filter syntax.
    list: async (model, params) => {
      const want = (JSON.parse(params?.filters ?? '[]') as Array<{ value?: string }>)[0]?.value;
      const rows = await get<Array<{ id: string; scope: string; created_at?: string; updated_at: string }>>(
        o, `/data-models/${model}/records?limit=500`,
      );
      return rows.filter((r) => r.scope === want).slice(0, params?.limit ?? rows.length);
    },
    create: (model, body) => post(o, `/data-models/${model}/records`, body),
    remove: (model, id) => del(o, `/data-models/${model}/records/${id}`),
  };
  return ensureLockRows(client, locksModelId, scopes);
}

/** One template on the platform-wide Tablation Library (`GET /library-templates` — no `workspaceId`, every published template is visible from anywhere). */
export interface LibraryTemplateOption {
  id: string;
  name: string;
  /** Stable dotted-lowercase handle (e.g. `tablation.issues`) — unlike `name`, never freely edited, so this is what a caller should match on, not the display name. */
  identifier: string;
}

/**
 * `LibraryTemplate.identifier`s of the "Issues" tracker template that `crew
 * connect <workspace>` recognizes, preferred first — matched on the stable
 * handle rather than the freely-editable display name (ISSUE-967). The
 * template was republished as `tablation.issues` and `crew.issues` retired
 * into it (ISSUE-2480), so an install made from either still counts; the
 * install offer uses the first.
 */
export const ISSUES_TEMPLATE_IDENTIFIERS: readonly string[] = ['tablation.issues', 'crew.issues'];

/**
 * Every value a project's `sourceTemplateId` (or a Library template's
 * `identifier`) may carry and still be the Issues tracker: the list above,
 * plus — when the platform exposes `GET /library-templates/by-identifier/:identifier`
 * (it follows supersession) — the id and identifier of whatever each
 * candidate currently resolves to, so an identifier retired after this
 * release still matches. An older platform answers 404 (or errors) and the
 * list alone decides.
 */
export async function resolveIssuesTemplateKeys(o: AuthOptions): Promise<Set<string>> {
  const keys = new Set<string>(ISSUES_TEMPLATE_IDENTIFIERS);
  await Promise.all(ISSUES_TEMPLATE_IDENTIFIERS.map(async (identifier) => {
    try {
      const t = await get<{ id?: string; identifier?: string }>(
        o, `/library-templates/by-identifier/${encodeURIComponent(identifier)}`,
      );
      if (t.id) keys.add(t.id);
      if (t.identifier) keys.add(t.identifier);
    } catch { /* route absent on an older platform, or no such template — the list decides */ }
  }));
  return keys;
}

export async function listLibraryTemplates(o: AuthOptions): Promise<LibraryTemplateOption[]> {
  return get<LibraryTemplateOption[]>(o, '/library-templates');
}

/** Only what `crew connect`'s install offer needs from `GET /library-templates/:id/install-preview` — the full diff has a bucket per entity kind, this only cares whether any of them collided. */
export interface TemplateInstallPreview {
  hasUnresolvedConflicts: boolean;
  dataModels: { conflicts: Array<{ name: string; tableName: string }> };
  fieldTypes: { conflicts: Array<{ name: string }> };
}

export async function previewTemplateInstall(
  o: AuthOptions, templateId: string, workspaceId: string,
): Promise<TemplateInstallPreview> {
  return get<TemplateInstallPreview>(o, `/library-templates/${templateId}/install-preview?workspaceId=${workspaceId}`);
}

export interface InstalledTemplate {
  project: { id: string; slug: string; name: string };
}

export async function installTemplate(
  o: AuthOptions, templateId: string, workspaceId: string, projectName?: string,
): Promise<InstalledTemplate> {
  return post<InstalledTemplate>(o, `/library-templates/${templateId}/install`, {
    workspaceId,
    ...(projectName ? { projectName } : {}),
  });
}

/**
 * Every workspace this key's own identity belongs to, whichever workspace
 * the key itself was minted in — `GET /auth/my-workspaces` resolves by the
 * identity behind the key, not by the key's own workspace scope, and needs
 * no role beyond being a member somewhere (unlike `GET /workspaces`, which
 * lists literally every workspace and is platform-admin-only).
 */
export async function listWorkspaces(o: AuthOptions): Promise<WorkspaceOption[]> {
  const res = await get<{ workspaces: Array<{ slug: string; path?: string; name: string; role: string }> }>(
    o, '/auth/my-workspaces',
  );
  return res.workspaces.map((w) => ({ slug: w.path ?? w.slug, name: w.name, role: w.role }));
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
  const provisioning: string[] = [];
  // `GET /workspaces/:idOrSlug` resolves either form to the real uuid — the
  // rest of this function, and everything downstream, works in ids only.
  // `path` is the `<primary>:<slug>` segment a secondary workspace is
  // addressed by (EPIC-051); a server that predates the field sends only
  // `slug`, which is the whole address of a primary.
  const ws = await get<{ id: string; slug: string; path?: string; name?: string }>(o, `/workspaces/${encodeURIComponent(o.workspace).replace(/%3A/gi, ':')}`);
  const out: Discovered = {
    workspaceId: ws.id, workspaceSlug: ws.path ?? ws.slug, workspaceName: ws.name,
    models: {}, seats: {}, holds: [], candidates: [], problems, provisioning,
  };

  // Own role, not anyone else's — `/auth/me` derives it the same way for an
  // API key as for a session, and is the only "am I an admin here" a plain
  // member's own key can ask without a 403 (no admin-only membership list).
  try {
    const me = await get<{ role?: string; email?: string; id?: string; name?: string; identityId?: string }>(o, `/auth/me?workspaceId=${ws.id}`);
    out.role = me.role;
    out.meEmail = me.email;
    out.meId = me.id;
    out.meIdentityId = me.identityId;
    out.meName = me.name;
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
    const projects = await get<Array<{
      id: string; name: string; slug?: string; sourceTemplateId?: string | null;
    }>>(o, `/projects?workspaceId=${ws.id}`);
    // No project named: `crew connect <workspace>` defaults to the `issues`
    // project (ISSUE-967) — matched by source-template identifier first (so
    // a renamed/reslugged install of `tablation.issues`, or of the retired
    // `crew.issues`, still counts), falling
    // back to slug `issues` (a hand-built or pre-identifier project). Tried
    // before the multi-project picker below, not instead of it: a default
    // candidate that doesn't actually qualify (missing tables) falls
    // through to the same picker/install-offer as if none was named.
    const issuesKeys = await resolveIssuesTemplateKeys(o);
    const defaultCandidate = projects.find((p) => !!p.sourceTemplateId && issuesKeys.has(p.sourceTemplateId))
      ?? projects.find((p) => eq(p.slug ?? '', 'issues'));
    if (defaultCandidate && (await missingTables(o, defaultCandidate.id)).length === 0) {
      out.projectId = defaultCandidate.id; out.projectSlug = defaultCandidate.slug; out.projectName = defaultCandidate.name;
    } else {
      // Offer every project that has what a route needs, rather than
      // picking the first and hoping. Refuse to guess between several
      // qualifying ones — same reasoning as an unnamed route with more
      // than one candidate.
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
        out.offerTemplateInstall = isAdmin;
        problems.push(
          `no project in this workspace has the tables a route needs (${REQUIRED_TABLES.join(', ')}) — ` +
            (isAdmin
              ? 'install an Issues-tracker template for this workspace (Library, in the app), then rerun.'
              : 'ask a workspace admin to set one up, then rerun.'),
        );
      }
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
      const known = new Set([
        ...DEFAULT_CONTRACT.statuses.open,
        ...DEFAULT_CONTRACT.statuses.resolved,
        DEFAULT_CONTRACT.statuses.draft,
      ]);
      out.unrecognizedStatuses = (statusField?.fieldType?.choiceOptions ?? [])
        .filter((opt) => !known.has(opt.value))
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((opt) => ({ value: opt.value, label: opt.label ?? undefined, position: opt.position ?? undefined }));
    } catch {
      // Silent, not added to `problems` — see the field's own doc comment.
    }
  }

  // Crew writes its audit trail to the Issues table's event log (CREW-1574),
  // so a table without one is a problem, not an optional shape. 404 is the
  // API's way of saying the setting is off; any other failure is left alone
  // rather than blamed on the setting.
  if (out.models.issues) {
    try {
      await get(o, `/data-models/${out.models.issues}/events?limit=1`);
    } catch (e) {
      if (e instanceof ConnectHttpError && e.status === 404) problems.push(EVENT_LOG_MISSING);
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

  // The record-link-only View bound to Issues (ISSUE-928) — what
  // `Tracker.recordLinkUrl` mints against. Best-effort like the field
  // metadata read above: a key that cannot list views still gets
  // everything else `discover()` found, just no attention-event link.
  // Exactly one qualifying view resolves automatically; zero or several are
  // left unset with a non-fatal `problems` line, the same shape `crew
  // doctor` already uses for a missing Ships table.
  try {
    const views = await get<Array<{
      id: string;
      recordLinkOnly?: boolean;
      published?: boolean;
      publicSlug?: string | null;
      pages?: Array<{ components?: Array<{ dataModelId?: string }> }>;
    }>>(o, `/views?workspaceId=${ws.id}`);
    const candidates = views.filter((v) => (
      v.recordLinkOnly === true && v.published === true && !!v.publicSlug &&
      (v.pages ?? []).some((p) => (p.components ?? []).some((c) => c.dataModelId === out.models.issues))
    ));
    if (candidates.length === 1) {
      out.recordLinkViewId = candidates[0]!.id;
    } else if (candidates.length === 0) {
      problems.push('no record-link-only view bound to Issues — attention events will carry no link');
    } else {
      problems.push(
        `${candidates.length} record-link-only views bound to Issues — set resolved.recordLinkViewId by hand`,
      );
    }
  } catch {
    // Not fatal — see this block's own doc comment above.
  }

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

  // Ship provisioning (ISSUE-610): find-or-create this machine's own Ships
  // row before resolving Crew seats, so a brand-new machine needs no manual
  // step in the app first. Both this and the Crew-row provisioning below
  // are skipped entirely — falling through to the old workspace-wide,
  // unscoped seat search — when the caller gave no `ship` (every test in
  // connect.test.ts), this is a dry run, this workspace has no Ships table,
  // or the ship's name matches more than one row (ambiguous, left for a
  // person the same way `Tracker.myShipRow` leaves it).
  let shipRowId: string | undefined;
  if (out.shipsModelId && o.ship && !o.dryRun) {
    const shipRows = await get<Array<{
      id: string; name?: string | null; host_passengers?: boolean | null; ssh_public_key?: string | null;
      owner_id?: string | null; machine_id?: string | null;
    }>>(
      o, `/data-models/${out.shipsModelId}/records?limit=200`,
    );
    // Config-truth for this flag lives on this machine (this route's own
    // `hostPassengers:`), never on the Ships row itself (ISSUE-644) — the
    // row is a read-only reflection, synced here on every connect so a
    // change to crew.yaml takes effect the next time this route reconnects.
    // `tunnel_status` is deliberately left untouched: the tunnel client
    // (`tunnel.ts`) owns it, and stamping a default here could clobber a
    // live value.
    const hostPassengers = o.ship.hostPassengers ?? false;
    // Same reasoning as `hostPassengers`, for the ship's own SSH public key
    // (ISSUE-553). INFORMATIONAL ONLY since CREW-1320: the relay no longer
    // reads this column (it checks the ship's API key through `/auth/me` and
    // binds slugs to the key fingerprint itself), so it is kept for humans
    // looking at the Ships row, not for tunnel auth. The keypair itself is generated and persisted on this
    // machine (`ssh-keys.ts`), never on the Ships row — the row only ever
    // reflects whatever public key this machine currently holds, synced on
    // every connect so a regenerated key takes effect the next time this
    // route reconnects. Absent (no `sshPublicKey` given, e.g. Docker/ssh-keygen
    // unavailable) means "leave whatever is on the row alone" rather than
    // clobbering a working key with nothing.
    const sshPublicKey = o.ship.sshPublicKey;
    // The caller's own identity as the ship's owner (CREW-1286). The column
    // arrives with a template update, so an install that has not taken it yet
    // has no `owner_id` field on Ships: that is skipped (and said so in
    // `provisioning`), never an error. Not attempted at all when `/auth/me`
    // gave no id — nothing to record.
    // One read of the Ships field metadata serves both optional columns, which
    // arrive with a template update: `owner_id` (CREW-1286) and `machine_id`
    // (ISSUE-2249). Unreadable metadata reads as "column absent".
    let shipColumns = new Set<string>();
    try {
      const shipsModel = await get<{ fields?: Array<{ columnName: string }> }>(o, `/data-models/${out.shipsModelId}`);
      shipColumns = new Set((shipsModel.fields ?? []).map((f) => f.columnName));
    } catch { /* see above */ }
    let ownerId: string | undefined;
    if (out.meId) {
      if (shipColumns.has('owner_id')) ownerId = out.meId;
      else provisioning.push('could not record the ship owner — the Ships table has no owner_id column yet (update the Issues template)');
    }
    // Match by machine id first (ISSUE-2249), then by name. A row carrying a
    // DIFFERENT machine id is another machine that happens to share this
    // hostname: it is never claimed, so the two get two rows.
    const machineId = shipColumns.has('machine_id') ? o.ship.machineId : undefined;
    let mine: typeof shipRows;
    let matchedBy: 'machine_id' | 'name' = 'name';
    let writeMachineId = false;
    const byName = shipRows.filter((r) => (r.name ?? '').trim() === o.ship!.name.trim());
    if (machineId) {
      const byId = shipRows.filter((r) => (r.machine_id ?? '') === machineId);
      if (byId.length > 0) {
        mine = byId;
        matchedBy = 'machine_id';
      } else {
        mine = byName.filter((r) => !r.machine_id);
        writeMachineId = true;
      }
    } else {
      mine = byName;
    }
    if (mine.length === 1) {
      shipRowId = mine[0]!.id;
      out.shipRow = { id: shipRowId, name: o.ship.name, action: 'matched', matchedBy };
      const patchBody: Record<string, unknown> = {};
      if (matchedBy === 'machine_id') {
        // CREW-2495: the same three-way rule start-up applies (ship-name.ts).
        const rowName = (mine[0]!.name ?? '').trim();
        const route = `${out.workspaceSlug}/${out.projectSlug ?? out.projectId}`;
        const plan = planNameSync(o.ship.name.trim(), rowName, o.ship.lastSyncedName?.(route));
        if (plan.action === 'push') {
          patchBody.name = o.ship.name.trim();
          provisioning.push(`renamed Ships row "${rowName}" to "${o.ship.name.trim()}" (crew.yaml changed)`);
        } else if (plan.action === 'adopt' || plan.action === 'row-wins') {
          out.shipRow.name = rowName;
          out.shipNameAdopted = rowName;
          provisioning.push(`matched Ships row "${rowName}" by machine id — this host's name becomes "${rowName}"${plan.action === 'row-wins' ? ' (crew.yaml also changed; the Ships row wins)' : ''}`);
        }
        patchBody.last_seen = new Date().toISOString();
      }
      if (writeMachineId) patchBody.machine_id = machineId;
      if ((mine[0]!.host_passengers ?? false) !== hostPassengers) patchBody.host_passengers = hostPassengers;
      if (sshPublicKey !== undefined && (mine[0]!.ssh_public_key ?? '') !== sshPublicKey) {
        patchBody.ssh_public_key = sshPublicKey;
      }
      if (ownerId !== undefined && (mine[0]!.owner_id ?? '') !== ownerId) patchBody.owner_id = ownerId;
      if (Object.keys(patchBody).length > 0) {
        await patch(o, `/data-models/${out.shipsModelId}/records/${shipRowId}`, patchBody);
        if ('host_passengers' in patchBody) provisioning.push(`synced host_passengers=${hostPassengers} onto Ships row "${o.ship.name}"`);
        if ('ssh_public_key' in patchBody) provisioning.push(`synced ssh_public_key onto Ships row "${o.ship.name}"`);
        if ('owner_id' in patchBody) provisioning.push(`recorded owner on Ships row "${o.ship.name}"`);
      }
    } else if (mine.length === 0) {
      const created = await post<{ id: string }>(o, `/data-models/${out.shipsModelId}/records`, {
        name: o.ship.name,
        ...(o.ship.platform ? { platform: o.ship.platform } : {}),
        host_passengers: hostPassengers,
        ...(sshPublicKey !== undefined ? { ssh_public_key: sshPublicKey } : {}),
        ...(ownerId !== undefined ? { owner_id: ownerId } : {}),
        ...(writeMachineId ? { machine_id: machineId } : {}),
      });
      shipRowId = created.id;
      out.shipRow = { id: shipRowId, name: o.ship.name, action: 'created', matchedBy };
      provisioning.push(`created Ships row "${o.ship.name}"`);
    } else {
      problems.push(
        matchedBy === 'machine_id'
          ? `${mine.length} Ships rows carry this machine's id — which one is this machine?`
          : `${mine.length} Ships rows named "${o.ship.name}" — which one is this machine?`,
      );
    }
  }

  // The Agent record each newly-provisioned Crew row should point at
  // (ISSUE-416's `agent_id`, same field `agents.ts`'s `linkCrewSeats`
  // fills for an existing seat) — looked up once, only when a new Crew row
  // might actually get created below. `Agents` is a workspace-scoped system
  // table (ISSUE-465, `client.dataModels.get('agents', workspaceId)` in
  // agents.ts), not one of this project's own data models, so it is looked
  // up by its fixed tableName rather than through `find()` above.
  let agentIdFor: (role: RoleName) => string | undefined = () => undefined;
  if (shipRowId) {
    try {
      const agentsModel = await get<{ id: string }>(o, `/data-models/agents?workspaceId=${ws.id}`);
      const agentRows = await get<Array<{ id: string; name?: string | null }>>(
        o, `/data-models/${agentsModel.id}/records?limit=200`,
      );
      agentIdFor = (role) => agentRows.find((r) => r.name === PERSONA_NAME[role])?.id;
    } catch {
      // No Agents table yet, or unreadable — the Crew row still gets
      // created below, just without an agent_id; `crew agents sync` links
      // it the first time someone runs that.
    }
  }

  if (out.models.crew) {
    const rows = await get<Array<{ id: string; name?: string | null; email?: string | null; ship_id?: string | null; user_id?: string | null; agent_id?: string | null }>>(
      o, `/data-models/${out.models.crew}/records?limit=200`,
    );
    // A dry run writes nothing, so `shipRowId` stays unset above even for a
    // machine that already has a Ships row. Resolve that row read-only, only
    // to scope the seat lookup (CREW-2471): without it a provisioned machine's
    // dry run would report its own seats as `would-create`. Only an
    // unambiguous match counts; none (or several) leaves this unset.
    let seatShipId = shipRowId;
    if (!seatShipId && o.dryRun && o.ship && out.shipsModelId) {
      try {
        const shipRows = await get<Array<{ id: string; name?: string | null; machine_id?: string | null }>>(
          o, `/data-models/${out.shipsModelId}/records?limit=200`,
        );
        const byId = o.ship.machineId ? shipRows.filter((r) => r.machine_id === o.ship!.machineId) : [];
        const mineRows = byId.length > 0 ? byId : shipRows.filter((r) => (r.name ?? '').trim() === o.ship!.name.trim() && !r.machine_id);
        if (mineRows.length === 1) seatShipId = mineRows[0]!.id;
      } catch { /* unreadable Ships table: treated as no row yet */ }
    }
    // Without a resolved ship only legacy rows (no `ship_id`) are candidates:
    // a row carrying another ship's id is another machine's seat and never
    // this one's (CREW-2471). A workspace with no Ships table has no
    // `ship_id` on any row, so this is the old workspace-wide search there.
    const scoped = seatShipId ? rows.filter((r) => r.ship_id === seatShipId) : rows.filter((r) => !r.ship_id);
    // A row with no `ship_id` predates multi-machine support and implicitly
    // represents a single shared instance (see the ticket's own framing,
    // ISSUE-610) — claimed by name the first time a real ship connects and
    // finds one, rather than left to be duplicated by a fresh create below.
    const unclaimed = seatShipId ? rows.filter((r) => !r.ship_id) : [];

    for (const role of ['dev', 'design', 'qa', 'triage'] as const) {
      const searchTerm = role === 'dev' ? 'develop' : role;
      let id = seatFor(scoped, searchTerm);
      let seatAction: 'matched' | 'claimed' | 'created' | 'would-create' = 'matched';
      if (!id && seatShipId && !shipRowId) {
        // Dry run against an existing Ships row: preview what a real run does.
        const legacyId = seatFor(unclaimed, searchTerm);
        if (legacyId) {
          id = legacyId;
          seatAction = 'claimed';
        }
      } else if (!id && shipRowId) {
        const legacyId = seatFor(unclaimed, searchTerm);
        if (legacyId) {
          await patch(o, `/data-models/${out.models.crew}/records/${legacyId}`, { ship_id: shipRowId });
          id = legacyId;
          seatAction = 'claimed';
          provisioning.push(`claimed existing Crew row for the ${role} seat`);
        } else {
          const created = await post<{ id: string }>(o, `/data-models/${out.models.crew}/records`, {
            name: `${PERSONA_NAME[role]} agent`,
            ship_id: shipRowId,
            ...(agentIdFor(role) ? { agent_id: agentIdFor(role) } : {}),
          });
          id = created.id;
          seatAction = 'created';
          provisioning.push(`created Crew row for the ${role} seat`);
        }
      }
      if (id) {
        out.seats[role] = id;
        const rowShip = rows.find((r) => r.id === id)?.ship_id ?? shipRowId ?? undefined;
        (out.seatRows ??= []).push({ role, id, action: seatAction, ...(rowShip ? { shipId: rowShip } : {}) });
      } else if (o.dryRun && o.ship && out.shipsModelId) {
        // Nothing qualifies and a real run would create the row: preview it
        // rather than reporting a problem or a false match. No id exists yet.
        (out.seatRows ??= []).push({ role, id: '', action: 'would-create' });
      } else problems.push(`no Crew row looking like the ${role} seat — create one, or omit that role`);
    }
    // `pair` is optional and best-effort, unlike the four polled seats above:
    // a workspace with no interactive-session row yet is not a problem, just
    // one `crew agents sync` cannot link a persona to. Stored the same way
    // (`out.seats.pair`) so `crew agents sync`'s existing seat-linking loop
    // needs no `pair`-specific code — `configuredMembers()` (config.ts) is
    // what reclassifies this one row as a HOLD rather than a seat, since a
    // ticket Pair is working must stay off-limits to the polled seats the
    // same way one a person is driving does. Never claimed or created
    // (unlike the four polled seats): an interactive session's own row is
    // a person's to place, not this command's.
    const pairId = seatFor(scoped, 'pair') || (seatShipId ? seatFor(unclaimed, 'pair') : undefined);
    if (pairId) out.seats.pair = pairId;
    // The per-ship "Release" row (CREW-1371 D5): release-phase comments and
    // failure tickets are written as this row, not the Developer agent. Only
    // ever scoped to this ship — an unscoped "Release" row would be shared by
    // every machine on the workspace, which is the very thing this avoids.
    // Found-or-created like the polled seats, but never claimed from a legacy
    // unscoped row and never given an agent_id: it has no persona to link.
    if (shipRowId) {
      const releaseId = seatFor(scoped, 'release');
      if (releaseId) out.releaseSeat = releaseId;
      else {
        const created = await post<{ id: string }>(o, `/data-models/${out.models.crew}/records`, {
          name: 'Release agent',
          ship_id: shipRowId,
        });
        out.releaseSeat = created.id;
        provisioning.push('created Crew row for the release seat');
      }
    }
    // Anything that is not one of the seats is a person or a session: a hold.
    // The release row is not a seat, but it is not a person either — leaving
    // it out of this set would list it as a hold the poll loop then respects.
    const seatIds = new Set([...Object.values(out.seats), ...(out.releaseSeat ? [out.releaseSeat] : [])]);
    const holdRows = rows.filter((r) => !seatIds.has(r.id));
    out.holds = holdRows.map((r) => ({ id: r.id, name: r.name ?? '', email: r.email, user_id: r.user_id }));
    out.crewModelId = out.models.crew;
    // Operator candidates are people (CREW-2423): a row with an agent, or a ship and
    // no linked member, belongs to a machine (whichever ship). Only this list changes; the
    // hold semantics above are what the poll loop relies on.
    const people = holdRows.filter((r) => !r.agent_id && (!r.ship_id || !!r.user_id));
    // Workspace members, best effort: maps a row's user_id to its person and
    // email. The endpoint may predate `identityId`; absent, only the direct
    // membership and email matches below apply.
    const members = new Map<string, { identityId?: string; email?: string }>();
    try {
      const list = await get<Array<{ id?: string; userId?: string; identityId?: string; email?: string }>>(
        o, `/workspaces/${out.workspaceId}/members`,
      );
      for (const m of Array.isArray(list) ? list : []) {
        const key = m.id ?? m.userId;
        if (key) members.set(key, { identityId: m.identityId, email: m.email });
      }
    } catch { /* a plain member may not list members — not fatal */ }
    // CREW-2431: the `operator_row` event shows the matched row's email, which
    // for a row linked to a member but carrying no email of its own is the member's.
    for (const h of out.holds) {
      const e = h.user_id ? members.get(h.user_id)?.email : undefined;
      if (e) h.memberEmail = e;
    }
    out.candidates = people.map((r) => ({
      id: r.id, name: r.name ?? '', email: r.email, user_id: r.user_id,
      detail: r.email || (r.user_id ? members.get(r.user_id)?.email : undefined) || undefined,
    }));
    const isMine = (r: { user_id?: string | null }) =>
      !!r.user_id && (r.user_id === out.meId ||
        (!!out.meIdentityId && members.get(r.user_id)?.identityId === out.meIdentityId));
    const emailOf = (r: { email?: string | null; user_id?: string | null }) =>
      [r.email, r.user_id ? members.get(r.user_id)?.email : undefined].filter((e): e is string => !!e);
    if (!out.meId) {
      // No identity to link or create with (the `/auth/me` call failed or
      // returned none): the pre-CREW-1798 selection, which only selects.
      if (out.candidates.length === 0) problems.push('no non-seat Crew rows — which row is the operator?');
      else {
        const byEmail = out.meEmail ? people.filter((r) => emailOf(r).some((e) => eq(e, out.meEmail!))) : [];
        if (byEmail.length === 1) out.operator = byEmail[0]!.id;
        else if (out.candidates.length === 1) out.operator = out.candidates[0]!.id;
      }
    } else {
      // A row linked to a different person is someone else's: never a
      // candidate, never overwritten (CREW-1798).
      const candidates = people.filter((r) => !r.user_id || isMine(r));
      const mine = people.find(isMine);
      const byEmail = out.meEmail ? candidates.filter((r) => emailOf(r).some((e) => eq(e, out.meEmail!))) : [];
      const unlinked = people.filter((r) => !r.user_id);
      const only = candidates.length === 1 && unlinked.length === 1 ? candidates[0] : undefined;
      const pick = mine ?? (byEmail.length === 1 ? byEmail[0] : only);
      if (pick) {
        out.operator = pick.id;
        out.operatorAction = isMine(pick) ? 'matched' : 'linked';
        // Like the Ships/Crew provisioning above, writes need a `ship`: a bare
        // `discover()` stays a read-only lookup.
        if (!isMine(pick) && o.ship) await linkOperatorRow(o, out, pick);
      } else {
        out.operatorCompared =
          `signed in as ${out.meEmail ?? 'unknown email'} (identity ${out.meIdentityId ?? out.meId}); ` +
          (people.length === 0 ? 'no person rows in the Crew table' : people.map((r) => {
            const m = r.user_id ? members.get(r.user_id) : undefined;
            return `"${r.name || 'unnamed row'}" <${r.email ?? 'no email'}>` +
              (r.user_id ? ` linked to member ${m?.email ?? r.user_id}${m?.identityId ? ` (identity ${m.identityId})` : ''}` : ' unlinked');
          }).join('; '));
        if (o.ship && (!o.interactive || candidates.length === 0)) await createOperatorRow(o, out);
      }
    }
  }
  return out;
}

/**
 * Writes this key's identity onto an existing Crew row (`user_id`, and `email`
 * when blank) so UI comments from the operator resolve to them (CREW-1798).
 * A 403 is reported in `provisioning` and the row is still the operator —
 * connect completes either way (CREW-1797's principle).
 */
export async function linkOperatorRow(
  o: AuthOptions & { dryRun?: boolean },
  found: Discovered,
  row: { id: string; name?: string | null; email?: string | null },
): Promise<void> {
  const name = row.name || row.id;
  if (!found.meId || !found.crewModelId) return;
  if (o.dryRun) {
    found.provisioning.push(`would link Crew row "${name}" to your account`);
    return;
  }
  const body: Record<string, unknown> = { user_id: found.meId };
  if (!row.email && found.meEmail) body.email = found.meEmail;
  try {
    await patch(o, `/data-models/${found.crewModelId}/records/${row.id}`, body);
    found.provisioning.push(`linked Crew row "${name}" to your account`);
  } catch (e) {
    if (!(e instanceof ConnectHttpError) || e.status !== 403) throw e;
    found.provisioning.push(
      `could not link your Crew row (no write access) — ask a workspace admin to set user_id on "${name}"`,
    );
  }
}

/**
 * Creates the operator's own Crew row — a person's row, with no ship or agent
 * — from `/auth/me`, and makes it `found.operator` (CREW-1798). A 403 is
 * reported and leaves the operator unset, as before this existed.
 */
export async function createOperatorRow(o: AuthOptions & { dryRun?: boolean }, found: Discovered): Promise<void> {
  if (!found.meId || !found.crewModelId) return;
  const name = found.meName || found.meEmail || 'Operator';
  if (o.dryRun) {
    found.provisioning.push(`would create Crew row "${name}" for you`);
    // CREW-2573: accounted for, even though no row exists to point `operator` at.
    found.operatorAction = 'would-create';
    return;
  }
  try {
    const created = await post<{ id: string }>(o, `/data-models/${found.crewModelId}/records`, {
      name, ...(found.meEmail ? { email: found.meEmail } : {}), user_id: found.meId,
    });
    found.operator = created.id;
    found.operatorAction = 'created';
    found.holds.push({ id: created.id, name, email: found.meEmail, user_id: found.meId });
    found.candidates.push({ id: created.id, name, email: found.meEmail, user_id: found.meId, detail: found.meEmail });
    found.provisioning.push(`created Crew row "${name}" for you`);
  } catch (e) {
    if (!(e instanceof ConnectHttpError) || e.status !== 403) throw e;
    found.provisioning.push('could not create your Crew row (no write access) — ask a workspace admin to add one with your user_id');
  }
}

/**
 * A paste-ready route block — everything a person still has to author.
 *
 * The ids `discover()` found are NOT in here: they go straight into
 * `<stateDir>/resolved/<workspace>/<project>.json` (see `resolvedPathFor` in
 * config.ts), written by the caller, not pasted by hand.
 */
export function renderConnection(
  d: Discovered,
  route: string,
  dir: string | null,
  opts: {
    area?: string; apiKeyFile?: string; apiKeyVar?: string; keychainBacked?: boolean;
    /** Real values for the first-run wizard's written file (CREW-1286), where nothing is left for a person to paste over. */
    baseUrl?: string; hostPassengers?: boolean;
  } = {},
): string {
  // ISSUE-966: a device-login run whose key made it into the OS keychain
  // (freshly minted or reused from an earlier `crew connect`/`tablation
  // login`) needs neither field at all — `hydrateApiKeys` (config.ts)
  // resolves it from there on every future `crew` run, keyed by this
  // route's own baseUrl host + workspace slug. Only when that key had
  // nowhere else to live (no keychain support on this platform, or the
  // store's `set` itself failed) does `apiKeyFile`/`apiKeyVar` get a real
  // value — printed verbatim instead of the usual paste-your-own-key
  // placeholder, since a person supplying `--key` by hand never gets one
  // written for them and still has to say where their key lives.
  const apiKeyFileLine = opts.keychainBacked
    ? ''
    : opts.apiKeyFile
      ? `    apiKeyFile: "${opts.apiKeyFile}"`
      : `    apiKeyFile: "REPLACE — a file holding this workspace's key"`;
  const apiKeyVarLine = opts.keychainBacked
    ? ''
    : opts.apiKeyVar
      ? `\n    apiKeyVar: ${opts.apiKeyVar}`
      : `\n    apiKeyVar: REPLACE_KEY_VAR`;
  // A default baseUrl is left out of a file a person maintains; `loadConfig` falls back to it.
  const baseUrlLine = opts.baseUrl
    ? opts.baseUrl.replace(/\/+$/, '') === DEFAULT_BASE_URL ? '' : `    baseUrl: "${opts.baseUrl}"\n`
    : '    baseUrl: "REPLACE — the same baseUrl as your other routes"\n';
  const keyLines = [apiKeyFileLine, apiKeyVarLine.replace(/^\n/, '')].filter(Boolean).join('\n');
  return `  - route: ${route}
    enabled: false          # set to true once \`crew doctor\` is green
${opts.area ? `    area: "${opts.area}"\n` : ''}${dir === null ? '' : `    dir: "${dir}"\n`}${baseUrlLine}${opts.hostPassengers ? '    hostPassengers: true\n' : ''}${keyLines ? keyLines + '\n' : ''}`;
}


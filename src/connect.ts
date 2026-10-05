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

import { DEFAULT_CONTRACT } from './contract.ts';
import { PERSONA_NAME } from './agents.ts';
import type { RoleName } from './config.ts';

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
  ship?: { name: string; platform?: string; hostPassengers?: boolean; sshPublicKey?: string };
  /**
   * Same meaning as everywhere else in the CLI: report what discovery would
   * do without writing anything. Provisioning (the `ship` option above) is
   * entirely skipped under a dry run, same as the resolved-state and
   * API-key files `cli.ts`'s `connect` case writes — this function makes no
   * network POST/PATCH calls at all when set.
   */
  dryRun?: boolean;
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
  /** This key's own identity id, from the same `/auth/me` call — written onto the Ships row as `owner_id` (CREW-1286). */
  meId?: string;
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

/** One template on the platform-wide Tablation Library (`GET /library-templates` — no `workspaceId`, every published template is visible from anywhere). */
export interface LibraryTemplateOption {
  id: string;
  name: string;
  /** Stable dotted-lowercase handle (e.g. `crew.issues`) — unlike `name`, never freely edited, so this is what a caller should match on, not the display name. */
  identifier: string;
}

/**
 * `LibraryTemplate.identifier` of the "Issues" tracker template that `crew
 * connect <workspace>` defaults a bare (no `--project`) connect to —
 * matched on this stable handle rather than the freely-editable display
 * name (ISSUE-967).
 */
export const ISSUES_TEMPLATE_IDENTIFIER = 'crew.issues';

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
  const provisioning: string[] = [];
  // `GET /workspaces/:idOrSlug` resolves either form to the real uuid — the
  // rest of this function, and everything downstream, works in ids only.
  const ws = await get<{ id: string; slug: string; name?: string }>(o, `/workspaces/${o.workspace}`);
  const out: Discovered = {
    workspaceId: ws.id, workspaceSlug: ws.slug, workspaceName: ws.name,
    models: {}, seats: {}, holds: [], problems, provisioning,
  };

  // Own role, not anyone else's — `/auth/me` derives it the same way for an
  // API key as for a session, and is the only "am I an admin here" a plain
  // member's own key can ask without a 403 (no admin-only membership list).
  try {
    const me = await get<{ role?: string; email?: string; id?: string }>(o, `/auth/me?workspaceId=${ws.id}`);
    out.role = me.role;
    out.meEmail = me.email;
    out.meId = me.id;
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
    // a renamed/reslugged install of `crew.issues` still counts), falling
    // back to slug `issues` (a hand-built or pre-identifier project). Tried
    // before the multi-project picker below, not instead of it: a default
    // candidate that doesn't actually qualify (missing tables) falls
    // through to the same picker/install-offer as if none was named.
    const defaultCandidate = projects.find((p) => p.sourceTemplateId === ISSUES_TEMPLATE_IDENTIFIER)
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
      owner_id?: string | null;
    }>>(
      o, `/data-models/${out.shipsModelId}/records?limit=200`,
    );
    const mine = shipRows.filter((r) => (r.name ?? '').trim() === o.ship!.name.trim());
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
    let ownerId: string | undefined;
    if (out.meId) {
      let hasOwnerColumn = false;
      try {
        const shipsModel = await get<{ fields?: Array<{ columnName: string }> }>(o, `/data-models/${out.shipsModelId}`);
        hasOwnerColumn = (shipsModel.fields ?? []).some((f) => f.columnName === 'owner_id');
      } catch { /* unreadable field metadata reads as "column absent" */ }
      if (hasOwnerColumn) ownerId = out.meId;
      else provisioning.push('could not record the ship owner — the Ships table has no owner_id column yet (update the Issues template)');
    }
    if (mine.length === 1) {
      shipRowId = mine[0]!.id;
      const patchBody: Record<string, unknown> = {};
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
      });
      shipRowId = created.id;
      provisioning.push(`created Ships row "${o.ship.name}"`);
    } else {
      problems.push(`${mine.length} Ships rows named "${o.ship.name}" — which one is this machine?`);
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
    const rows = await get<Array<{ id: string; name?: string | null; email?: string | null; ship_id?: string | null }>>(
      o, `/data-models/${out.models.crew}/records?limit=200`,
    );
    // Unscoped (old behaviour) unless a ship actually resolved above.
    const scoped = shipRowId ? rows.filter((r) => r.ship_id === shipRowId) : rows;
    // A row with no `ship_id` predates multi-machine support and implicitly
    // represents a single shared instance (see the ticket's own framing,
    // ISSUE-610) — claimed by name the first time a real ship connects and
    // finds one, rather than left to be duplicated by a fresh create below.
    const unclaimed = shipRowId ? rows.filter((r) => !r.ship_id) : [];

    for (const role of ['dev', 'design', 'qa', 'triage'] as const) {
      const searchTerm = role === 'dev' ? 'develop' : role;
      let id = seatFor(scoped, searchTerm);
      if (!id && shipRowId) {
        const legacyId = seatFor(unclaimed, searchTerm);
        if (legacyId) {
          await patch(o, `/data-models/${out.models.crew}/records/${legacyId}`, { ship_id: shipRowId });
          id = legacyId;
          provisioning.push(`claimed existing Crew row for the ${role} seat`);
        } else {
          const created = await post<{ id: string }>(o, `/data-models/${out.models.crew}/records`, {
            name: `${PERSONA_NAME[role]} agent`,
            ship_id: shipRowId,
            ...(agentIdFor(role) ? { agent_id: agentIdFor(role) } : {}),
          });
          id = created.id;
          provisioning.push(`created Crew row for the ${role} seat`);
        }
      }
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
    // same way one a person is driving does. Never claimed or created
    // (unlike the four polled seats): an interactive session's own row is
    // a person's to place, not this command's.
    const pairId = seatFor(scoped, 'pair') || (shipRowId ? seatFor(unclaimed, 'pair') : undefined);
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
    // No email match (or no email on file) but only one candidate anyway —
    // same "exactly one, no ambiguity" reasoning as the email match above,
    // just without needing an email at all (CREW-978: this is the case a
    // fresh non-interactive `connect` hit with no previous resolved file —
    // one hold, no email match, nowhere to ask — and wrote a route with no
    // `operator` at all rather than picking the only row it could mean).
    if (!out.operator && out.holds.length === 1) out.operator = out.holds[0]!.id;
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
export function renderConnection(
  d: Discovered,
  route: string,
  dir: string,
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
    ? `    # apiKey: resolved automatically from the OS keychain (crew connect) — no apiKeyFile needed`
    : opts.apiKeyFile
      ? `    apiKeyFile: "${opts.apiKeyFile}"`
      : `    apiKeyFile: "REPLACE — a file holding this workspace's key"`;
  const apiKeyVarLine = opts.keychainBacked
    ? ''
    : opts.apiKeyVar
      ? `\n    apiKeyVar: ${opts.apiKeyVar}`
      : `\n    apiKeyVar: REPLACE_KEY_VAR`;
  return `  - route: ${route}
    enabled: false          # arm it deliberately, once doctor is green
${opts.area ? `    area: "${opts.area}"\n` : ''}    dir: "${dir}"
    # worktreePrefix: omitted — each repo derives its own from its checkout's
    # directory name (ISSUE-400). Only set this if every repo this route
    # serves genuinely wants the SAME prefix, which is rare once an area has
    # more than one repo.
    # What a host must be to build this — unix, macos, linux, or windows —
    # belongs in each repo's own .crew.yaml, not here (see docs/REPO_SPEC.md).
    baseUrl: ${opts.baseUrl ? `"${opts.baseUrl}"` : '"REPLACE — the same baseUrl as your other routes"'}
${opts.hostPassengers ? '    hostPassengers: true\n' : ''}${apiKeyFileLine}${apiKeyVarLine}
`;
}

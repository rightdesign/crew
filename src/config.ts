/**
 * crew.yaml — what this ship is, and what it is connected to.
 *
 * Two levels, because a ship is not a project (CREW_PRD §1.1, §15):
 *
 *   ship:   facts about this machine — the agent binary, the shell its hooks
 *           are written for, where state and logs go. One per file.
 *   routes: one entry per project this ship works. A **route** is
 *           `workspace/project` — one slice of one work source, bound to one
 *           local directory — and a machine may hold many at once.
 *
 * IDS ARE RESOLVED, NOT AUTHORED. A route names its workspace and project as
 * one slug pair; the uuids for the tracker's data models and the crew's rows
 * are discovered from that project and cached in the STATE tree, at
 * `<stateDir>/resolved/<workspace>/<project>.json` (`resolvedPathFor`,
 * below) — not in this file. `crew connect` (ISSUE-285) is what writes that
 * cache; it may also be filled in by hand. Keeping it out of `crew.yaml`
 * entirely, rather than in a distinct block within it, means the file a
 * person actually authors and diffs never carries ids that are derivable and
 * regenerable, and that nothing under it should be edited to change
 * behaviour, on its face.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute, join, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { parse } from 'yaml';
import {
  hostPlatform, isShipPlatform,
  type ShipPlatform,
} from './platform.ts';
import {
  MODES as RELEASE_MODES, PROVIDERS as CI_PROVIDERS, MATCHES as VERIFY_MATCHES, VERSIONINGS,
  type ReleaseMode, type CiProvider, type VerifyMatch, type Versioning, type BranchNaming,
} from './repo-config.ts';

/**
 * Where a route talks to when nothing more specific says otherwise.
 *
 * Every route this crew has ever served has pointed here — a self-hosted or
 * otherwise different tracker is the override, not the common case — so a
 * `crew.yaml` that omits `baseUrl` entirely (at both route and ship level)
 * gets this rather than a hard config error.
 */
export const DEFAULT_BASE_URL = 'https://app.tablation.com';

/**
 * Where a repo's checkout lives when `repos:` doesn't say so explicitly —
 * `<reposBasePath>/<workspace>/<repoName>`. `repos:` stays for the repos
 * that live somewhere else (an existing checkout, a shared location), but a
 * route no longer has to enumerate every repo its area covers just to be
 * usable: anything the tracker's own `Repos` table knows about that isn't
 * named here falls through to this convention, and gets cloned into it on
 * demand if nothing is there yet (see `ensureRepoCheckout` in git.ts).
 */
export const DEFAULT_REPOS_BASE_PATH = '~/Crew';

export type RoleName = 'dev' | 'design' | 'qa' | 'triage' | 'pair';
/**
 * `pair` is deliberately last, and deliberately never added to any of the
 * polling order arrays in select.ts/cli.ts (`['qa','triage','dev','design']`
 * and friends) — it is an interactive human-driven session, never a seat the
 * fleet picks up work for on its own. It rides ROLE_NAMES only so its Agents
 * row gets created/kept in sync the same way the four polled seats' do.
 */
export const ROLE_NAMES: RoleName[] = ['dev', 'design', 'qa', 'triage', 'pair'];
export const ROLE_LABEL: Record<RoleName, string> = {
  dev: 'Dev', design: 'Design', qa: 'QA', triage: 'Triage', pair: 'Pair',
};

export interface HoldConfig { id: string; role?: string }

/** The ids a route discovers from its project. Regenerable; never authored. */
export interface ResolvedIds {
  workspaceId: string;
  projectId?: string;
  /** The `Projects` table, and the row this route's `area` names. */
  areaModelId?: string;
  areaId?: string;
  /** The `Repos` table, and repo id -> name, so a ticket's repo resolves. */
  reposModelId?: string;
  repoNames?: Record<string, string>;
  /**
   * The `Repos` table's own `remote` column (`owner/repo`, GitHub-shaped),
   * keyed the same as `repoNames` — what `defaultRepoDir`'s auto-clone
   * clones from when a repo's derived checkout doesn't exist yet locally.
   */
  repoRemotes?: Record<string, string>;
  /**
   * The `Ships` table, when this workspace has one. The ship is matched by
   * NAME (`ship.name`) rather than by a stored id: a machine's name is what
   * an operator recognises on the board, and it is stable enough in practice.
   */
  shipsModelId?: string;
  /** The `Epics` table, when this workspace has one (ISSUE-384). */
  epicsModelId?: string;
  /**
   * The `Locks` table, when this workspace has one (ISSUE-394) — rows this
   * route's ships CAS against for cross-machine exclusion (the release
   * lock today; ISSUE-395's ticket-claim lock will share the mechanism).
   * Optional like Ships and Epics: a workspace without one just keeps the
   * local-only pid lock it always had.
   */
  locksModelId?: string;
  models: { issues: string; comments: string; crew: string };
  seats: Partial<Record<RoleName, string>>;
  operator: string;
  holds: HoldConfig[];
  /**
   * What this workspace's own status/priority/severity choices mean — see
   * `contract.ts`. Workspace data, same as everything else in this file: it
   * describes choices made on the tracker (a status renamed, a new terminal
   * status added), not anything about this machine, so it belongs in the
   * discovered state tree rather than requiring a person to hand-maintain a
   * copy in `crew.yaml` every time the workspace's own choices change.
   */
  contract?: Partial<import('./contract.ts').Contract>;
  /**
   * The workspace Agents-table row backing each of crew's four personas, and
   * the row `updated_at` `crew agents sync` (agents.ts) last wrote itself —
   * ISSUE-416. Absent entirely until that command has been run once; a role
   * missing from the map just hasn't been synced yet. `lastSyncedUpdatedAt`
   * is what makes a later sync's divergence check possible: if the row's
   * current `updated_at` no longer matches, a workspace admin edited the
   * prompt since crew last wrote it, and the sync must not clobber that.
   *
   * `historyId` (ISSUE-377/529) is the Agents row's own version-history
   * entry id current as of the same sync that wrote `lastSyncedUpdatedAt` —
   * `agents.ts` looks it up right after establishing the row's state, so a
   * later run's `planAgentRun` can stamp `prompt_version` on its Agent Log
   * row without a network call of its own. Absent when the sync's history
   * lookup itself failed (best-effort, same as everything else here) or
   * predates this field.
   */
  agentPersonas?: Partial<Record<RoleName, { agentId: string; lastSyncedUpdatedAt: string; historyId?: string }>>;
}

export interface Route {
  /**
   * `workspace-slug/project-slug` — the work source, addressed the same way
   * `crew connect` takes it. This is the route's own identity: what `crew run
   * <route>` matches, what names its log lines, and what keys its state file
   * (`resolvedPathFor`) — there is no separate `name:` to keep in sync with
   * it.
   */
  route: string;
  /**
   * Which row of the work source's `Projects` table this route works — one
   * *area of development*, named rather than numbered.
   *
   * Note the deliberate word: the route's own project (half of `route`
   * above) is the **Tablation project** that contains the tracker's tables,
   * while `area` is a **row in the Projects table inside it**. Both are
   * called "project" in conversation and they are not the same thing; a
   * route binds one area to one checkout, and a ship holds many such routes.
   *
   * Omit it and the route sees every ticket, whatever its area — which is
   * right for a tracker that has not been sliced.
   */
  area?: string;
  /** Per-route interlock: this one route polls and runs. */
  enabled: boolean;
  /**
   * How fast this route's aging (ISSUE-383) erodes an unpicked ticket's
   * rank toward 0 — "the operator maintains steering of their ship" (Brad),
   * ranking their own commitments rather than a property of the board.
   * Undefined means 1 (pure aging, the documented default). A SCALAR on the
   * RATE, never on the rank itself: to stop a route's work being picked at
   * all, disable it — `weight` cannot starve one, only make its work
   * surface less often.
   */
  weight?: number;
  /**
   * The checkout this route works, when its area has exactly one repo. Kept
   * for the common case; `repos` is what a multi-repo area needs.
   */
  dir: string;
  /**
   * Repo name (as the tracker's `Repos` table calls it) -> local checkout.
   *
   * An area has many repos (ISSUE-331), and each needs its own directory on
   * this machine. A ticket names its repo; this is how the crew turns that
   * into a path. Without it a ticket for a second repo would be worked in the
   * first one's checkout, which is the failure `crew connect` refuses by
   * verifying a repo's remote against the local origin.
   */
  repos: Record<string, string>;
  /**
   * Resolved: route's own `reposBasePath:` if given, else the ship's, else
   * `DEFAULT_REPOS_BASE_PATH` — always has a value, never re-derived at a
   * call site. Used for any repo `repos` doesn't explicitly place; see
   * `DEFAULT_REPOS_BASE_PATH`'s own doc comment.
   */
  reposBasePath: string;
  /**
   * A ship-level fallback for repos on this route that declare no
   * `worktrees.prefix` of their own (ISSUE-350). Optional: a route that
   * says nothing lets every repo fall through to its own derived default
   * instead of this one value overriding all of them regardless of which
   * repo it actually fits (ISSUE-400).
   */
  worktreePrefix?: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyFile?: string;
  apiKeyVar?: string;
  hooks: { test?: string; build?: string; deploy?: string; notify?: string };
  labels: { test?: string; build?: string; deploy?: string };
  /**
   * Release settings the SHIP declares for a repo that has no `.crew.yaml`.
   * Every field undefined when nothing was declared — a synthesised default
   * here would be passed on as though the operator had written it, and would
   * silently shadow the repo's own contract. Mirrors
   * `Partial<RepoConfig['release']>` (see `ShipRepoSettings` in
   * repo-config.ts) field for field, since that is exactly what this becomes
   * once `resolveRepoConfig` merges it with a repo's own `.crew.yaml`.
   */
  release: {
    mode?: ReleaseMode;
    ci?: { provider?: CiProvider; ref?: string };
    verify?: { match?: VerifyMatch; timeoutSeconds?: number; intervalSeconds?: number };
    versioning?: Versioning;
    versionFiles?: string[];
    changelog?: string;
    tag?: string;
    tagPattern?: string;
  };
  /**
   * A ship-level fallback for a repo that has no `.crew.yaml` of its own —
   * same shape and same reasoning as `release` above (mirrors
   * `ShipRepoSettings['branch']` in repo-config.ts field for field). A repo
   * synced some OTHER way than the tracker's own naming convention (a
   * Synology-shared checkout, say, where `master` is the real base and
   * always will be) has no reason to also carry a `.crew.yaml` just to say
   * one field — this is that one field, on the ship.
   */
  branch?: Partial<BranchNaming>;
  /**
   * Per-repo overrides of `hooks`/`labels`/`release`/`branch`, keyed the same
   * as `repos` — a hook is a fact about a REPO (its test/build/deploy
   * commands, its release mode, its base branch), not about the route, and a
   * route with several repos of wildly different tooling (a multi-repo area)
   * had no way to say that other than giving every one of them the same
   * commands or pushing each into its own `.crew.yaml`. Authored as `repos:
   * <name>: { dir, hooks, labels, release, branch }` instead of a bare dir
   * string; a name absent here (or a bare-string repo) falls straight
   * through to the route-wide `hooks`/`labels`/`release`/`branch` above.
   * Still only a FALLBACK at every level — a repo's own `.crew.yaml` wins
   * over this, which wins over the route-wide block, which wins over the
   * built-in default.
   */
  repoOverrides: Record<string, {
    hooks?: { test?: string; build?: string; deploy?: string; notify?: string };
    labels?: { test?: string; build?: string; deploy?: string };
    release?: Route['release'];
    branch?: Partial<BranchNaming>;
  }>;
  /**
   * This workspace's own rules, where they differ from the default (see
   * docs/CONTRACT.md). Absent means the workspace means what the unmodified
   * Issue Tracker template means. Belongs per route, not per ship: one
   * machine may serve several workspaces with different conventions.
   */
  contract?: Partial<import('./contract.ts').Contract> | null;
  resolved?: ResolvedIds;
  /**
   * Where this route's four prompt files (`common.md` + `lane-<role>.md`)
   * actually live — always resolved to a real directory, never re-derived
   * at a call site (same convention as `reposBasePath`). Comes from the
   * route's own `promptSet:` (a bare name resolves under
   * `<crewHome>/prompts/`, a path is expanded relative to this route's
   * config the same way `apiKeyFile` is); absent `promptSet` falls
   * through to `<crewHome>/prompts/default`, which is what every route
   * used unconditionally before per-route prompt sets existed. This is
   * per-ROUTE, not per-ship, for the same reason `contract` above is: one
   * machine may
   * serve several workspaces, each with its own process — a design-gated
   * three-lane flow for one, a plain dev+QA flow for another — and
   * nothing about which prompt policy a workspace wants is a fact about
   * this machine.
   */
  promptsDir: string;
}

export interface Ship {
  name: string;
  platform: ShipPlatform;
  agent: { bin: string; model: string };
  shell?: string;
  extraPath?: string;
  useNvm: boolean;
  nvmSh?: string;
  stateDir: string;
  logFile: string;
  userAgent: string;
  /**
   * How many agent sessions this machine will run at once (ISSUE-381).
   *
   * A fact about this machine's capacity, not about any board — role
   * queues are already disjoint by construction (`sliceFor`), so raising
   * this only ever lets two DIFFERENT roles overlap, never two of the same
   * one. Default 2: dev/design building while QA verifies is the case that
   * was actually measured costing idle time (ISSUE-353: QA sat behind a
   * 68-minute dev session that held the ship's one lock).
   */
  maxConcurrentAgents: number;
  /**
   * How many days of `<stateDir>/streams` artifacts (ISSUE-401 — the raw
   * `stream-json` NDJSON, its mapped events, and per-run sidecars) to keep
   * before the sweep deletes them. Default 7, same reasoning as the
   * shared `events.jsonl` retention: unbounded per-run capture on a
   * machine that runs agents constantly becomes real disk with no owner.
   */
  streamRetentionDays: number;
}

export interface CrewConfig {
  ship: Ship;
  routes: Route[];
  crewHome: string;
  configFile: string;
  /**
   * Routes that failed to parse and were dropped (ISSUE tbd) — a bad key or
   * missing field in one route's block used to `process.exit` the whole
   * ship, taking every OTHER route down with it. One malformed route is now
   * that route's own problem: it's excluded from `routes` and reported here
   * so the caller can warn loudly without refusing to start. Empty unless
   * something was actually dropped.
   */
  warnings: string[];
}

export class ConfigError extends Error {}

const SHIP_KEYS = new Set([
  'name', 'platform', 'agent', 'shell', 'extraPath', 'useNvm', 'nvmSh',
  'stateDir', 'logFile', 'userAgent', 'baseUrl', 'apiKey', 'maxConcurrentAgents', 'streamRetentionDays',
  'reposBasePath',
]);
const ROUTE_KEYS = new Set([
  'route', 'enabled', 'area', 'dir', 'repos', 'reposBasePath', 'worktreePrefix', 'weight',
  'baseUrl', 'apiKey', 'apiKeyFile', 'apiKeyVar',
  'hooks', 'labels', 'release', 'branch', 'contract', 'resolved', 'promptSet',
]);
/** What an object-shaped `repos:` entry may say, on top of the bare dir string form. */
const REPO_ENTRY_KEYS = new Set(['dir', 'hooks', 'labels', 'release', 'branch']);
const BRANCH_OVERRIDE_KEYS = new Set(['base', 'name', 'push', 'remote']);
// `versionFile` (singular) is a ship-level-only alias for a one-entry
// `versionFiles` — never accepted in a repo's own `.crew.yaml`, only here.
const RELEASE_OVERRIDE_KEYS = new Set([
  'mode', 'ci', 'verify', 'versioning', 'versionFiles', 'versionFile', 'changelog', 'tag', 'tagPattern',
]);
const CI_OVERRIDE_KEYS = new Set(['provider', 'ref']);
const VERIFY_OVERRIDE_KEYS = new Set(['match', 'timeoutSeconds', 'intervalSeconds']);

/**
 * An unknown key is an ERROR, not something to ignore — the same rule the
 * repo contract uses, and for the same reason.
 *
 * This exists because of a real mistake: removing a `hooks:` key left its
 * children (`test:`, `build:`, `deploy:`) dangling at route level, where they
 * were silently dropped. The file still LOOKED like it configured a test
 * command. Config that reads as meaningful and does nothing is worse than
 * config that is absent.
 */
function rejectUnknownKeys(obj: unknown, allowed: Set<string>, where: string, file: string): void {
  if (!obj || typeof obj !== 'object') return;
  const unknown = Object.keys(obj as object).filter((k) => !allowed.has(k));
  if (unknown.length === 0) return;
  throw new ConfigError(
    `${file}: unknown ${where} ${unknown.length === 1 ? 'key' : 'keys'}: ${unknown.join(', ')}\n` +
      `  allowed: ${[...allowed].sort().join(', ')}`,
  );
}

/**
 * A ship-level `release:` block — the route-wide one, or one repo's own
 * `repos: <name>: release:` override. Every field is genuinely optional here
 * (unlike a repo's own `.crew.yaml`, parsed by repo-config.ts's
 * `parseRepoConfig`): this is a FALLBACK, so an enum is validated when given
 * but never defaulted, and mode/hook consistency (e.g. "local needs a
 * deploy hook") is left to `validateEffective` once this is merged with
 * whatever hooks the repo actually declares.
 */
function parseReleaseOverride(raw: any, where: string, file: string): Route['release'] {
  if (!raw || typeof raw !== 'object') return {};
  rejectUnknownKeys(raw, RELEASE_OVERRIDE_KEYS, `${where}.release`, file);
  if (raw.ci !== undefined) rejectUnknownKeys(raw.ci, CI_OVERRIDE_KEYS, `${where}.release.ci`, file);
  if (raw.verify !== undefined) rejectUnknownKeys(raw.verify, VERIFY_OVERRIDE_KEYS, `${where}.release.verify`, file);

  const mode = raw.mode === undefined ? undefined : (String(raw.mode) as ReleaseMode);
  if (mode !== undefined && !RELEASE_MODES.includes(mode)) {
    throw new ConfigError(`${file}: ${where}.release.mode must be one of ${RELEASE_MODES.join('|')} (got "${raw.mode}")`);
  }
  const provider = raw.ci?.provider === undefined ? undefined : (String(raw.ci.provider) as CiProvider);
  if (provider !== undefined && !CI_PROVIDERS.includes(provider)) {
    throw new ConfigError(
      `${file}: ${where}.release.ci.provider must be one of ${CI_PROVIDERS.join('|')} (got "${raw.ci.provider}")`,
    );
  }
  const match = raw.verify?.match === undefined ? undefined : (String(raw.verify.match) as VerifyMatch);
  if (match !== undefined && !VERIFY_MATCHES.includes(match)) {
    throw new ConfigError(`${file}: ${where}.release.verify.match must be commit|version (got "${raw.verify.match}")`);
  }
  const versioning = raw.versioning === undefined ? undefined : (String(raw.versioning) as Versioning);
  if (versioning !== undefined && !VERSIONINGS.includes(versioning)) {
    throw new ConfigError(`${file}: ${where}.release.versioning must be auto|none (got "${raw.versioning}")`);
  }
  const num = (v: unknown, key: string): number | undefined => {
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) {
      throw new ConfigError(`${file}: ${where}.release.verify.${key} must be a positive number (got "${v}")`);
    }
    return n;
  };
  const timeoutSeconds = num(raw.verify?.timeoutSeconds, 'timeoutSeconds');
  const intervalSeconds = num(raw.verify?.intervalSeconds, 'intervalSeconds');
  const versionFiles: string[] | undefined = Array.isArray(raw.versionFiles)
    ? raw.versionFiles
    : raw.versionFile ? [String(raw.versionFile)] : undefined;

  return {
    mode,
    ci: (provider !== undefined || raw.ci?.ref !== undefined)
      ? { provider, ref: raw.ci?.ref !== undefined ? String(raw.ci.ref) : undefined }
      : undefined,
    verify: (match !== undefined || timeoutSeconds !== undefined || intervalSeconds !== undefined)
      ? { match, timeoutSeconds, intervalSeconds }
      : undefined,
    versioning,
    versionFiles,
    changelog: raw.changelog !== undefined ? String(raw.changelog) : undefined,
    tag: raw.tag !== undefined ? String(raw.tag) : undefined,
    tagPattern: raw.tagPattern !== undefined ? String(raw.tagPattern) : undefined,
  };
}

/**
 * A ship-level `branch:` block — the route-wide one, or one repo's own
 * `repos: <name>: branch:` override. A FALLBACK like `release` above: only
 * ever read when the repo has no `.crew.yaml` of its own to say it there
 * (repo-config.ts's `pick()`), so an absent field here must stay absent
 * rather than defaulting to `main` — that default belongs to whichever layer
 * actually resolves the effective config, not to every layer that merely
 * contributes to it.
 */
function parseBranchOverride(raw: any, where: string, file: string): Partial<BranchNaming> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  rejectUnknownKeys(raw, BRANCH_OVERRIDE_KEYS, `${where}.branch`, file);
  const base = raw.base !== undefined ? String(raw.base) : undefined;
  const name = raw.name !== undefined ? String(raw.name) : undefined;
  const push = raw.push !== undefined ? String(raw.push) : undefined;
  const remote = raw.remote !== undefined ? String(raw.remote) : undefined;
  if (base === undefined && name === undefined && push === undefined && remote === undefined) return undefined;
  return { base, name, push, remote };
}

/**
 * A repo's own `repos: <name>: release:` override, merged onto the
 * route-wide `release:` fallback field by field — same precedence as
 * `hooks`/`labels`: an override naming only `mode` still inherits the
 * route's `versionFiles`/`changelog`/etc. What `resolveRepoConfig` receives
 * as ITS ship-level fallback, in `resolvedRepos()`/`releasePhase()`.
 */
export function mergeRouteRelease(route: Route['release'], override?: Route['release']): Route['release'] {
  const provider = override?.ci?.provider ?? route.ci?.provider;
  const ref = override?.ci?.ref ?? route.ci?.ref;
  const match = override?.verify?.match ?? route.verify?.match;
  const timeoutSeconds = override?.verify?.timeoutSeconds ?? route.verify?.timeoutSeconds;
  const intervalSeconds = override?.verify?.intervalSeconds ?? route.verify?.intervalSeconds;
  return {
    mode: override?.mode ?? route.mode,
    ci: (provider !== undefined || ref !== undefined) ? { provider, ref } : undefined,
    verify: (match !== undefined || timeoutSeconds !== undefined || intervalSeconds !== undefined)
      ? { match, timeoutSeconds, intervalSeconds }
      : undefined,
    versioning: override?.versioning ?? route.versioning,
    versionFiles: override?.versionFiles ?? route.versionFiles,
    changelog: override?.changelog ?? route.changelog,
    tag: override?.tag ?? route.tag,
    tagPattern: override?.tagPattern ?? route.tagPattern,
  };
}

function expand(p: string, base: string): string {
  let out = p.startsWith('~') ? p.replace(/^~/, homedir()) : p;
  out = out.replace(/\$\{?HOME\}?/g, homedir());
  return isAbsolute(out) ? out : resolve(base, out);
}

/**
 * A bare name ("dev-qa") is one of the preset directories crew ships under
 * `prompts/`; anything that looks like a path (contains a `/`, or starts
 * with `.`/`~`) is a fork living outside the crew install and is expanded
 * relative to this route's own config directory, same as `apiKeyFile`
 * above — so adopting a fully custom policy never requires forking crew
 * itself, just pointing `promptSet` at a copied-and-edited directory.
 */
function resolvePromptsDir(promptSet: string | undefined, crewHome: string, base: string): string {
  if (!promptSet) return join(crewHome, 'prompts', 'default');
  if (promptSet.includes('/') || promptSet.startsWith('.') || promptSet.startsWith('~')) {
    return expand(promptSet, base);
  }
  return join(crewHome, 'prompts', promptSet);
}

class Missing {
  private readonly paths: string[] = [];
  req<T>(v: T | undefined | null, path: string): T {
    if (v === undefined || v === null || v === '') { this.paths.push(path); return '' as unknown as T; }
    return v;
  }
  add(path: string) { this.paths.push(path); }
  throwIfAny(file: string): void {
    if (this.paths.length === 0) return;
    throw new ConfigError(
      this.paths.length === 1
        ? `${file}: ${this.paths[0]} is required`
        : `${file}: these settings are required and missing:\n` +
          this.paths.map((p) => `  - ${p}`).join('\n'),
    );
  }
}

/**
 * Where this machine's config lives, in order of preference.
 *
 * The config describes the MACHINE, not the checkout: which projects this
 * ship serves, where they are, which agent binary to run. Keeping it outside
 * the repo means the checkout can be replaced or reinstalled without losing
 * it, the repo stays uncluttered, and an eventual `npm i -g crew` works with
 * no checkout at all.
 *
 *   1. $CREW_CONFIG              — explicit, wins always
 *   2. $XDG_CONFIG_HOME/crew/    — respected where set
 *   3. ~/.config/crew/crew.yaml  — the normal home
 *   4. <checkout>/crew.yaml      — legacy, for installs that predate this
 */
/**
 * This crew checkout's own version, for the default User-Agent.
 *
 * Read from `package.json` at runtime rather than baked in at build time —
 * a global install and a checkout run from source should both report what
 * they actually are. Falls back rather than throwing: a User-Agent that
 * cannot be built is not a reason to refuse to run.
 */
function crewVersion(crewHome: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(crewHome, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function configSearchPath(crewHome: string): string[] {
  if (process.env.CREW_CONFIG) return [resolve(process.env.CREW_CONFIG)];
  const xdg = process.env.XDG_CONFIG_HOME;
  return [
    ...(xdg ? [join(xdg, 'crew', 'crew.yaml')] : []),
    join(homedir(), '.config', 'crew', 'crew.yaml'),
    resolve(crewHome, 'crew.yaml'),
  ];
}

export function findConfigFile(crewHome: string): string {
  const candidates = configSearchPath(crewHome);
  return candidates.find((c) => existsSync(c)) ?? candidates[candidates.length - 1]!;
}

/** Where a fresh install should write its config. */
export const defaultConfigPath = (): string =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'crew', 'crew.yaml');

/**
 * A route's `workspace/project` string, in single-token form — for a log
 * line, a digest filename, a stream directory entry, anywhere a `/` would
 * be read as a path separator or make a label harder to grep for. There is
 * no `name:` to use instead any more (that was the whole point), so this is
 * what every place that used to read one now derives it from.
 */
export function routeSlug(route: string): string {
  return route.replace(/\//g, '-');
}

/**
 * Where `crew connect` writes one route's discovered ids, and where
 * `loadConfig` reads them back from —
 * `<stateDir>/resolved/<workspace>/<project>.json`, mirroring the route
 * string's own `workspace/project` shape.
 *
 * Not in `crew.yaml`: the ids are a cache of what the tracker itself already
 * says (ISSUE-285), regenerable by re-running `crew connect`, and belong
 * beside the rest of this machine's derived state rather than in the file a
 * person actually authors and reviews diffs of.
 */
export function resolvedPathFor(stateDir: string, route: string): string {
  const [workspace, project] = splitRoute(route);
  return join(stateDir, 'resolved', workspace, `${project}.json`);
}

/** `"workspace/project"` -> `["workspace", "project"]`, validated. */
function splitRoute(route: string): [string, string] {
  const parts = route.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ConfigError(`route must be "workspace/project" (got "${route}")`);
  }
  return [parts[0], parts[1]];
}

function readResolvedFile(stateDir: string, route: string): any {
  const path = resolvedPathFor(stateDir, route);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${path}: not valid JSON — ${(e as Error).message}`);
  }
}

function parseResolved(raw: any, m: Missing, where: string): ResolvedIds | undefined {
  if (!raw) return undefined;
  const seats: Partial<Record<RoleName, string>> = {};
  for (const role of ROLE_NAMES) if (raw.seats?.[role]) seats[role] = raw.seats[role];
  const holds: HoldConfig[] = Array.isArray(raw.holds)
    ? raw.holds.map((h: any) => (typeof h === 'string' ? { id: h } : { id: h?.id, role: h?.role ?? '' }))
    : [];
  const agentPersonas: ResolvedIds['agentPersonas'] = {};
  for (const role of ROLE_NAMES) {
    const p = raw.agentPersonas?.[role];
    if (p?.agentId && p?.lastSyncedUpdatedAt) {
      agentPersonas[role] = {
        agentId: p.agentId,
        lastSyncedUpdatedAt: p.lastSyncedUpdatedAt,
        ...(typeof p.historyId === 'string' ? { historyId: p.historyId } : {}),
      };
    }
  }
  return {
    workspaceId: m.req(raw.workspaceId, `${where}.resolved.workspaceId`),
    projectId: raw.projectId,
    areaModelId: raw.areaModelId,
    areaId: raw.areaId,
    shipsModelId: raw.shipsModelId,
    epicsModelId: raw.epicsModelId,
    locksModelId: raw.locksModelId,
    reposModelId: raw.reposModelId,
    repoNames: raw.repoNames,
    repoRemotes: raw.repoRemotes,
    models: {
      issues: m.req(raw.models?.issues, `${where}.resolved.models.issues`),
      comments: m.req(raw.models?.comments, `${where}.resolved.models.comments`),
      crew: m.req(raw.models?.crew, `${where}.resolved.models.crew`),
    },
    seats,
    operator: m.req(raw.operator, `${where}.resolved.operator`),
    holds,
    contract: raw.contract ?? undefined,
    ...(Object.keys(agentPersonas).length > 0 ? { agentPersonas } : {}),
  };
}

export function loadConfig(crewHome: string, configFile?: string): CrewConfig {
  const file = configFile ?? findConfigFile(crewHome);
  if (!existsSync(file)) {
    throw new ConfigError(
      `no config found. Looked in:\n` +
        configSearchPath(crewHome).map((c) => `  - ${c}`).join('\n') +
        `\n\nCreate the first of those:\n` +
        `  mkdir -p ${dirname(defaultConfigPath())} && cp ${join(crewHome, 'crew.example.yaml')} ${defaultConfigPath()}`,
    );
  }
  let raw: Record<string, any> | null;
  try {
    raw = parse(readFileSync(file, 'utf8')) as Record<string, any> | null;
  } catch (e) {
    // The YAML library throws with a stack trace naming its own internals,
    // which tells an operator nothing about their file.
    throw new ConfigError(`${file}: not valid YAML — ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object') throw new ConfigError(`${file} is empty or not a mapping`);
  const base = dirname(file);
  const missing = new Missing();

  rejectUnknownKeys(raw, new Set(['ship', 'routes']), 'top-level', file);
  const shipRaw = raw.ship ?? {};
  rejectUnknownKeys(shipRaw, SHIP_KEYS, 'ship', file);
  const declaredPlatform = shipRaw.platform ? String(shipRaw.platform) : undefined;
  if (declaredPlatform && !isShipPlatform(declaredPlatform)) {
    missing.add(`ship.platform must be one of macos|linux|windows (got "${declaredPlatform}")`);
  }
  const maxConcurrentAgents = shipRaw.maxConcurrentAgents === undefined ? 2 : Number(shipRaw.maxConcurrentAgents);
  if (!Number.isInteger(maxConcurrentAgents) || maxConcurrentAgents < 1) {
    missing.add(`ship.maxConcurrentAgents must be a positive integer (got "${shipRaw.maxConcurrentAgents}")`);
  }
  const streamRetentionDays = shipRaw.streamRetentionDays === undefined ? 7 : Number(shipRaw.streamRetentionDays);
  if (!Number.isInteger(streamRetentionDays) || streamRetentionDays < 1) {
    missing.add(`ship.streamRetentionDays must be a positive integer (got "${shipRaw.streamRetentionDays}")`);
  }
  // Relative to the CONFIG's directory, not the checkout: config and state
  // belong to the machine and should travel together. Computed here, ahead
  // of the ship object below, because the routes loop needs it too — each
  // route's resolved ids are read from underneath it.
  const stateDir = expand(shipRaw.stateDir ?? 'state', base);

  const routesRaw = raw.routes;
  if (!Array.isArray(routesRaw) || routesRaw.length === 0) {
    missing.add('routes (at least one)');
  }

  // Each route gets its OWN `Missing` and its own try/catch: a route is
  // someone else's project on this same ship, so a typo in ITS block (an
  // unknown key, a missing dir) must not `process.exit` a ship that is also
  // mid-release for every other route. See the `warnings` doc comment.
  const routeWarnings: string[] = [];
  const routes: Route[] = (Array.isArray(routesRaw) ? routesRaw : []).flatMap((c: any, i: number) => {
    const where = `routes[${i}]`;
    const routeMissing = new Missing();
    try {
      return [parseOneRoute(c, where, file, base, stateDir, raw, routeMissing, crewHome)];
    } catch (e) {
      const label = typeof c?.route === 'string' && c.route ? `"${c.route}"` : where;
      routeWarnings.push(`route ${label} dropped — ${(e as Error).message}`);
      return [];
    }
  });

  // Every declared route failed — there is nothing this ship could run, so
  // this IS fatal, same as declaring no routes at all.
  if (Array.isArray(routesRaw) && routesRaw.length > 0 && routes.length === 0) {
    throw new ConfigError(routeWarnings.join('\n'));
  }

  const seen = routes.map((r) => r.route);
  const dupe = seen.find((n, i) => n && seen.indexOf(n) !== i);
  if (dupe) missing.add(`routes: duplicate route "${dupe}" — a route addresses itself, so it must be unique`);

  missing.throwIfAny(file);

  return {
    ship: {
      name: shipRaw.name ?? 'this ship',
      platform: (declaredPlatform as ShipPlatform) ?? hostPlatform(),
      agent: { bin: expand(shipRaw.agent?.bin ?? 'claude', base), model: shipRaw.agent?.model ?? 'claude-sonnet-5' },
      shell: shipRaw.shell,
      extraPath: shipRaw.extraPath,
      useNvm: shipRaw.useNvm !== false,
      nvmSh: shipRaw.nvmSh,
      stateDir,
      logFile: expand(shipRaw.logFile ?? join(tmpdir(), 'crew.log'), base),
      userAgent: shipRaw.userAgent ?? `Mozilla/5.0 CrewAgent/${crewVersion(crewHome)}`,
      maxConcurrentAgents,
      streamRetentionDays,
    },
    routes,
    crewHome,
    configFile: file,
    warnings: routeWarnings,
  };
}

function parseOneRoute(
  c: any, where: string, file: string, base: string, stateDir: string, raw: Record<string, any>,
  missing: Missing, crewHome: string,
): Route {
  rejectUnknownKeys(c, ROUTE_KEYS, `${where}`, file);
  const route = missing.req(c?.route, `${where}.route`) as string;
  const routeParts = route ? route.split('/') : [];
  const routeWellFormed = routeParts.length === 2 && routeParts.every(Boolean);
  if (route && !routeWellFormed) {
    missing.add(`${where}.route must be "workspace/project" (got "${route}")`);
  }
  // `repos` or `dir` — one of them must say where the code is. An entry may
  // be a bare dir string, or an object naming its dir plus its own
  // hooks/labels/release overrides — see Route.repoOverrides.
  const repoDirs: Record<string, string> = {};
  const repoOverrides: Route['repoOverrides'] = {};
  if (c?.repos && typeof c.repos === 'object') {
    for (const [name, entry] of Object.entries(c.repos as Record<string, unknown>)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const e = entry as Record<string, any>;
        rejectUnknownKeys(e, REPO_ENTRY_KEYS, `${where}.repos.${name}`, file);
        repoDirs[name] = expand(String(missing.req(e.dir, `${where}.repos.${name}.dir`) || ''), base);
        if (e.hooks || e.labels || e.release || e.branch) {
          repoOverrides[name] = {
            hooks: e.hooks, labels: e.labels,
            release: e.release ? parseReleaseOverride(e.release, `${where}.repos.${name}`, file) : undefined,
            // Omitted entirely rather than `branch: undefined` when absent —
            // an explicit key with an undefined value is not the same object
            // shape as one that never had the key, and existing callers
            // compare this literally.
            ...(e.branch ? { branch: parseBranchOverride(e.branch, `${where}.repos.${name}`, file) } : {}),
          };
        }
      } else {
        repoDirs[name] = expand(String(entry), base);
      }
    }
  }
  const hasRepos = Object.keys(repoDirs).length > 0;
  const dir = c?.dir
    ? expand(String(c.dir), base)
    : hasRepos
      ? Object.values(repoDirs)[0]!
      : (missing.req(undefined as string | undefined, `${where}.dir (or ${where}.repos)`) ?? '');
  // A rate scalar, never a switch: 0 or below would let a weight silently
  // starve the route, exactly the misuse `enabled: false` exists to do
  // honestly instead (see the Route.weight doc comment).
  const weight: number | undefined = c?.weight === undefined ? undefined : Number(c.weight);
  if (weight !== undefined && !(Number.isFinite(weight) && weight > 0)) {
    missing.add(`${where}.weight must be a positive number (got "${c?.weight}")`);
  }
  const result: Route = {
    route,
    enabled: c?.enabled === true,
    area: c?.area,
    dir,
    repos: repoDirs,
    reposBasePath: expand(String(c?.reposBasePath ?? raw.ship?.reposBasePath ?? DEFAULT_REPOS_BASE_PATH), base),
    repoOverrides,
    worktreePrefix: c?.worktreePrefix ? String(c.worktreePrefix) : undefined,
    promptsDir: resolvePromptsDir(c?.promptSet ? String(c.promptSet) : undefined, crewHome, base),
    weight,
    baseUrl: String(c?.baseUrl ?? raw.ship?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    // Keys are workspace-scoped in general, so a route normally brings its
    // own — but nothing stops one key being valid for several workspaces
    // (a personal account key, say), and a ship declaring it once is one
    // fewer secret to keep in sync across routes.
    apiKey: c?.apiKey ?? raw.ship?.apiKey,
    apiKeyFile: c?.apiKeyFile ? expand(c.apiKeyFile, dir) : undefined,
    apiKeyVar: c?.apiKeyVar,
    hooks: { test: c?.hooks?.test, build: c?.hooks?.build, deploy: c?.hooks?.deploy, notify: c?.hooks?.notify },
    labels: {
      test: c?.labels?.test ?? c?.hooks?.test,
      build: c?.labels?.build ?? c?.hooks?.build,
      deploy: c?.labels?.deploy ?? c?.hooks?.deploy,
    },
    release: parseReleaseOverride(c?.release, where, file),
    branch: parseBranchOverride(c?.branch, where, file),
  };
  // The state-tree file wins when both exist: it's what `crew connect`
  // manages going forward, and an authored `resolved:`/`contract:` block in
  // crew.yaml is only a legacy or hand-filled fallback (see the file
  // comment at the top) — a workspace's own status/priority/severity
  // choices are tracker data, not a fact about this machine, so once
  // discovery can populate them the state file is the source of truth and
  // `crew.yaml` is the escape hatch, not the primary path.
  const resolvedFile = routeWellFormed ? readResolvedFile(stateDir, route) : undefined;
  result.resolved = parseResolved(resolvedFile ?? c?.resolved, missing, where);
  result.contract = resolvedFile?.contract ?? c?.contract ?? null;
  missing.throwIfAny(file);
  return result;
}

/**
 * Which route (if any) owns the checkout at `dir` — how something started
 * from inside a repo (an IDE session, a shell) rather than by an operator
 * naming a route on the command line, works out which board it belongs to.
 * Matches `dir` itself or any ancestor of it against every checkout
 * `reposOf` lists for each route, so it works from a subdirectory of the
 * checkout too. Returns undefined rather than throwing — the caller (e.g. a
 * `SessionStart` hook) treats "not a crew checkout" as a normal, silent case.
 */
export function routeForDir(cfg: CrewConfig, dir: string): Route | undefined {
  const target = resolve(dir);
  const isInside = (base: string) => {
    const b = resolve(base);
    return target === b || target.startsWith(`${b}/`);
  };
  return cfg.routes.find((r) => reposOf(r).some((repo) => isInside(repo.dir)));
}

/** Look a route up by its `workspace/project` string — how `crew run <route>` addresses one. */
export function findRoute(cfg: CrewConfig, route?: string): Route {
  if (!route) {
    const enabled = cfg.routes.filter((r) => r.enabled);
    if (enabled.length === 1) return enabled[0] as Route;
    if (cfg.routes.length === 1) return cfg.routes[0] as Route;
    throw new ConfigError(
      `this ship has ${cfg.routes.length} routes — name one: ${cfg.routes.map((r) => r.route).join(', ')}`,
    );
  }
  const found = cfg.routes.find((r) => r.route === route);
  if (!found) {
    throw new ConfigError(`no route "${route}" (have: ${cfg.routes.map((r) => r.route).join(', ')})`);
  }
  return found;
}

/**
 * Where a ticket's work happens on this machine.
 *
 * ticket.repo_id -> the Repos row's name -> the configured directory. Falls
 * back to the route's single `dir` when the area has one repo, which is the
 * common case and what every route looked like before areas could span
 * several.
 *
 * Returns null when a ticket names a repo this ship has no checkout for —
 * that is a real state (another ship may serve it), and the caller reports it
 * rather than working the wrong directory.
 */
export function dirForRepo(r: Route, repoId?: string | null): string | null {
  return repoTargetFor(r, repoId)?.dir ?? null;
}

/**
 * The full target (dir, and a `remote` when the dir is a derived one that
 * may not exist yet) for the repo a ticket names — what `ensureRepoCheckout`
 * (git.ts) needs before handing that ticket to an agent, one step up from
 * `dirForRepo`'s bare path.
 */
export function repoTargetFor(r: Route, repoId?: string | null): RepoTarget | null {
  const names = r.resolved?.repoNames;
  if (!repoId || !names) return Object.keys(r.repos).length ? null : { name: basename(r.dir), dir: r.dir };
  const name = names[repoId];
  if (!name) return null;
  return reposOf(r).find((t) => t.name === name) ?? null;
}

/**
 * The reverse of `resolved.repoNames` (id -> name): given a repo's name as
 * the route's own `repos` map or `RepoTarget` uses it, find its row id in
 * the tracker's `Repos` table. Needed wherever a NEW ticket has to be filed
 * with a `repo` column pointing at an existing Repos row (ISSUE-411).
 */
export function repoIdForName(r: Route, name: string): string | undefined {
  const names = r.resolved?.repoNames;
  if (!names) return undefined;
  for (const [id, n] of Object.entries(names)) if (n === name) return id;
  return undefined;
}

/** The API key for one route. Never logged. */
export function resolveApiKey(r: Route): string {
  if (r.apiKey) return r.apiKey;
  if (r.apiKeyFile && r.apiKeyVar && existsSync(r.apiKeyFile)) {
    for (const line of readFileSync(r.apiKeyFile, 'utf8').split('\n')) {
      const m = line.match(new RegExp(`^${r.apiKeyVar}=(.*)$`));
      if (m) return (m[1] ?? '').trim().replace(/^["']|["']$/g, '');
    }
  }
  throw new ConfigError(
    `route "${r.route}": no API key (apiKey, or ${r.apiKeyVar ?? 'VAR'} in ${r.apiKeyFile ?? '<unset>'})`,
  );
}

/** Seats and holds as the roster builder wants them. Requires resolved ids. */
export function configuredMembers(rt: Route) {
  const r = rt.resolved;
  if (!r) throw new ConfigError(`route "${rt.route}" has no resolved ids — run \`crew connect\``);
  const out: Array<{ id: string; role: string; kind: 'seat' | 'hold' }> = [];
  for (const role of ROLE_NAMES) {
    const id = r.seats[role];
    // `pair`'s Crew row is stored the same way a polled seat's is, but it is
    // a HOLD, not a seat: it is never assigned work by the poll loop, and a
    // ticket it IS working (a live, human-paired session) must be off-limits
    // to every polled seat the same way one a person is driving already is
    // (roster.ts's `isHold`, and the `holds` Set `poll.ts` builds from this).
    if (id) out.push({ id, role: ROLE_LABEL[role], kind: role === 'pair' ? 'hold' : 'seat' });
  }
  if (r.operator) out.push({ id: r.operator, role: 'Operator', kind: 'hold' });
  for (const h of r.holds) if (h.id) out.push({ id: h.id, role: h.role ?? '', kind: 'hold' });
  return out;
}

/** One checkout the crew works in, and the name the board knows it by. */
export interface RepoTarget {
  /** The board's slug for it, or this checkout's own directory name for a single-repo setup. */
  name: string;
  dir: string;
  /**
   * `owner/repo`, when `crew connect` discovered one for it (`resolved.
   * repoRemotes`) and `dir` was DERIVED rather than explicit — absent for an
   * explicit `repos:` entry, since an operator-placed checkout is never
   * something crew decides to clone into. `ensureRepoCheckout` (git.ts)
   * reads this to clone `dir` into existence the first time it's needed.
   */
  remote?: string;
}

/**
 * `<basePath>/<workspace>/<repoName>` — see `DEFAULT_REPOS_BASE_PATH`.
 * `basePath` is `Route.reposBasePath`, already `~`-expanded and absolute by
 * the time a `Route` exists, so this is only ever a join.
 */
export function defaultRepoDir(basePath: string, workspace: string, repoName: string): string {
  return join(basePath, workspace, repoName);
}

/**
 * Every checkout this route covers.
 *
 * A route is a board; a board's area of development spans several
 * repositories (ISSUE-331). Release, merge, deploy and sync are all
 * REPOSITORY operations, so they iterate this rather than using `dir` —
 * `route.dir` is only the fallback for a route that declares no `repos`
 * map, and using it as "the" directory meant every repo but the first was
 * never released at all.
 *
 * `repos:` listing anything at all is still a closed enumeration, exactly
 * as before: several ships can divide a multi-repo area's work between
 * them, and a repo the tracker knows about that isn't named here is
 * deliberately another ship's, not an oversight — `not-served-here`
 * (`ticketsByRepo`) depends on that staying true. The new behaviour only
 * applies when `repos:` is left out ENTIRELY: every repo the tracker's own
 * `Repos` table lists (`resolved.repoNames`) then gets a target at its
 * `defaultRepoDir`, so a route that wants "just work everything this area
 * covers" no longer has to enumerate it by hand. A route with one repo (or
 * none resolved yet) is unaffected either way — it keeps using `route.dir`,
 * which an operator may have placed anywhere.
 */
export function reposOf(r: Route): RepoTarget[] {
  const named = Object.entries(r.repos);
  if (named.length > 0) return named.map(([name, dir]) => ({ name, dir }));

  const trackerNames = r.resolved?.repoNames ? Object.values(r.resolved.repoNames) : [];
  if (trackerNames.length <= 1) return [{ name: basename(r.dir), dir: r.dir }];

  const remotes = r.resolved?.repoRemotes ?? {};
  const remoteByName: Record<string, string> = {};
  for (const [id, name] of Object.entries(r.resolved!.repoNames!)) {
    if (remotes[id]) remoteByName[name] = remotes[id];
  }
  const [workspace] = splitRoute(r.route);
  return trackerNames.map((name) => ({
    name, dir: defaultRepoDir(r.reposBasePath, workspace, name), remote: remoteByName[name],
  }));
}

/**
 * The route's `worktreePrefix`, but only where it is unambiguous.
 *
 * A single-repo route has exactly one checkout to name, so the route-level
 * value fits it and only it. An area with several repos (ISSUE-331) has one
 * `worktreePrefix` string for however many checkouts it serves — passing it
 * to `resolveRepoConfig` for every one of them made it win for whichever
 * repo it happened to match and shadow every other repo's own derived
 * default (ISSUE-398). Returning `undefined` here lets each of those repos
 * fall through to its own `.crew.yaml` prefix or `defaultWorktreePrefix(dir)`
 * instead.
 */
export function shipWorktreePrefixFor(r: Route): string | undefined {
  return reposOf(r).length === 1 ? r.worktreePrefix : undefined;
}

/**
 * Why a ticket could not be placed in one of this ship's checkouts.
 *
 * Three states that were one list until ISSUE-351, reported with a sentence
 * true of only the first — so a perfectly well-formed ticket for another
 * ship's repository warned, every cycle, that it "names no repository".
 *
 * - `no-repo`         the ticket names none. A board problem; someone must fix it.
 * - `unknown-repo`    it names one this ship's `repoNames` has never heard of.
 *                     A stale cache, fixed by `crew connect` — not by editing
 *                     the ticket.
 * - `not-served-here` it names one this ship has no checkout for. NOTHING IS
 *                     WRONG: another ship serves it, and this one is right to
 *                     decline. Never a warning.
 */
export type UnplaceableReason = 'no-repo' | 'unknown-repo' | 'not-served-here';

export interface Unplaceable<T> {
  ticket: T;
  reason: UnplaceableReason;
  /** The repository's name, when it is known — `not-served-here` only. */
  repo?: string;
}

/**
 * Split a route's tickets by which repository they belong to.
 *
 * A ticket with no repo set cannot be placed once a route has more than one
 * checkout, and guessing would merge a branch into the wrong repository.
 * Those are returned separately so the caller can say so out loud rather than
 * silently dropping them.
 */
export function ticketsByRepo<T extends { repo_id?: string | null | undefined }>(
  r: Route, tickets: T[],
): { byRepo: Map<string, T[]>; unplaceable: Array<Unplaceable<T>> } {
  const targets = reposOf(r);
  const byRepo = new Map<string, T[]>(targets.map((t) => [t.name, []]));
  const unplaceable: Array<Unplaceable<T>> = [];
  // An empty `repos:` map with more than one tracker-known repo is now
  // genuinely multi-repo (`reposOf` derives a target per repo) and must
  // route by repo_id like any other multi-repo route, rather than dumping
  // everything into targets[0] the way a true single-repo route does.
  const single = Object.keys(r.repos).length === 0 && targets.length === 1;
  const names = r.resolved?.repoNames ?? {};

  for (const t of tickets) {
    if (single) { byRepo.get(targets[0]!.name)!.push(t); continue; }
    const name = t.repo_id ? names[t.repo_id] : undefined;
    if (name && byRepo.has(name)) byRepo.get(name)!.push(t);
    else if (!t.repo_id) unplaceable.push({ ticket: t, reason: 'no-repo' });
    else if (!name) unplaceable.push({ ticket: t, reason: 'unknown-repo' });
    else unplaceable.push({ ticket: t, reason: 'not-served-here', repo: name });
  }
  return { byRepo, unplaceable };
}

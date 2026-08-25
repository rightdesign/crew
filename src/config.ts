/**
 * crew.yaml — what this ship is, and what it is connected to.
 *
 * Two levels, because a ship is not a project (CREW_PRD §1.1, §15):
 *
 *   ship:        facts about this machine — the agent binary, the shell its
 *                hooks are written for, where state and logs go. One per file.
 *   connections: one entry per project this ship works. A **connection** binds
 *                one slice of one work source to one local directory, and a
 *                machine may hold many at once.
 *
 * IDS ARE RESOLVED, NOT AUTHORED. A connection names its workspace and project
 * in words; the uuids for the tracker's data models and the crew's rows are
 * discovered from the project and cached under `resolved:`. `crew connect`
 * (ISSUE-285) is what writes that cache. Until it exists the cache may be
 * filled in by hand, which is why it is a distinct block rather than mixed in
 * with the settings a person actually authors — everything under `resolved:`
 * is derivable and regenerable, and nothing under it should be edited to
 * change behaviour.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { parse } from 'yaml';
import {
  isPlatformRequirement, hostPlatform, isShipPlatform,
  type PlatformRequirement, type ShipPlatform,
} from './platform.ts';

export type RoleName = 'dev' | 'design' | 'qa' | 'triage';
export const ROLE_NAMES: RoleName[] = ['dev', 'design', 'qa', 'triage'];
export const ROLE_LABEL: Record<RoleName, string> = {
  dev: 'Dev', design: 'Design', qa: 'QA', triage: 'Triage',
};

export interface HoldConfig { id: string; role?: string }

/** The ids a connection discovers from its project. Regenerable; never authored. */
export interface ResolvedIds {
  workspaceId: string;
  projectId?: string;
  /** The `Projects` table, and the row this connection's `area` names. */
  areaModelId?: string;
  areaId?: string;
  /** The `Repos` table, and repo id -> name, so a ticket's repo resolves. */
  reposModelId?: string;
  repoNames?: Record<string, string>;
  /**
   * The `Ships` table, when this workspace has one. The ship is matched by
   * NAME (`ship.name`) rather than by a stored id: a machine's name is what
   * an operator recognises on the board, and it is stable enough in practice.
   */
  shipsModelId?: string;
  /** The `Epics` table, when this workspace has one (ISSUE-384). */
  epicsModelId?: string;
  models: { issues: string; comments: string; crew: string };
  seats: Partial<Record<RoleName, string>>;
  operator: string;
  holds: HoldConfig[];
}

export interface Connection {
  /** Short local handle, used in logs, state file names and `crew run <name>`. */
  name: string;
  /**
   * Which row of the work source's `Projects` table this connection works —
   * one *area of development*, named rather than numbered.
   *
   * Note the deliberate word: `project` below is the **Tablation project**
   * that contains the tracker's tables, while `area` is a **row in the
   * Projects table inside it**. Both are called "project" in conversation and
   * they are not the same thing; a connection binds one area to one checkout,
   * and a ship holds many such connections.
   *
   * Omit it and the connection sees every ticket, whatever its area — which
   * is right for a tracker that has not been sliced.
   */
  area?: string;
  /** Per-connection interlock: this one connection polls and runs. */
  enabled: boolean;
  workspace: string;
  project?: string;
  /**
   * The checkout this connection works, when its area has exactly one repo.
   * Kept for the common case; `repos` is what a multi-repo area needs.
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
   * A ship-level fallback for repos on this connection that declare no
   * `worktrees.prefix` of their own (ISSUE-350). Optional: a connection that
   * says nothing lets every repo fall through to its own derived default
   * instead of this one value overriding all of them regardless of which
   * repo it actually fits (ISSUE-400).
   */
  worktreePrefix?: string;
  /** What this project needs of a host. Checked against the ship's platform. */
  platform: PlatformRequirement;
  baseUrl: string;
  apiKey?: string;
  apiKeyFile?: string;
  apiKeyVar?: string;
  hooks: { test?: string; build?: string; deploy?: string; notify?: string };
  labels: { test?: string; build?: string; deploy?: string };
  /**
   * Release settings the SHIP declares for a repo that has no `.crew.yaml`.
   * Undefined when nothing was declared — a synthesised default here would be
   * passed on as though the operator had written it, and would silently
   * shadow the repo's own contract.
   */
  release: { versionFiles?: string[]; changelog?: string };
  /**
   * This workspace's own rules, where they differ from the default (see
   * docs/CONTRACT.md). Absent means the workspace means what the unmodified
   * Issue Tracker template means. Belongs per connection, not per ship: one
   * machine may serve several workspaces with different conventions.
   */
  contract?: Partial<import('./contract.ts').Contract> | null;
  resolved?: ResolvedIds;
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
}

export interface CrewConfig {
  ship: Ship;
  connections: Connection[];
  crewHome: string;
  configFile: string;
}

export class ConfigError extends Error {}

const SHIP_KEYS = new Set([
  'name', 'platform', 'agent', 'shell', 'extraPath', 'useNvm', 'nvmSh',
  'stateDir', 'logFile', 'userAgent', 'baseUrl', 'maxConcurrentAgents',
]);
const CONNECTION_KEYS = new Set([
  'name', 'enabled', 'workspace', 'project', 'area', 'dir', 'repos', 'worktreePrefix',
  'platform', 'baseUrl', 'apiKey', 'apiKeyFile', 'apiKeyVar',
  'hooks', 'labels', 'release', 'branch', 'contract', 'resolved',
]);

/**
 * An unknown key is an ERROR, not something to ignore — the same rule the
 * repo contract uses, and for the same reason.
 *
 * This exists because of a real mistake: removing a `hooks:` key left its
 * children (`test:`, `build:`, `deploy:`) dangling at connection level, where
 * they were silently dropped. The file still LOOKED like it configured a test
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

function expand(p: string, base: string): string {
  let out = p.startsWith('~') ? p.replace(/^~/, homedir()) : p;
  out = out.replace(/\$\{?HOME\}?/g, homedir());
  return isAbsolute(out) ? out : resolve(base, out);
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

function parseResolved(raw: any, m: Missing, where: string): ResolvedIds | undefined {
  if (!raw) return undefined;
  const seats: Partial<Record<RoleName, string>> = {};
  for (const role of ROLE_NAMES) if (raw.seats?.[role]) seats[role] = raw.seats[role];
  const holds: HoldConfig[] = Array.isArray(raw.holds)
    ? raw.holds.map((h: any) => (typeof h === 'string' ? { id: h } : { id: h?.id, role: h?.role ?? '' }))
    : [];
  return {
    workspaceId: m.req(raw.workspaceId, `${where}.resolved.workspaceId`),
    projectId: raw.projectId,
    areaModelId: raw.areaModelId,
    areaId: raw.areaId,
    shipsModelId: raw.shipsModelId,
    epicsModelId: raw.epicsModelId,
    reposModelId: raw.reposModelId,
    repoNames: raw.repoNames,
    models: {
      issues: m.req(raw.models?.issues, `${where}.resolved.models.issues`),
      comments: m.req(raw.models?.comments, `${where}.resolved.models.comments`),
      crew: m.req(raw.models?.crew, `${where}.resolved.models.crew`),
    },
    seats,
    operator: m.req(raw.operator, `${where}.resolved.operator`),
    holds,
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

  rejectUnknownKeys(raw, new Set(['ship', 'connections']), 'top-level', file);
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

  const connRaw = raw.connections;
  if (!Array.isArray(connRaw) || connRaw.length === 0) {
    missing.add('connections (at least one)');
  }

  const connections: Connection[] = (Array.isArray(connRaw) ? connRaw : []).map((c: any, i: number) => {
    const where = `connections[${i}]`;
    rejectUnknownKeys(c, CONNECTION_KEYS, `${where}`, file);
    const name = missing.req(c?.name, `${where}.name`) as string;
    // `repos` or `dir` — one of them must say where the code is.
    const repoDirs: Record<string, string> = {};
    if (c?.repos && typeof c.repos === 'object') {
      for (const [name, d] of Object.entries(c.repos as Record<string, string>)) {
        repoDirs[name] = expand(String(d), base);
      }
    }
    const hasRepos = Object.keys(repoDirs).length > 0;
    const dir = c?.dir
      ? expand(String(c.dir), base)
      : hasRepos
        ? Object.values(repoDirs)[0]!
        : (missing.req(undefined as string | undefined, `${where}.dir (or ${where}.repos)`) ?? '');
    const platformRaw = String(c?.platform ?? 'any');
    if (!isPlatformRequirement(platformRaw)) {
      missing.add(`${where}.platform must be one of any|unix|macos|linux|windows (got "${platformRaw}")`);
    }
    const versionFiles: string[] | undefined = Array.isArray(c?.release?.versionFiles)
      ? c.release.versionFiles
      : c?.release?.versionFile ? [c.release.versionFile] : undefined;
    return {
      name,
      enabled: c?.enabled === true,
      workspace: missing.req(c?.workspace, `${where}.workspace`) as string,
      project: c?.project,
      area: c?.area,
      dir,
      repos: repoDirs,
      worktreePrefix: c?.worktreePrefix ? String(c.worktreePrefix) : undefined,
      platform: platformRaw as PlatformRequirement,
      baseUrl: (missing.req(c?.baseUrl ?? raw.ship?.baseUrl, `${where}.baseUrl`) as string).replace(/\/+$/, ''),
      apiKey: c?.apiKey,
      apiKeyFile: c?.apiKeyFile ? expand(c.apiKeyFile, dir) : undefined,
      apiKeyVar: c?.apiKeyVar,
      hooks: { test: c?.hooks?.test, build: c?.hooks?.build, deploy: c?.hooks?.deploy, notify: c?.hooks?.notify },
      labels: {
        test: c?.labels?.test ?? c?.hooks?.test,
        build: c?.labels?.build ?? c?.hooks?.build,
        deploy: c?.labels?.deploy ?? c?.hooks?.deploy,
      },
      release: { versionFiles, changelog: c?.release?.changelog },
      contract: c?.contract ?? null,
      resolved: parseResolved(c?.resolved, missing, where),
    };
  });

  const names = connections.map((c) => c.name);
  const dupe = names.find((n, i) => n && names.indexOf(n) !== i);
  if (dupe) missing.add(`connections: duplicate name "${dupe}" — names address a connection, so they must be unique`);

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
      // Relative to the CONFIG's directory, not the checkout: config and
      // state belong to the machine and should travel together.
      stateDir: expand(shipRaw.stateDir ?? 'state', base),
      logFile: expand(shipRaw.logFile ?? join(tmpdir(), 'crew.log'), base),
      userAgent: shipRaw.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0',
      maxConcurrentAgents,
    },
    connections,
    crewHome,
    configFile: file,
  };
}

/** Look a connection up by name — how `crew run <name>` addresses one. */
export function connection(cfg: CrewConfig, name?: string): Connection {
  if (!name) {
    const enabled = cfg.connections.filter((c) => c.enabled);
    if (enabled.length === 1) return enabled[0] as Connection;
    if (cfg.connections.length === 1) return cfg.connections[0] as Connection;
    throw new ConfigError(
      `this ship has ${cfg.connections.length} connections — name one: ${cfg.connections.map((c) => c.name).join(', ')}`,
    );
  }
  const found = cfg.connections.find((c) => c.name === name);
  if (!found) {
    throw new ConfigError(`no connection named "${name}" (have: ${cfg.connections.map((c) => c.name).join(', ')})`);
  }
  return found;
}

/**
 * Where a ticket's work happens on this machine.
 *
 * ticket.repo_id -> the Repos row's name -> the configured directory. Falls
 * back to the connection's single `dir` when the area has one repo, which is
 * the common case and what every connection looked like before areas could
 * span several.
 *
 * Returns null when a ticket names a repo this ship has no checkout for —
 * that is a real state (another ship may serve it), and the caller reports it
 * rather than working the wrong directory.
 */
export function dirForRepo(c: Connection, repoId?: string | null): string | null {
  const names = c.resolved?.repoNames;
  if (!repoId || !names) return Object.keys(c.repos).length ? null : c.dir;
  const name = names[repoId];
  if (!name) return null;
  return c.repos[name] ?? (Object.keys(c.repos).length === 0 ? c.dir : null);
}

/** The API key for one connection. Never logged. */
export function resolveApiKey(c: Connection): string {
  if (c.apiKey) return c.apiKey;
  if (c.apiKeyFile && c.apiKeyVar && existsSync(c.apiKeyFile)) {
    for (const line of readFileSync(c.apiKeyFile, 'utf8').split('\n')) {
      const m = line.match(new RegExp(`^${c.apiKeyVar}=(.*)$`));
      if (m) return (m[1] ?? '').trim().replace(/^["']|["']$/g, '');
    }
  }
  throw new ConfigError(
    `connection "${c.name}": no API key (apiKey, or ${c.apiKeyVar ?? 'VAR'} in ${c.apiKeyFile ?? '<unset>'})`,
  );
}

/** Seats and holds as the roster builder wants them. Requires resolved ids. */
export function configuredMembers(c: Connection) {
  const r = c.resolved;
  if (!r) throw new ConfigError(`connection "${c.name}" has no resolved ids — run \`crew connect\``);
  const out: Array<{ id: string; role: string; kind: 'seat' | 'hold' }> = [];
  for (const role of ROLE_NAMES) {
    const id = r.seats[role];
    if (id) out.push({ id, role: ROLE_LABEL[role], kind: 'seat' });
  }
  if (r.operator) out.push({ id: r.operator, role: 'Operator', kind: 'hold' });
  for (const h of r.holds) if (h.id) out.push({ id: h.id, role: h.role ?? '', kind: 'hold' });
  return out;
}

/** One checkout the crew works in, and the name the board knows it by. */
export interface RepoTarget {
  /** The board's slug for it, or the connection name for a single-repo setup. */
  name: string;
  dir: string;
}

/**
 * Every checkout this connection covers.
 *
 * A connection is a board; a board's area of development spans several
 * repositories (ISSUE-331). Release, merge, deploy and sync are all
 * REPOSITORY operations, so they iterate this rather than using `dir` —
 * `conn.dir` is only the fallback for a connection that declares no `repos`
 * map, and using it as "the" directory meant every repo but the first was
 * never released at all.
 */
export function reposOf(c: Connection): RepoTarget[] {
  const named = Object.entries(c.repos);
  if (named.length === 0) return [{ name: c.name, dir: c.dir }];
  return named.map(([name, dir]) => ({ name, dir }));
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
 * Split a connection's tickets by which repository they belong to.
 *
 * A ticket with no repo set cannot be placed once a connection has more than
 * one checkout, and guessing would merge a branch into the wrong repository.
 * Those are returned separately so the caller can say so out loud rather than
 * silently dropping them.
 */
export function ticketsByRepo<T extends { repo_id?: string | null | undefined }>(
  c: Connection, tickets: T[],
): { byRepo: Map<string, T[]>; unplaceable: Array<Unplaceable<T>> } {
  const targets = reposOf(c);
  const byRepo = new Map<string, T[]>(targets.map((t) => [t.name, []]));
  const unplaceable: Array<Unplaceable<T>> = [];
  const single = Object.keys(c.repos).length === 0;
  const names = c.resolved?.repoNames ?? {};

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

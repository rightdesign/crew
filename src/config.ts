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
  /**
   * The `Ships` table, when this workspace has one. The ship is matched by
   * NAME (`ship.name`) rather than by a stored id: a machine's name is what
   * an operator recognises on the board, and it is stable enough in practice.
   */
  shipsModelId?: string;
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
  dir: string;
  worktreePrefix: string;
  /** What this project needs of a host. Checked against the ship's platform. */
  platform: PlatformRequirement;
  baseUrl: string;
  apiKey?: string;
  apiKeyFile?: string;
  apiKeyVar?: string;
  hooks: { test?: string; build?: string; deploy?: string; notify?: string };
  labels: { test?: string; build?: string; deploy?: string };
  release: { versionFiles: string[]; changelog: string };
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
}

export interface CrewConfig {
  ship: Ship;
  connections: Connection[];
  crewHome: string;
  configFile: string;
}

export class ConfigError extends Error {}

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

export function findConfigFile(crewHome: string): string {
  return process.env.CREW_CONFIG ? resolve(process.env.CREW_CONFIG) : resolve(crewHome, 'crew.yaml');
}

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
    throw new ConfigError(`no config at ${file} — copy crew.example.yaml to crew.yaml and fill it in`);
  }
  const raw = parse(readFileSync(file, 'utf8')) as Record<string, any> | null;
  if (!raw || typeof raw !== 'object') throw new ConfigError(`${file} is empty or not a mapping`);
  const base = dirname(file);
  const missing = new Missing();

  const shipRaw = raw.ship ?? {};
  const declaredPlatform = shipRaw.platform ? String(shipRaw.platform) : undefined;
  if (declaredPlatform && !isShipPlatform(declaredPlatform)) {
    missing.add(`ship.platform must be one of macos|linux|windows (got "${declaredPlatform}")`);
  }

  const connRaw = raw.connections;
  if (!Array.isArray(connRaw) || connRaw.length === 0) {
    missing.add('connections (at least one)');
  }

  const connections: Connection[] = (Array.isArray(connRaw) ? connRaw : []).map((c: any, i: number) => {
    const where = `connections[${i}]`;
    const name = missing.req(c?.name, `${where}.name`) as string;
    const dir = expand(missing.req(c?.dir, `${where}.dir`) as string, base);
    const platformRaw = String(c?.platform ?? 'any');
    if (!isPlatformRequirement(platformRaw)) {
      missing.add(`${where}.platform must be one of any|unix|macos|linux|windows (got "${platformRaw}")`);
    }
    const versionFiles: string[] = Array.isArray(c?.release?.versionFiles)
      ? c.release.versionFiles
      : c?.release?.versionFile ? [c.release.versionFile] : ['package.json'];
    return {
      name,
      enabled: c?.enabled === true,
      workspace: missing.req(c?.workspace, `${where}.workspace`) as string,
      project: c?.project,
      area: c?.area,
      dir,
      worktreePrefix: missing.req(c?.worktreePrefix, `${where}.worktreePrefix`) as string,
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
      release: { versionFiles, changelog: c?.release?.changelog ?? 'CHANGELOG.md' },
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
      stateDir: expand(shipRaw.stateDir ?? '.state', crewHome),
      logFile: expand(shipRaw.logFile ?? join(tmpdir(), 'tablation-crew.log'), crewHome),
      userAgent: shipRaw.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0',
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

/**
 * crew.yaml — everything this ship knows that is not code.
 *
 * Replaces the sourced `crew.config.sh` of the bash runner. The shape follows
 * CREW_PRD §14 (R14: "briefs name hooks rather than commands"), so a hook is a
 * command string rather than a shell function: Node cannot source bash, and a
 * command string is the part that was ever portable anyway.
 *
 * Ids live here for now. ISSUE-285 (`crew connect`) moves them into
 * `.tablation/connection.json`, resolved by name — `loadConfig` is the seam
 * that will read from there instead, which is why nothing else in the runner
 * touches the file.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { parse } from 'yaml';
import { isPlatformRequirement, type PlatformRequirement } from './platform.ts';

export type RoleName = 'dev' | 'design' | 'qa' | 'triage';
export const BUILDING_ROLES = ['dev', 'design'] as const;

export interface HoldConfig {
  id: string;
  /** Shown in parentheses after the name, when the name does not carry it. */
  role?: string;
}

export interface CrewConfig {
  /** Safety interlock: nothing polls, runs, merges or deploys until true. */
  enabled: boolean;
  project: {
    dir: string;
    worktreePrefix: string;
    /**
     * What this project needs of a host — 'any' | 'unix' | 'macos' | 'linux' |
     * 'windows'. Broader than a host ("unix" for POSIX-shell hooks) or
     * narrower than a family ("macos" for an Xcode build). Checked by
     * `doctor` against the running host; the same predicate is what
     * cross-ship dispatch will filter on once Ships exist (ISSUE-328).
     */
    platform: PlatformRequirement;
  };
  tracker: {
    baseUrl: string;
    workspaceId: string;
    models: { issues: string; comments: string; crew: string };
    apiKey?: string;
    apiKeyFile?: string;
    apiKeyVar?: string;
    userAgent: string;
  };
  crew: {
    seats: Partial<Record<RoleName, string>>;
    operator: string;
    holds: HoldConfig[];
  };
  agent: { bin: string; model: string };
  hooks: { test?: string; build?: string; deploy?: string; notify?: string };
  /** Human-readable names for the hooks, used in log lines and filed tickets. */
  labels: { test?: string; build?: string; deploy?: string };
  release: { versionFiles: string[]; changelog: string };
  runtime: {
    extraPath?: string;
    useNvm: boolean;
    nvmSh?: string;
    /**
     * The interpreter hooks are written for. Defaults per platform (bash on
     * POSIX, PowerShell on Windows) — a setting, never an assumption, so a
     * Windows ship needs no change to the hook contract.
     *
     * This is the ship-local stand-in for what belongs on the **Ship record**
     * (CREW_PRD §15): a ship's host platform is a fact the project needs, not
     * just this process, because hooks are written per-platform and a role
     * cannot be handed to a ship that cannot run its hooks. See ISSUE-328.
     */
    shell?: string;
  };
  paths: { stateDir: string; logFile: string; crewHome: string; configFile: string };
}

export class ConfigError extends Error {}

function expand(p: string, base: string): string {
  let out = p.startsWith('~') ? p.replace(/^~/, homedir()) : p;
  out = out.replace(/\$\{?HOME\}?/g, homedir());
  return isAbsolute(out) ? out : resolve(base, out);
}

/**
 * Collects every missing setting instead of throwing on the first, so filling
 * in a fresh crew.yaml takes one pass rather than one run per field.
 */
class Missing {
  private readonly paths: string[] = [];
  req<T>(v: T | undefined | null, path: string): T {
    if (v === undefined || v === null || v === '') {
      this.paths.push(path);
      return '' as unknown as T;
    }
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

/** Locate crew.yaml: $CREW_CONFIG, else alongside the installation. */
export function findConfigFile(crewHome: string): string {
  const explicit = process.env.CREW_CONFIG;
  if (explicit) return resolve(explicit);
  return resolve(crewHome, 'crew.yaml');
}

export function loadConfig(crewHome: string, configFile?: string): CrewConfig {
  const file = configFile ?? findConfigFile(crewHome);
  if (!existsSync(file)) {
    throw new ConfigError(
      `no config at ${file} — copy crew.example.yaml to crew.yaml and fill it in`,
    );
  }
  const raw = parse(readFileSync(file, 'utf8')) as Record<string, any> | null;
  if (!raw || typeof raw !== 'object') throw new ConfigError(`${file} is empty or not a mapping`);
  const base = dirname(file);

  const missing = new Missing();
  const req = <T,>(v: T | undefined | null, path: string): T => missing.req(v, path);

  const projectDir = expand(req(raw.project?.dir, 'project.dir'), base) as string;
  const holds: HoldConfig[] = Array.isArray(raw.crew?.holds)
    ? raw.crew.holds.map((h: any, i: number) =>
        typeof h === 'string'
          ? { id: h }
          : { id: req(h?.id, `crew.holds[${i}].id`), role: h?.role ?? '' },
      )
    : [];

  const seats: Partial<Record<RoleName, string>> = {};
  for (const role of ['dev', 'design', 'qa', 'triage'] as RoleName[]) {
    const id = raw.crew?.seats?.[role];
    if (id) seats[role] = id;
  }
  if (Object.keys(seats).length === 0) missing.add('crew.seats (at least one of dev/design/qa/triage)');

  const tracker = {
    baseUrl: (req(raw.tracker?.baseUrl, 'tracker.baseUrl') as string).replace(/\/+$/, ''),
    workspaceId: req(raw.tracker?.workspaceId, 'tracker.workspaceId') as string,
    models: {
      issues: req(raw.tracker?.models?.issues, 'tracker.models.issues') as string,
      comments: req(raw.tracker?.models?.comments, 'tracker.models.comments') as string,
      crew: req(raw.tracker?.models?.crew, 'tracker.models.crew') as string,
    },
  };
  const operator = req(raw.crew?.operator, 'crew.operator') as string;
  const worktreePrefix = req(raw.project?.worktreePrefix, 'project.worktreePrefix') as string;
  const platformRaw = String(raw.project?.platform ?? 'any');
  if (!isPlatformRequirement(platformRaw)) {
    missing.add(`project.platform must be one of any|unix|macos|linux|windows (got "${platformRaw}")`);
  }
  missing.throwIfAny(file);

  const versionFiles: string[] = Array.isArray(raw.release?.versionFiles)
    ? raw.release.versionFiles
    : raw.release?.versionFile
      ? [raw.release.versionFile]
      : ['package.json'];

  return {
    enabled: raw.enabled === true,
    project: { dir: projectDir, worktreePrefix, platform: platformRaw as PlatformRequirement },
    tracker: {
      ...tracker,
      apiKey: raw.tracker?.apiKey,
      apiKeyFile: raw.tracker?.apiKeyFile ? expand(raw.tracker.apiKeyFile, projectDir) : undefined,
      apiKeyVar: raw.tracker?.apiKeyVar,
      // Cloudflare 403s default curl/python agents on this host; keep a real-ish one.
      userAgent: raw.tracker?.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0',
    },
    crew: { seats, operator, holds },
    agent: {
      bin: expand(raw.agent?.bin ?? 'claude', base),
      model: raw.agent?.model ?? 'claude-sonnet-5',
    },
    hooks: {
      test: raw.hooks?.test,
      build: raw.hooks?.build,
      deploy: raw.hooks?.deploy,
      notify: raw.hooks?.notify,
    },
    labels: {
      test: raw.labels?.test ?? raw.hooks?.test,
      build: raw.labels?.build ?? raw.hooks?.build,
      deploy: raw.labels?.deploy ?? raw.hooks?.deploy,
    },
    release: { versionFiles, changelog: raw.release?.changelog ?? 'CHANGELOG.md' },
    runtime: {
      extraPath: raw.runtime?.extraPath,
      useNvm: raw.runtime?.useNvm !== false,
      nvmSh: raw.runtime?.nvmSh,
      shell: raw.runtime?.shell,
    },
    paths: {
      crewHome,
      configFile: file,
      stateDir: expand(raw.paths?.stateDir ?? '.state', crewHome),
      logFile: expand(raw.paths?.logFile ?? join(tmpdir(), 'tablation-crew.log'), crewHome),
    },
  };
}

/** The API key, from the config or from a KEY=value file. Never logged. */
export function resolveApiKey(cfg: CrewConfig): string {
  if (cfg.tracker.apiKey) return cfg.tracker.apiKey;
  const { apiKeyFile, apiKeyVar } = cfg.tracker;
  if (apiKeyFile && apiKeyVar && existsSync(apiKeyFile)) {
    for (const line of readFileSync(apiKeyFile, 'utf8').split('\n')) {
      const m = line.match(new RegExp(`^${apiKeyVar}=(.*)$`));
      if (m) return (m[1] ?? '').trim().replace(/^["']|["']$/g, '');
    }
  }
  throw new ConfigError(
    `no tracker API key (tracker.apiKey, or ${apiKeyVar ?? 'VAR'} in ${apiKeyFile ?? '<unset>'})`,
  );
}

/** Seats and holds as the roster builder wants them. */
export function configuredMembers(cfg: CrewConfig) {
  const ROLE_LABEL: Record<RoleName, string> = {
    dev: 'Dev', design: 'Design', qa: 'QA', triage: 'Triage',
  };
  const out: Array<{ id: string; role: string; kind: 'seat' | 'hold' }> = [];
  for (const [role, id] of Object.entries(cfg.crew.seats)) {
    if (id) out.push({ id, role: ROLE_LABEL[role as RoleName], kind: 'seat' });
  }
  out.push({ id: cfg.crew.operator, role: 'Operator', kind: 'hold' });
  for (const h of cfg.crew.holds) out.push({ id: h.id, role: h.role ?? '', kind: 'hold' });
  return out;
}

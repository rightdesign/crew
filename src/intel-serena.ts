/**
 * The `serena` flavor of `hooks.intel` (EPIC-078, CREW-2914).
 *
 * Crew drives Serena (`serena-agent`) as a per-worktree symbol service. Nothing is
 * written into the worktree: everything lives under `<stateDir>/intel/`:
 *
 *   <route>/main/                 project folder for the main checkout; its `cache/` seeds worktrees
 *   <route>/<ticket>/             project folder for one worktree, removed with it
 *
 * Each project folder carries its own `home/` (SERENA_HOME): Serena reads one
 * `project_serena_folder_location` per config, so a config shared by the main-checkout
 * index and several worktree services would race on every start.
 *
 * Serena's document-symbol cache maps a path relative to the project root to a content
 * hash and its symbols, so a cache built on the main checkout is valid for any worktree
 * of the same repository: unchanged files hit, changed ones are re-indexed on demand.
 * The cache is copied, never shared, because two servers must not write one cache.
 *
 * Every side effect goes through `SerenaDeps` so the sequencing is testable.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { intelPortFor } from './ports.ts';
import { INTEL_FLAVORS } from './intel.ts';
import type { HookResult } from './periscope-cmd.ts';

export interface SerenaPaths {
  /** SERENA_HOME for the worktree's service and for the main-checkout index. */
  home: string;
  mainHome: string;
  mainProject: string;
  project: string;
}

export const serenaPaths = (stateDir: string, route: string, ticket: string): SerenaPaths => ({
  home: join(stateDir, 'intel', route, ticket, 'home'),
  mainHome: join(stateDir, 'intel', route, 'main', 'home'),
  mainProject: join(stateDir, 'intel', route, 'main'),
  project: join(stateDir, 'intel', route, ticket),
});

/** The folder a worktree's intel state lives in; removed with the worktree. */
export const serenaFolderFor = (stateDir: string, route: string, ticket: string): string => serenaPaths(stateDir, route, ticket).project;

/** `serena_config.yml` for the per-ship home. `projectFolder` is the folder this service keeps its project state in. */
export function serenaConfigYaml(projectFolder: string): string {
  return [
    '# Written by crew (CREW-2914); regenerated on every start.',
    'web_dashboard: False',
    `project_serena_folder_location: ${JSON.stringify(projectFolder)}`,
    '',
  ].join('\n');
}

/** The project settings for a folder: the repository's committed `.serena/project.yml` (or none), forced read-only. */
export function serenaProjectYaml(committed: string | undefined): string {
  const base = committed ?? '';
  if (/^read_only\s*:/m.test(base)) return base.replace(/^read_only\s*:.*$/m, 'read_only: true');
  return `${base}${base && !base.endsWith('\n') ? '\n' : ''}read_only: true\n`;
}

export function serenaServeArgs(port: number, worktree: string): string[] {
  return [
    'start-mcp-server', '--transport', 'streamable-http', '--host', '127.0.0.1', '--port', String(port),
    '--project', worktree, '--context', 'ide', '--mode', 'no-memories', '--mode', 'no-onboarding',
  ];
}

export const serenaIndexArgs = (checkout: string): string[] => ['project', 'index', checkout];

export interface SerenaDeps {
  onPath(bin: string): boolean;
  exists(path: string): boolean;
  mkdir(path: string): void;
  read(path: string): string | undefined;
  write(path: string, text: string): void;
  copyDir(from: string, to: string): void;
  /** HEAD of the main checkout. */
  headOf(checkout: string): string | undefined;
  /** Starts `bin args` detached with output appended to `log`; returns its pid. */
  spawnDetached(bin: string, args: string[], env: Record<string, string>, log: string): number;
  /** Starts the main-checkout index detached; `onDone` text is written to `stamp` only when the index succeeds. */
  spawnIndex(args: string[], env: Record<string, string>, log: string, stamp: string, stampText: string): number;
  alive(pid: number): boolean;
  /** Makes `path` a symlink to `target`; absent in test doubles that do not exercise it. */
  link?(target: string, path: string): void;
}

export interface SerenaStart {
  stateDir: string;
  route: string;
  /** Digits only; keys the port and the project folder. */
  ticket: number;
  worktree: string;
  /** The route's main checkout. */
  mainCheckout: string;
  /** A sandbox run (CREW-2922) has no main checkout to keep an index of: skip the background index. */
  noMainIndex?: boolean;
  /**
   * A symbol cache to start from instead of the main checkout's (CREW-2924): a sandbox's copy of
   * the index the host keeps on the cache volume. Copied, never shared; the volume is read-only.
   */
  seedCache?: string;
  /**
   * Language servers already on disk (the sandbox image's, CREW-2915). Linked into the service's
   * home so it finds them without a download, which a sandboxed run cannot make.
   */
  languageServers?: string;
}

const fail = (output: string): HookResult => ({ code: 1, output });

/** Names the prerequisites of a flavor that are not on PATH, each with its install line. */
export function missingPrerequisites(flavor: keyof typeof INTEL_FLAVORS, onPath: (bin: string) => boolean): string[] {
  return INTEL_FLAVORS[flavor].prerequisites.filter((p) => !onPath(p.bin)).map((p) => `${p.bin} (${p.install})`);
}

/** Writes the per-ship config and a project folder's settings; returns nothing, throws on I/O failure. */
function prepareFolder(d: SerenaDeps, home: string, folder: string, checkout: string): void {
  d.mkdir(home);
  d.mkdir(folder);
  d.write(join(home, 'serena_config.yml'), serenaConfigYaml(folder));
  d.write(join(folder, 'project.yml'), serenaProjectYaml(d.read(join(checkout, '.serena', 'project.yml'))));
}

/** Re-indexes the main checkout in the background when it has moved since the last index. */
export function ensureMainIndex(d: SerenaDeps, s: SerenaStart): 'fresh' | 'started' | 'running' | 'unavailable' {
  const p = serenaPaths(s.stateDir, s.route, String(s.ticket));
  const head = d.headOf(s.mainCheckout);
  if (!head) return 'unavailable';
  const stamp = join(p.mainProject, 'indexed-commit');
  if (d.read(stamp)?.trim() === head) return 'fresh';
  const pidFile = join(p.mainProject, 'indexing.pid');
  const running = Number(d.read(pidFile));
  if (running > 0 && d.alive(running)) return 'running';
  prepareFolder(d, p.mainHome, p.mainProject, s.mainCheckout);
  const pid = d.spawnIndex(serenaIndexArgs(s.mainCheckout), { SERENA_HOME: p.mainHome }, join(p.mainProject, 'index.log'), stamp, head);
  d.write(pidFile, String(pid));
  return 'started';
}

/**
 * The `intel` hook for the `serena` flavor: prints the service URL as its last line, like a
 * repository's own hook would. Detached, so it outlives the call; the probe waits for it.
 */
export function startSerena(d: SerenaDeps, s: SerenaStart): HookResult {
  const missing = missingPrerequisites('serena', d.onPath);
  if (missing.length) return fail(`intel: serena needs ${missing.join(' and ')} on PATH`);
  const p = serenaPaths(s.stateDir, s.route, String(s.ticket));
  try {
    prepareFolder(d, p.home, p.project, s.worktree);
    if (s.languageServers && d.exists(s.languageServers) && d.link) {
      const dest = join(p.home, 'language_servers');
      if (!d.exists(dest)) d.link(s.languageServers, dest);
    }
    // A worktree's first start takes the main checkout's cache (a sandbox's: the host's seeded one); later starts keep their own.
    const mainCache = s.seedCache ?? join(p.mainProject, 'cache');
    const cache = join(p.project, 'cache');
    if (!d.exists(cache) && d.exists(mainCache)) d.copyDir(mainCache, cache);
    // Index the main checkout for the next worktree; never delays this start.
    try { if (!s.noMainIndex) ensureMainIndex(d, s); } catch { /* an index that cannot start costs the next worktree its head start, nothing more */ }
    const port = intelPortFor(s.ticket);
    d.spawnDetached('serena', serenaServeArgs(port, s.worktree), { SERENA_HOME: p.home }, join(p.project, 'serena.log'));
    return { code: 0, output: `http://127.0.0.1:${port}/mcp\n` };
  } catch (e) {
    return fail(`intel: serena could not start: ${(e as Error).message}`);
  }
}

/** The real side effects. `onPath` is the caller's (it knows the scheduler PATH). */
export function realSerenaDeps(onPath: (bin: string) => boolean, extraEnv: NodeJS.ProcessEnv = process.env): SerenaDeps {
  const detached = (bin: string, args: string[], env: Record<string, string>, log: string): number => {
    mkdirSync(dirname(log), { recursive: true });
    const fd = openSync(log, 'a');
    const child = spawn(bin, args, { detached: true, stdio: ['ignore', fd, fd], env: { ...extraEnv, ...env } });
    child.unref();
    closeSync(fd);
    if (!child.pid) throw new Error(`could not start ${bin}`);
    return child.pid;
  };
  return {
    onPath,
    exists: existsSync,
    mkdir: (p) => { mkdirSync(p, { recursive: true }); },
    read: (p) => { try { return readFileSync(p, 'utf8'); } catch { return undefined; } },
    write: (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); },
    copyDir: (from, to) => cpSync(from, to, { recursive: true }),
    headOf: (checkout) => {
      const r = spawnSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      return r.status === 0 ? r.stdout.trim() : undefined;
    },
    spawnDetached: detached,
    // `&&` so the stamp exists only for an index that finished; a killed one is retried next start.
    spawnIndex: (args, env, log, stamp, stampText) =>
      detached('sh', ['-c', 'serena "$@" && printf %s "$STAMP_TEXT" > "$STAMP_FILE"', 'serena', ...args], { ...env, STAMP_FILE: stamp, STAMP_TEXT: stampText }, log),
    link: (target, path) => symlinkSync(target, path),
    alive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
  };
}

/** Removes a worktree's intel folder (service state, cache, config); the main-checkout index is untouched. */
export function dropSerenaFolder(stateDir: string, route: string, ticket: string): void {
  if (ticket === 'main') return;
  rmSync(serenaFolderFor(stateDir, route, ticket), { recursive: true, force: true });
}

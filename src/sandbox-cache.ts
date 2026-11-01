/**
 * The sandbox cache volume (CREW-2799, EPIC-075 Map v1 §4).
 *
 * One named volume per route on the ship's container engine holds a bare
 * mirror of every served repository, plus a `cache/` area for warmed
 * dependency trees. A sandbox run mounts it read-only and clones from the
 * mirror with `--shared`, so a clone of the largest repository takes seconds
 * and never touches the forge.
 *
 * Layout inside the volume:
 *
 *   mirrors/<forge host>/<remote path>.git                 bare mirror (+ `crew-last-refresh`)
 *   cache/deps/<forge host>/<remote path>/<lockfile hash>/ node_modules trees, relative paths kept
 *
 * Only the host writes the volume (through short helper containers), so every
 * sandbox mount stays read-only. On Docker Desktop the volume lives inside the
 * engine's virtual machine; it is never a host bind mount.
 *
 * A refresh never rewrites a path a run may be reading: `git fetch --atomic`
 * adds objects before it moves any ref, nothing is garbage collected or pruned
 * (`gc.auto=0`), and a first clone lands in a temporary path and is renamed
 * into place. A concurrent lane's `--shared` clone therefore sees either the
 * state before a refresh or the state after it, and an alternate that was
 * valid when the run began stays valid. Two refreshes of one mirror are kept
 * apart by the caller holding the checkout lock.
 *
 * Every effect on the engine goes through the injected `exec`, so the module
 * is tested against a fake `docker`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DOCKER_LABEL_CACHE, DOCKER_LABEL_OWNER } from './deprovision-host.ts';
import type { SandboxConfig } from './runner.ts';
import { DEFAULT_FORGE_HOST, DEFAULT_FORGE_USERNAME, forgeDescriptorFor, normalizeForgeHost } from './forges.ts';

const execFileP = promisify(execFile);

export type CacheExec = (bin: string, args: string[], o?: { env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>;

const realExec: CacheExec = (bin, args, o) => execFileP(bin, args, { env: o?.env ?? process.env, maxBuffer: 16 * 1024 * 1024 });

export const OPENSHELL_ATTACHABLE_LABEL = 'openshell.ai/sandbox-attachable=true';
export const OPENSHELL_WORKSPACE_LABEL = 'openshell.ai/sandbox-attachable-workspace';

/** Where the volume is mounted in a helper container (the sandbox mount point is `SandboxConfig.mirrorDir`). */
const VOLUME_ROOT = '/cache';

export interface CacheSettings {
  /** The container engine CLI. */
  engine: string;
  /** Volume name; absent means the sandbox cache is off. */
  volume: string;
  /** Value of the OpenShell workspace label on the volume. */
  workspace: string;
  /** Image the git helper containers run (needs `git`, `sh`, `base64`). */
  helperImage: string;
  /** Image deps are built in: the repository's own toolchain. Absent with `depsCommand` unset means no deps cache. */
  depsImage?: string;
  /** Command that installs dependencies in a fresh checkout, for example `pnpm install --frozen-lockfile`. */
  depsCommand?: string;
  /** Lockfile whose hash keys the dependency tree. */
  depsLockfile: string;
}

export const DEFAULT_CACHE_SETTINGS = {
  engine: 'docker', workspace: 'crew', helperImage: 'alpine/git:latest', depsLockfile: 'pnpm-lock.yaml',
} as const;

/** A repository as the cache knows it: where it lives on the forge. */
export interface CacheRepo {
  host: string;
  /** `owner/repo`, or nested groups on GitLab; no `.git`. */
  path: string;
}

/** Splits an origin URL (https, ssh:// or scp-style) into forge host and remote path. Null when it is neither. */
export function parseRemote(url: string): CacheRepo | null {
  const u = url.trim();
  const m = /^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(u) ?? /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+?)(?:\.git)?\/?$/.exec(u);
  if (!m) return null;
  return { host: normalizeForgeHost(m[1]) || DEFAULT_FORGE_HOST, path: m[2]!.replace(/^\/+/, '') };
}

/** Path of a repository's mirror, relative to the volume root. */
export function mirrorRelPath(r: CacheRepo): string {
  return `mirrors/${r.host}/${r.path}.git`;
}

/** Path of a repository's dependency trees, relative to the volume root. */
export function depsRelDir(r: CacheRepo): string {
  return `cache/deps/${r.host}/${r.path}`;
}

/** POSIX single-quote. */
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The sandbox-side part of a run's setup: a `--shared` clone of the mirror,
 * then, when a dependency tree for the checkout's lockfile hash exists, a copy
 * of it into the checkout. Plain copies (not `-a`) so files belong to the
 * sandbox user; symlinks are kept as links.
 */
export function cloneScript(o: { mirrorDir: string; repo: CacheRepo; workDir: string; origin: string; branch: string; lockfile: string }): string {
  const mirror = `${o.mirrorDir}/${mirrorRelPath(o.repo)}`;
  const depsRoot = `${o.mirrorDir}/${depsRelDir(o.repo)}`;
  return [
    `git clone --quiet --shared ${q(mirror)} ${q(o.workDir)}`,
    `cd ${q(o.workDir)}`,
    `git remote set-url origin ${q(o.origin)}`,
    `git checkout --quiet -b ${q(o.branch)}`,
    // A missing lockfile or tree is not an error: the run installs as it would without a cache.
    `{ if [ -f ${q(o.lockfile)} ]; then h=$(sha256sum ${q(o.lockfile)} | cut -c1-16); d=${q(depsRoot)}/$h; ` +
      `[ -d "$d" ] && cp -R -P "$d"/. . ; fi; true; }`,
  ].join(' && ');
}

const REFRESH_SCRIPT = `
set -e
m=${VOLUME_ROOT}/"$1"; url="$2"
export GIT_TERMINAL_PROMPT=0
git config --global --add safe.directory '*'
if [ -n "$CREW_FORGE_TOKEN" ]; then
  H="Authorization: Basic $(printf '%s:%s' "$CREW_FORGE_USER" "$CREW_FORGE_TOKEN" | base64 | tr -d '\\n')"
  git() { command git -c "http.extraHeader=$H" "$@"; }
fi
if [ -d "$m" ]; then
  git -C "$m" fetch --prune --atomic --quiet origin
else
  mkdir -p "$(dirname "$m")"; rm -rf "$m.tmp"
  git clone --mirror --quiet "$url" "$m.tmp"
  git -C "$m.tmp" config gc.auto 0
  mv "$m.tmp" "$m"
fi
date -u +%Y-%m-%dT%H:%M:%SZ > "$m/crew-last-refresh"
`;

/** Builds the dependency tree for the mirror's current lockfile when the volume has none for that hash. */
const DEPS_SCRIPT = `
set -e
m=${VOLUME_ROOT}/"$1"; droot=${VOLUME_ROOT}/"$2"; lock="$3"
export GIT_TERMINAL_PROMPT=0
git config --global --add safe.directory '*'
git -C "$m" cat-file -e HEAD:"$lock" 2>/dev/null || exit 0
h=$(git -C "$m" show HEAD:"$lock" | sha256sum | cut -c1-16)
[ -d "$droot/$h" ] && exit 0
w=$(mktemp -d); trap 'rm -rf "$w"' EXIT
git clone --quiet --shared "$m" "$w/src"
cd "$w/src"
sh -c "$CREW_DEPS_COMMAND"
mkdir -p "$droot/$h.tmp"
find . -name node_modules -type d -prune | while read -r p; do
  mkdir -p "$droot/$h.tmp/$(dirname "$p")"; cp -R -P "$p" "$droot/$h.tmp/$p"
done
rm -rf "$droot/$h"; mv "$droot/$h.tmp" "$droot/$h"
`;

/**
 * Writes a mirror's base-branch tip into a host directory (CREW-2807). The
 * helper reads the volume and mounts the checkout's parent at /out. Files
 * are extracted over the existing tree and the ones the tip no longer has are
 * removed, so a container bind-mounting the directory keeps seeing one
 * directory (a swap would leave it holding the old, deleted one). `<name>.tip`
 * and `<name>.files` sit beside the checkout, never inside it.
 */
const MATERIALIZE_SCRIPT = `
set -e
export GIT_TERMINAL_PROMPT=0
m=${VOLUME_ROOT}/"$1"; name="$2"; base="$3"; out=/out; d="$out/$name"
git config --global --add safe.directory '*'
tip=$(git -C "$m" rev-parse --verify --quiet "refs/heads/$base^{commit}") || { echo "the mirror has no branch $base" >&2; exit 3; }
if [ -d "$d" ] && [ -f "$out/$name.tip" ] && [ "$(cat "$out/$name.tip")" = "$tip" ]; then echo "unchanged $tip"; exit 0; fi
mkdir -p "$d"
git -C "$m" ls-tree -r --name-only "$tip" | LC_ALL=C sort > "$out/$name.files.new"
git -C "$m" archive "$tip" | tar -x -C "$d"
if [ -f "$out/$name.files" ]; then
  LC_ALL=C comm -23 "$out/$name.files" "$out/$name.files.new" | while IFS= read -r f; do rm -f "$d/$f"; done
fi
mv "$out/$name.files.new" "$out/$name.files"
printf '%s\n' "$tip" > "$out/$name.tip"
echo "updated $tip"
`;

export interface MaterializeOutcome { tip: string; changed: boolean }

export interface MirrorInfo { repo: CacheRepo; lastRefresh: string | null }
export interface RefreshOutcome { repo: CacheRepo; ok: boolean; detail?: string }

export class SandboxCache {
  private readonly s: CacheSettings;
  private readonly exec: CacheExec;

  constructor(s: CacheSettings, exec: CacheExec = realExec) {
    this.s = s;
    this.exec = exec;
  }

  private engine(args: string[], env?: NodeJS.ProcessEnv) { return this.exec(this.s.engine, args, { env }); }

  /** Creates the volume with the labels OpenShell and `crew deprovision` look for, if it is not there. */
  async ensureVolume(): Promise<boolean> {
    try { await this.engine(['volume', 'inspect', this.s.volume]); return false; } catch { /* not there yet */ }
    await this.engine([
      'volume', 'create', '--label', OPENSHELL_ATTACHABLE_LABEL, '--label', `${OPENSHELL_WORKSPACE_LABEL}=${this.s.workspace}`,
      '--label', DOCKER_LABEL_OWNER, '--label', DOCKER_LABEL_CACHE, this.s.volume,
    ]);
    return true;
  }

  private helper(
    image: string, script: string, args: string[], env: Record<string, string> = {}, extra: string[] = [],
  ): Promise<{ stdout: string; stderr: string }> {
    // `-e NAME` takes the value from the child's environment, so a token never reaches argv.
    const flags = Object.keys(env).flatMap((k) => ['-e', k]);
    return this.engine(['run', '--rm', '--label', DOCKER_LABEL_OWNER, '-v', `${this.s.volume}:${VOLUME_ROOT}`, ...extra, ...flags, '--entrypoint', 'sh', image, '-c', script, 'sh', ...args], { ...process.env, ...env });
  }

  /**
   * Refreshes every mirror (and, where configured, its dependency tree). One
   * repository failing does not stop the others; the caller raises attention
   * for the failures and the runs keep using the previous mirror state.
   */
  async refresh(repos: Array<CacheRepo & { token?: string | null; username?: string }>): Promise<RefreshOutcome[]> {
    await this.ensureVolume();
    const out: RefreshOutcome[] = [];
    for (const r of repos) {
      const env: Record<string, string> = r.token ? { CREW_FORGE_TOKEN: r.token, CREW_FORGE_USER: r.username ?? DEFAULT_FORGE_USERNAME } : {};
      try {
        await this.helper(this.s.helperImage, REFRESH_SCRIPT, [mirrorRelPath(r), forgeDescriptorFor(r.host).httpsUrl(r.host, r.path)], env);
      } catch (e) {
        out.push({ repo: r, ok: false, detail: describe(e) });
        continue;
      }
      if (this.s.depsCommand && this.s.depsImage) {
        try {
          await this.helper(this.s.depsImage, DEPS_SCRIPT, [mirrorRelPath(r), depsRelDir(r), this.s.depsLockfile], { CREW_DEPS_COMMAND: this.s.depsCommand });
        } catch (e) {
          // The mirror is current; only the warmed tree is stale, and a run falls back to installing.
          out.push({ repo: r, ok: false, detail: `dependency tree: ${describe(e)}` });
          continue;
        }
      }
      out.push({ repo: r, ok: true });
    }
    return out;
  }

  /**
   * Makes `<parentDir>/<name>` hold the tree at the tip of `base` in the
   * repository's mirror, owned by the host user so crew can remove it. Reads
   * the mirror only; the refresh that moves the tip is `refresh`.
   */
  async materialize(repo: CacheRepo, base: string, parentDir: string, name: string): Promise<MaterializeOutcome> {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    const extra = ['-v', `${parentDir}:/out`, ...(uid === undefined || gid === undefined ? [] : ['--user', `${uid}:${gid}`, '-e', 'HOME=/tmp'])];
    const { stdout } = await this.helper(this.s.helperImage, MATERIALIZE_SCRIPT, [mirrorRelPath(repo), name, base], {}, extra);
    const m = /^(updated|unchanged) (\S+)/m.exec(stdout);
    if (!m) throw new Error(`unexpected output materializing ${repo.host}/${repo.path}: ${stdout.trim().slice(0, 200)}`);
    return { tip: m[2]!, changed: m[1] === 'updated' };
  }

  /** Mirrors in the volume with their last refresh; empty when the volume does not exist. */
  async list(): Promise<MirrorInfo[]> {
    try { await this.engine(['volume', 'inspect', this.s.volume]); } catch { return []; }
    const script = `cd ${VOLUME_ROOT}/mirrors 2>/dev/null || exit 0; find . -name '*.git' -type d -prune | while read -r d; do printf '%s\\t%s\\n' "\${d#./}" "$(cat "$d/crew-last-refresh" 2>/dev/null)"; done`;
    const { stdout } = await this.helper(this.s.helperImage, script, []);
    const rows: MirrorInfo[] = [];
    for (const line of stdout.split('\n').filter(Boolean)) {
      const [rel, when] = line.split('\t');
      const m = /^([^/]+)\/(.+)\.git$/.exec(rel ?? '');
      if (m) rows.push({ repo: { host: m[1]!, path: m[2]! }, lastRefresh: when?.trim() || null });
    }
    return rows;
  }

  /** Drops mirrors (and their dependency trees) for repositories not in `keep`. Returns what was dropped. */
  async prune(keep: CacheRepo[]): Promise<CacheRepo[]> {
    const have = new Set(keep.map((r) => `${r.host}/${r.path}`));
    const drop = (await this.list()).map((m) => m.repo).filter((r) => !have.has(`${r.host}/${r.path}`));
    for (const r of drop) {
      await this.helper(this.s.helperImage, `rm -rf ${VOLUME_ROOT}/${q(mirrorRelPath(r))} ${VOLUME_ROOT}/${q(depsRelDir(r))}`, []);
    }
    return drop;
  }

  /** Recreates the volume empty; the next pass refreshes every mirror. */
  async reset(): Promise<void> {
    try { await this.engine(['volume', 'rm', '--force', this.s.volume]); } catch (e) { throw new Error(`could not remove volume ${this.s.volume}: ${describe(e)}`); }
    await this.ensureVolume();
  }
}

function describe(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  return (err.stderr?.trim() || err.message || String(e)).split('\n').slice(-3).join(' / ');
}

/** The cache settings a `ship.sandbox` block implies; null when it names no cache volume. */
export function cacheSettingsOf(cfg: Partial<SandboxConfig> | undefined): CacheSettings | null {
  if (!cfg?.cacheVolume) return null;
  return {
    engine: cfg.engine ?? DEFAULT_CACHE_SETTINGS.engine,
    volume: cfg.cacheVolume,
    workspace: cfg.cacheWorkspace ?? DEFAULT_CACHE_SETTINGS.workspace,
    helperImage: cfg.cacheImage ?? DEFAULT_CACHE_SETTINGS.helperImage,
    depsImage: cfg.depsImage ?? cfg.image,
    depsCommand: cfg.depsCommand,
    depsLockfile: cfg.depsLockfile ?? DEFAULT_CACHE_SETTINGS.depsLockfile,
  };
}

export type PassRepo = CacheRepo & { dir: string; token?: string | null; username?: string };

export const sandboxCacheKey = (volume: string, r: CacheRepo): string => `sandbox_cache:${volume}:${r.host}/${r.path}`;

/** Passes closer together than this reuse the last refresh; the poll cadence is far shorter than a forge needs. */
export const CACHE_REFRESH_INTERVAL_MS = 60_000;

/**
 * The between-passes refresh. Each repository is refreshed under its primary
 * checkout's lock (the same one the poll-cadence sync takes), so two routes
 * sharing a repository never refresh its mirror at once. A failure is reported
 * and the previous mirror state stays in use; success closes the report.
 */
export function makeCachePass(o: {
  cache: SandboxCache;
  volume: string;
  repos: () => PassRepo[];
  lock: (dir: string) => () => void;
  fail: (key: string, message: string) => Promise<void> | void;
  ok: (key: string) => void;
  now?: () => number;
}): () => Promise<RefreshOutcome[]> {
  const now = o.now ?? Date.now;
  let last = -Infinity;
  return async () => {
    if (now() - last < CACHE_REFRESH_INTERVAL_MS) return [];
    last = now();
    const all: RefreshOutcome[] = [];
    for (const r of o.repos()) {
      let release: (() => void) | undefined;
      try {
        release = o.lock(r.dir);
        all.push(...await o.cache.refresh([r]));
      } catch (e) {
        all.push({ repo: r, ok: false, detail: describe(e) });
      } finally { release?.(); }
    }
    for (const out of all) {
      const key = sandboxCacheKey(o.volume, out.repo);
      if (out.ok) o.ok(key);
      else await o.fail(key, `sandbox cache: ${out.repo.host}/${out.repo.path} did not refresh (${out.detail}); runs use the previous mirror. Resumes automatically when a later pass refreshes it`);
    }
    return all;
  };
}

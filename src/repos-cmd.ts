/**
 * `crew repos add|list` (CREW-1287): attach a local checkout to a route
 * without hand-editing `crew.yaml`.
 *
 * Works on the route's RAW yaml, not a parsed `Route`: a freshly connected
 * route that names no `dir`/`repos` yet fails `loadConfig`'s validation and is
 * dropped from `cfg.routes`, and that is precisely the route this command
 * exists to fix. Editing goes through `yaml`'s Document API so comments and
 * ordering survive; other routes are never touched.
 *
 * The pure planning lives here (text in, text out) so it is tested without a
 * git checkout; `cli.ts` supplies the git facts and does the file write.
 */

import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { isMap, isSeq, parseDocument, stringify, type Document, type YAMLMap } from 'yaml';

export class ReposError extends Error {}

/** What the tracker's `Repos` table says about a route, from `crew connect`'s resolved file. */
export interface RepoRemotes {
  /** repo id -> name */
  repoNames?: Record<string, string>;
  /** repo id -> `owner/repo` */
  repoRemotes?: Record<string, string>;
}

/**
 * A git remote URL -> `owner/repo`, lower-cased for comparison. Handles scp
 * style (`git@github.com:o/r.git`), `ssh://` and `https://` forms, and a bare
 * `owner/repo` (the tracker's own shape). Undefined when it is none of those.
 */
export function normalizeRemote(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  let s = url.trim();
  if (!s) return undefined;
  const scp = /^[^\s@/]+@[^\s:/]+:(.+)$/.exec(s);
  if (scp) s = scp[1]!;
  else s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?[^/]+\//i, '');
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return undefined;
  return parts.slice(-2).join('/').toLowerCase();
}

/** The Repos-table name whose remote matches `origin`, if any. */
export function matchRepoName(origin: string | undefined, resolved: RepoRemotes | undefined): string | undefined {
  const want = normalizeRemote(origin);
  if (!want || !resolved?.repoRemotes) return undefined;
  for (const [id, remote] of Object.entries(resolved.repoRemotes)) {
    if (normalizeRemote(remote) === want) return resolved.repoNames?.[id];
  }
  return undefined;
}

export interface RepoEntry { name: string; dir: string }

export interface AddPlan {
  /** The whole file, with the route edited. */
  text: string;
  /** `dir` for a route's first repo, `repos` once it has more than one. */
  mode: 'dir' | 'repos';
  name: string;
  /** The route block as it now reads, for `--dry-run`. */
  block: string;
  /** Set when the tracker has no Repos row for this checkout's origin. */
  warning?: string;
  /** True when no Repos row matches (or the checkout has no origin to match on). */
  unmatched: boolean;
}

export interface AddInput {
  text: string;
  /** Directory the config file lives in, for resolving a relative `dir` already there. */
  base: string;
  route: string;
  /** Absolute checkout path (already verified to be a git checkout). */
  path: string;
  /** The checkout's `origin` URL, if it has one. */
  origin?: string;
  resolved?: RepoRemotes;
  /** `--name`: the repo's name when no Repos row names it already. */
  name?: string;
  /** The name for a checkout already on the route (its `dir:`), given its path. */
  nameForExisting?: (dir: string) => string | undefined;
}

function expandDir(p: string, base: string): string {
  const home = p === '~' ? homedir() : p.startsWith('~/') ? `${homedir()}/${p.slice(2)}` : p;
  return resolve(base, home);
}

export function routeMapOf(doc: Document.Parsed, route: string): YAMLMap {
  const routes = doc.get('routes', true);
  if (isSeq(routes)) {
    for (const item of routes.items) {
      if (isMap(item) && item.get('route') === route) return item;
    }
  }
  const have = isSeq(routes)
    ? routes.items.map((i) => (isMap(i) ? String(i.get('route')) : '?')).join(', ')
    : 'none';
  throw new ReposError(`no route "${route}" in the config (have: ${have})`);
}

/** The checkouts a route's yaml configures, `dir:` or `repos:`, with `dir` resolved against `base`. */
export function configuredRepos(text: string, route: string, base: string): RepoEntry[] {
  const doc = parseDocument(text);
  const m = routeMapOf(doc, route);
  const repos = m.get('repos');
  if (isMap(repos)) {
    return repos.items.map((p) => {
      const name = String((p.key as { value?: unknown }).value ?? p.key);
      const v = p.value;
      const dir = isMap(v) ? String(v.get('dir') ?? '') : String((v as { value?: unknown } | null)?.value ?? '');
      return { name, dir: expandDir(dir, base) };
    });
  }
  const dir = m.get('dir');
  return dir ? [{ name: basename(String(dir)), dir: expandDir(String(dir), base) }] : [];
}

/**
 * Plan adding `path` to `route`. First repo -> `dir:`. Second -> `dir:` becomes
 * a `repos:` map holding the old checkout and the new one. A route already on
 * `repos:` just gains an entry. Throws `ReposError` on a duplicate path or a
 * name that already points elsewhere.
 */
export function planRepoAdd(i: AddInput): AddPlan {
  const doc = parseDocument(i.text);
  if (doc.errors.length > 0) throw new ReposError(`config is not valid YAML — ${doc.errors[0]!.message}`);
  const m = routeMapOf(doc, i.route);
  const existing = configuredRepos(i.text, i.route, i.base);
  const target = expandDir(i.path, i.base);

  if (existing.some((e) => e.dir === target)) {
    throw new ReposError(`${target} is already configured on route ${i.route}`);
  }

  const matched = matchRepoName(i.origin, i.resolved);
  const name = matched ?? i.name ?? basename(target);
  let warning: string | undefined;
  if (!matched) {
    const known = Object.values(i.resolved?.repoNames ?? {});
    warning = i.origin
      ? `the tracker has no Repos row for remote ${normalizeRemote(i.origin) ?? i.origin}` +
        `${known.length ? ` (known: ${known.join(', ')})` : ''} — added anyway; create the row so ticket routing can find it`
      : 'this checkout has no origin remote, so it cannot be matched to a Repos row — added anyway';
  }

  const repos = m.get('repos', true);
  let mode: 'dir' | 'repos';
  if (isMap(repos)) {
    if (repos.has(name)) throw new ReposError(`route ${i.route} already has a repo named "${name}" (${String(repos.get(name))})`);
    repos.set(name, target);
    mode = 'repos';
  } else if (m.has('dir') && existing.length > 0) {
    const old = existing[0]!;
    const oldName = i.nameForExisting?.(old.dir) ?? old.name;
    if (oldName === name) throw new ReposError(`route ${i.route} already has a repo named "${name}" (${old.dir})`);
    // Turn `dir:` into `repos:` in place so the key keeps its position (and its comments).
    const oldDir = String(m.get('dir'));
    const pair = m.items.find((p) => (p.key as { value?: unknown }).value === 'dir')!;
    pair.key = doc.createNode('repos');
    pair.value = doc.createNode({ [oldName]: oldDir, [name]: target });
    mode = 'repos';
  } else {
    m.set('dir', target);
    mode = 'dir';
  }

  return { text: String(doc), mode, name, block: renderBlock(m), warning, unmatched: !matched };
}

function renderBlock(m: YAMLMap): string {
  return stringify([m.toJSON()]).trimEnd();
}

/** What a checkout's own `.crew.yaml` says that the Repos row caches (`platform`, `release_mode`, `ci_provider`). */
export interface CheckoutSpec {
  platform?: string;
  releaseMode?: string;
  ciProvider?: string;
}

/** A Repos-table `Projects` row, as much of it as picking a project needs. */
export interface ProjectChoice { id: string; name?: string }

export interface RepoRowInput {
  /** The row's `name`; the checkout's basename unless `--name` overrides it. */
  name: string;
  /** The checkout's `origin` URL. */
  origin: string;
  spec?: CheckoutSpec;
  projectId: string;
}

/** `release.mode` values the Repos table has no choice for: crew itself does the merge/release locally. */
const LOCAL_RELEASE_MODES = new Set(['integrate', 'external']);

/**
 * The Repos row to create for a checkout the tracker has no row for. Values the
 * checkout's `.crew.yaml` declares win; anything it leaves out falls to the
 * table's documented defaults (`unix` / `local` / `none`), which the API does
 * not apply on its own.
 */
export function planRepoRow(i: RepoRowInput): Record<string, unknown> {
  const remote = normalizeRemote(i.origin);
  if (!remote) throw new ReposError(`cannot derive an owner/repo from origin "${i.origin}"`);
  const mode = i.spec?.releaseMode;
  return {
    name: i.name,
    remote,
    platform: i.spec?.platform ?? 'unix',
    release_mode: mode ? (LOCAL_RELEASE_MODES.has(mode) ? 'local' : mode) : 'local',
    ci_provider: i.spec?.ciProvider ?? 'none',
    enabled: true,
    project_id: i.projectId,
  };
}

/**
 * The Projects row a new Repos row belongs to. `--project` (id or name) wins,
 * then the route's own area; a tracker with exactly one project needs neither.
 * Anything else is an error — a repo with no project is the thing `crew doctor`
 * flags, so it is never created by default.
 */
export function resolveRepoProject(projects: ProjectChoice[], opt: string | undefined, routeAreaId?: string): string {
  if (opt) {
    const want = opt.toLowerCase();
    const hit = projects.find((p) => p.id === opt || p.name?.toLowerCase() === want);
    if (!hit) throw new ReposError(`no Projects row "${opt}" (have: ${projects.map((p) => p.name ?? p.id).join(', ') || 'none'})`);
    return hit.id;
  }
  if (routeAreaId) return routeAreaId;
  if (projects.length === 1) return projects[0]!.id;
  throw new ReposError(
    `cannot tell which project the new Repos row belongs to — pass --project <name>` +
      ` (have: ${projects.map((p) => p.name ?? p.id).join(', ') || 'none'}), or --no-create to skip creating it`,
  );
}

/**
 * `crew repos add|list|clone` (CREW-1287, CREW-2237): attach a local checkout
 * to a route (or clone a Repos row's remote and attach it) without
 * hand-editing `crew.yaml`.
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
import { basename, dirname, join, resolve } from 'node:path';
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

/** The route names a config's yaml declares, in file order. */
export function routeNamesOf(text: string): string[] {
  const routes = parseDocument(text).get('routes', true);
  if (!isSeq(routes)) return [];
  return routes.items.flatMap((i) => (isMap(i) && typeof i.get('route') === 'string' ? [i.get('route') as string] : []));
}

export interface AddArgs { route: string; name?: string; path: string }

/**
 * `crew repos add [route] [name] [path]` (CREW-1362). Every part is optional:
 * a leading arg naming a configured route is the route (omitted: the only
 * route, else an error listing them); of what remains, two args are
 * `name path`, and one is a path when it is an existing directory, otherwise a
 * repo name. No path means the current directory.
 */
export function parseAddArgs(args: string[], routes: string[], isDir: (p: string) => boolean): AddArgs {
  const rest = [...args];
  let route: string | undefined;
  if (rest.length > 0 && routes.includes(rest[0]!)) route = rest.shift();
  else if (rest.length > 0 && /^[^/\s]+\/[^/\s]+$/.test(rest[0]!) && !isDir(rest[0]!)) {
    throw new ReposError(`no route "${rest[0]}" in the config (have: ${routes.join(', ') || 'none'})`);
  }
  if (!route) {
    if (routes.length === 1) route = routes[0];
    else throw new ReposError(routes.length === 0 ? 'the config has no routes — run `crew connect` first' : `several routes are configured; name one: ${routes.join(', ')}`);
  }
  if (rest.length > 2) throw new ReposError('too many arguments: expected [route] [name] [path]');
  if (rest.length === 2) return { route: route!, name: rest[0], path: rest[1]! };
  if (rest.length === 1) return isDir(rest[0]!) ? { route: route!, path: rest[0]! } : { route: route!, name: rest[0], path: '.' };
  return { route: route!, path: '.' };
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

export interface RepoListRow {
  name: string;
  /** The Repos row's `owner/repo`; null for a row with none, and for a checkout no row matches. */
  remote: string | null;
  repoRowId: string | null;
  attached: boolean;
  dir: string | null;
  exists: boolean;
  /** The checkout's origin URL when it differs from `remote` (or no row has one); null otherwise. */
  origin: string | null;
  matchedRow: string | null;
  hooksSource: 'route' | 'repo' | 'none';
}

export interface RepoListInput {
  text: string;
  route: string;
  base: string;
  resolved?: RepoRemotes;
  originOf: (dir: string) => string | undefined;
  exists: (dir: string) => boolean;
  /** True when the checkout carries a repo-spec file (`.crew.yaml`…) that sets at least one hook. */
  repoHasHooks: (dir: string) => boolean;
}

/** Whether the route's yaml sets hooks for the checkout `name` (its `repos:` entry, or the route itself on `dir:`). */
function routeSetsHooks(text: string, route: string, name: string): boolean {
  const m = routeMapOf(parseDocument(text), route);
  const repos = m.get('repos', true);
  let target: unknown = m;
  if (isMap(repos)) target = repos.get(name, true);
  if (!isMap(target)) return false;
  const hooks = target.get('hooks', true);
  return isMap(hooks) && hooks.items.length > 0;
}

/**
 * `crew repos list --json` (CREW-2319): every Repos row the route knows
 * (from the resolved file) with the checkout attached to it, if any, then
 * each configured checkout that matches no row (`repoRowId: null`). A
 * checkout matches a row by normalized origin remote, else by entry name.
 * `hooksSource` follows precedence: a repo-spec file shadows route hooks.
 */
export function listRepoRows(i: RepoListInput): RepoListRow[] {
  const checkouts = configuredRepos(i.text, i.route, i.base);
  const claimed = new Set<number>();
  const hooksSourceOf = (c: RepoEntry): RepoListRow['hooksSource'] =>
    i.exists(c.dir) && i.repoHasHooks(c.dir) ? 'repo' : routeSetsHooks(i.text, i.route, c.name) ? 'route' : 'none';
  const originFor = (c: RepoEntry, remote: string | null): string | null => {
    const o = i.originOf(c.dir) ?? null;
    if (!o) return null;
    return remote !== null && normalizeRemote(o) === normalizeRemote(remote) ? null : o;
  };
  const rows: RepoListRow[] = [];
  const names = i.resolved?.repoNames ?? {};
  const remotes = i.resolved?.repoRemotes ?? {};
  for (const [id, name] of Object.entries(names)) {
    const remote = remotes[id] ?? null;
    const want = normalizeRemote(remote);
    let idx = checkouts.findIndex((c, n) => !claimed.has(n) && want !== undefined && normalizeRemote(i.originOf(c.dir)) === want);
    if (idx < 0) idx = checkouts.findIndex((c, n) => !claimed.has(n) && c.name === name);
    const c = idx >= 0 ? checkouts[idx]! : undefined;
    if (idx >= 0) claimed.add(idx);
    rows.push({
      name, remote, repoRowId: id, attached: c !== undefined, dir: c?.dir ?? null,
      exists: c ? i.exists(c.dir) : false, origin: c ? originFor(c, remote) : null,
      matchedRow: c ? name : null, hooksSource: c ? hooksSourceOf(c) : 'none',
    });
  }
  checkouts.forEach((c, n) => {
    if (claimed.has(n)) return;
    rows.push({
      name: c.name, remote: null, repoRowId: null, attached: true, dir: c.dir, exists: i.exists(c.dir),
      origin: originFor(c, null), matchedRow: null, hooksSource: hooksSourceOf(c),
    });
  });
  return rows;
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
  const name = matched ?? i.name ?? normalizeRemote(i.origin)?.split('/').pop() ?? basename(target);
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

/**
 * Plan detaching the checkout at `path` from `route` (the inverse of
 * `planRepoAdd`, CREW-2242). A `repos:` map left with one entry collapses back
 * to `dir:`, and an emptied one is dropped, so the route reads as it did before
 * the add. Throws `ReposError` when the path is not configured on the route.
 */
export function planRepoRemove(text: string, base: string, route: string, path: string): { text: string; name: string } {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new ReposError(`config is not valid YAML — ${doc.errors[0]!.message}`);
  const m = routeMapOf(doc, route);
  const target = expandDir(path, base);
  const existing = configuredRepos(text, route, base);
  const hit = existing.find((e) => e.dir === target);
  if (!hit) throw new ReposError(`${target} is not configured on route ${route}`);
  const repos = m.get('repos', true);
  if (isMap(repos)) {
    repos.delete(hit.name);
    const left = existing.filter((e) => e !== hit);
    if (left.length === 1) {
      const pair = m.items.find((p) => (p.key as { value?: unknown }).value === 'repos')!;
      pair.key = doc.createNode('dir');
      pair.value = doc.createNode(String(repos.get(left[0]!.name)));
    } else if (left.length === 0) m.delete('repos');
  } else {
    m.delete('dir');
  }
  return { text: String(doc), name: hit.name };
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

export interface CloneArgs { route: string; name: string }

/** `crew repos clone [route] <name>`: a leading arg naming a configured route is the route (omitted: the only route, else an error listing them). */
export function parseCloneArgs(args: string[], routes: string[]): CloneArgs {
  const rest = [...args];
  let route: string | undefined;
  if (rest.length > 1 && routes.includes(rest[0]!)) route = rest.shift();
  else if (rest.length > 1) throw new ReposError(`no route "${rest[0]}" in the config (have: ${routes.join(', ') || 'none'})`);
  if (!route) {
    if (routes.length === 1) route = routes[0];
    else throw new ReposError(routes.length === 0 ? 'the config has no routes — run `crew connect` first' : `several routes are configured; name one: ${routes.join(', ')}`);
  }
  if (rest.length !== 1) throw new ReposError('expected [route] <name> — the Repos row to clone (see `crew repos list`)');
  return { route: route!, name: rest[0]! };
}

export interface ClonePlan extends AddPlan {
  /** The Repos row's `owner/repo`. */
  remote: string;
  /** Where the clone goes. */
  target: string;
}

export interface CloneInput {
  text: string;
  base: string;
  route: string;
  /** The Repos row to clone, by name (case-insensitive). */
  name: string;
  resolved?: RepoRemotes;
  /** `--dir`: the clone destination, instead of `<reposBasePath>/<workspace>/<name>`. */
  dir?: string;
}

/**
 * Plan cloning a Repos row's remote and attaching it. Pure: refuses a row the
 * tracker does not know or that carries no `remote`, and a repo already
 * attached (by name or by destination), before anything touches disk. The
 * attach itself is `planRepoAdd`, so the first checkout lands as `dir:` and
 * later ones under `repos:` exactly as `crew repos add` would record them.
 */
export function planRepoClone(i: CloneInput): ClonePlan {
  const names = i.resolved?.repoNames ?? {};
  const id = Object.keys(names).find((k) => names[k]!.toLowerCase() === i.name.toLowerCase());
  if (!id) {
    const known = Object.values(names);
    throw new ReposError(`the tracker has no Repos row named "${i.name}" for route ${i.route}${known.length ? ` (known: ${known.join(', ')})` : ' — run `crew connect` to refresh them'}`);
  }
  const name = names[id]!;
  const remote = normalizeRemote(i.resolved?.repoRemotes?.[id]);
  if (!remote) {
    throw new ReposError(
      `the Repos row "${name}" has no remote to clone from — attach an existing checkout with ` +
        `\`crew repos add ${i.route} ${name} <path>\`, or set the row's remote in the tracker and re-run \`crew connect\``,
    );
  }
  const doc = parseDocument(i.text);
  const m = routeMapOf(doc, i.route);
  const existing = configuredRepos(i.text, i.route, i.base);
  if (existing.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
    throw new ReposError(`route ${i.route} already has a checkout named "${name}" — nothing to clone`);
  }
  const ship = doc.get('ship', true);
  const basePath = String(m.get('reposBasePath') ?? (isMap(ship) ? ship.get('reposBasePath') : undefined) ?? '~/Crew');
  const target = i.dir ? expandDir(i.dir, i.base) : join(expandDir(basePath, i.base), i.route.split('/')[0]!, name);
  const add = planRepoAdd({ text: i.text, base: i.base, route: i.route, path: target, origin: remote, resolved: i.resolved, name });
  return { ...add, remote, target };
}

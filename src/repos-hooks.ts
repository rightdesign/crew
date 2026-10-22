/**
 * `crew repos hooks <name> [--suggest] [--write route|repo] [--json]`
 * (CREW-2238): propose `test`/`build` (and `version`/`bump`) hooks for a
 * checkout, and write them where the person chooses.
 *
 * A repo without a `.crew.yaml` is not blocked — route-level hooks in
 * `crew.yaml` work — but whoever attaches it has to know that and hand-write
 * the hooks. This sniffs the checkout instead. Detection is deliberately
 * shallow and first-match-wins in a fixed order (package.json, Package.swift,
 * pyproject.toml, Makefile): a checkout mixing several ecosystems gets the
 * first one's proposal plus a note, and the person edits from there. It never
 * guesses beyond what a file states, so a checkout it cannot read proposes
 * nothing.
 *
 * Planning is pure (an `exists`/`read` pair in, text out) so it is tested
 * against fixture trees without a git checkout; `cli.ts` does the file writes.
 */

import { isMap, parseDocument, YAMLMap } from 'yaml';
import { configuredRepos, routeMapOf, ReposError } from './repos-cmd.ts';
import { REPO_CONFIG_FILENAMES, SPEC_VERSION, parseRepoConfig } from './repo-config.ts';

export interface SuggestedHooks {
  test?: string;
  build?: string;
  version?: string;
  bump?: string;
  released?: string;
  ci_status?: string;
}

/** What a recipe asks of `release:`; `ci` and `verifyMatch` are what the mode needs to pass the repo-spec parser. */
export interface RecipeRelease {
  mode: string;
  ci?: string;
  verifyMatch?: 'commit' | 'version';
}

/**
 * A named, deterministic bundle detected from the checkout (CREW-2317): what it
 * saw, and the exact values accepting it would set. `writable: false` marks a
 * recipe with no home in the repo spec; it is reported so a wizard can show
 * it, and `--write` refuses it by id rather than dropping it.
 */
export interface HookRecipe {
  id: string;
  title: string;
  description: string;
  /** Checkout files that triggered the recipe. */
  evidence: string[];
  hooks: SuggestedHooks;
  /** The `release:` block the recipe sets, when it sets one (repo-level `.crew.yaml` only). */
  release?: RecipeRelease;
  writable: boolean;
  defaultOn: boolean;
}

export interface HookSuggestion {
  /** The file the proposal was read from; null when nothing was recognized. */
  source: string | null;
  hooks: SuggestedHooks;
  /** Human-readable remarks: other ecosystems seen, why nothing was proposed. */
  notes: string[];
  recipes: HookRecipe[];
}

/** The slice of a filesystem the sniffing needs. */
export interface CheckoutFiles {
  exists(rel: string): boolean;
  read(rel: string): string | undefined;
  /** Entry names directly under a directory; absent in fixtures that have no recipes to detect. */
  list?(rel: string): string[];
}

type Pm = 'pnpm' | 'yarn' | 'bun' | 'npm';

function packageManager(f: CheckoutFiles): Pm {
  if (f.exists('pnpm-lock.yaml')) return 'pnpm';
  if (f.exists('yarn.lock')) return 'yarn';
  if (f.exists('bun.lock') || f.exists('bun.lockb')) return 'bun';
  return 'npm';
}

function fromPackageJson(f: CheckoutFiles): SuggestedHooks | undefined {
  const text = f.read('package.json');
  if (text === undefined) return undefined;
  let pkg: { scripts?: Record<string, unknown>; version?: unknown };
  try { pkg = JSON.parse(text) as typeof pkg; } catch { return undefined; }
  if (!pkg || typeof pkg !== 'object') return undefined;
  const pm = packageManager(f);
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const out: SuggestedHooks = {};
  // `<pm> test` is valid for every manager; `build` needs `run` except under yarn.
  if (typeof scripts.test === 'string') out.test = `${pm} test`;
  if (typeof scripts.build === 'string') out.build = pm === 'yarn' ? 'yarn build' : `${pm} run build`;
  if (typeof pkg.version === 'string') {
    out.version = `node -p "require('./package.json').version"`;
    // `npm version` prints `vX.Y.Z`; the hook contract is the bare version.
    out.bump = `npm version "$CREW_BUMP" --no-git-tag-version | sed 's/^v//'`;
  }
  return out;
}

function fromPackageSwift(f: CheckoutFiles): SuggestedHooks | undefined {
  return f.exists('Package.swift') ? { test: 'swift test', build: 'swift build' } : undefined;
}

function fromPyproject(f: CheckoutFiles): SuggestedHooks | undefined {
  return f.exists('pyproject.toml') ? { test: 'pytest' } : undefined;
}

function fromMakefile(f: CheckoutFiles): SuggestedHooks | undefined {
  const text = f.read('Makefile') ?? f.read('makefile') ?? f.read('GNUmakefile');
  if (text === undefined) return undefined;
  const out: SuggestedHooks = {};
  for (const target of ['test', 'build'] as const) {
    if (new RegExp(`^${target}\\s*:`, 'm').test(text)) out[target] = `make ${target}`;
  }
  return out;
}

const DETECTORS: Array<{ source: string; detect: (f: CheckoutFiles) => SuggestedHooks | undefined }> = [
  { source: 'package.json', detect: fromPackageJson },
  { source: 'Package.swift', detect: fromPackageSwift },
  { source: 'pyproject.toml', detect: fromPyproject },
  { source: 'Makefile', detect: fromMakefile },
];

const WORKFLOW_RE = /\.ya?ml$/;

/**
 * Recipes read from `.github/workflows/`. Only the directory's existence and
 * file names are used: a workflow's contents say nothing certain about
 * whether it publishes a release, so the recipe says what it saw and leaves
 * the on/off call to the person (the release recipe defaults on, because a
 * repo with workflows and `ci_auto` only needs `hooks.released` to be true).
 */
export function detectRecipes(f: CheckoutFiles): HookRecipe[] {
  const workflows = (f.list?.('.github/workflows') ?? []).filter((n) => WORKFLOW_RE.test(n)).sort();
  if (workflows.length === 0) return [];
  const evidence = workflows.map((n) => `.github/workflows/${n}`);
  return [
    {
      id: 'github-actions-release',
      title: 'Releases run in GitHub Actions',
      description: 'CI publishes the release after the crew merges; the crew watches `gh release view` for the live tag.',
      evidence,
      // `ltrimstr` because `verify.match: version` compares the bare version, not `v1.2.3`.
      hooks: { released: `gh release view --json tagName -q '.tagName | ltrimstr("v")'` },
      release: { mode: 'ci_auto', ci: 'github', verifyMatch: 'version' },
      writable: true,
      defaultOn: true,
    },
    {
      id: 'github-actions-ci-status',
      title: 'Check CI status before hand-off',
      description: 'Ask GitHub whether the latest run on the branch passed before a ticket is handed to QA (`hooks.ci_status`).',
      evidence,
      // `gh` prints the conclusion and exits 0 either way, so the test is on the text.
      hooks: { ci_status: 'test "$(gh run list --branch "$CREW_BRANCH" --limit 1 --json conclusion -q \'.[0].conclusion\')" = success' },
      writable: true,
      defaultOn: false,
    },
  ];
}

/** What the checkout's files say its test/build commands are. */
export function suggestHooks(f: CheckoutFiles): HookSuggestion {
  const recipes = detectRecipes(f);
  const found = DETECTORS.flatMap((d) => {
    const hooks = d.detect(f);
    return hooks && Object.keys(hooks).length > 0 ? [{ source: d.source, hooks }] : [];
  });
  if (found.length === 0) {
    return { source: null, hooks: {}, notes: ['no package.json scripts, Package.swift, pyproject.toml or Makefile test/build targets found — nothing to propose'], recipes };
  }
  const [first, ...others] = found;
  const notes = others.length > 0
    ? [`also found ${others.map((o) => o.source).join(', ')}; proposing from ${first!.source} only`]
    : [];
  return { source: first!.source, hooks: first!.hooks, notes, recipes };
}

export interface RecipeSelection {
  hooks: SuggestedHooks;
  release?: RecipeRelease;
}

/**
 * Fold the chosen recipes into the hooks to write; none are applied unless
 * named (`defaultOn` is only what a wizard pre-ticks). An unknown or unwritable id is an error, so
 * a typo never silently writes less than was asked for. Sniffed hooks win a
 * collision: a recipe adds hooks, it never rewrites what the files stated.
 */
export function selectRecipes(s: HookSuggestion, ids: string[]): RecipeSelection {
  const chosen = ids.map((id) => {
    const r = s.recipes.find((x) => x.id === id);
    if (!r) throw new ReposError(`no recipe "${id}" here (have: ${s.recipes.map((x) => x.id).join(', ') || 'none'})`);
    if (!r.writable) throw new ReposError(`recipe "${id}" cannot be written: ${r.description}`);
    return r;
  });
  let hooks: SuggestedHooks = { ...s.hooks };
  let release: RecipeRelease | undefined;
  for (const r of chosen) {
    hooks = { ...r.hooks, ...hooks };
    release ??= r.release;
  }
  return { hooks, ...(release ? { release } : {}) };
}

export const HOOK_KEYS = ['test', 'build', 'version', 'bump', 'released', 'ci_status'] as const;

/**
 * Parse repeated `--hook key=value` into the hooks to write (CREW-2320). They
 * override what the sniff or a recipe proposed, and add a key neither found,
 * so a wizard can write what the person typed. An unknown key or an empty
 * value is refused by name rather than dropped.
 */
export function parseHookOverrides(specs: string[]): SuggestedHooks {
  const out: SuggestedHooks = {};
  for (const spec of specs) {
    const eq = spec.indexOf('=');
    const key = eq < 0 ? spec : spec.slice(0, eq);
    const val = eq < 0 ? '' : spec.slice(eq + 1);
    if (!(HOOK_KEYS as readonly string[]).includes(key)) {
      throw new ReposError(`--hook: unknown key "${key}" (valid keys: ${HOOK_KEYS.join(', ')})`);
    }
    if (val.trim() === '') throw new ReposError(`--hook ${key}= needs a command (expected key=value)`);
    out[key as keyof SuggestedHooks] = val;
  }
  return out;
}

export interface HooksArgs { route: string; name: string }

/** `[route] <name>`: a leading arg naming a configured route is the route; else the only route. */
export function parseHooksArgs(args: string[], routes: string[]): HooksArgs {
  const rest = [...args];
  let route: string | undefined;
  if (rest.length > 1 && routes.includes(rest[0]!)) route = rest.shift();
  if (!route) {
    if (routes.length === 1) route = routes[0];
    else throw new ReposError(routes.length === 0 ? 'the config has no routes — run `crew connect` first' : `several routes are configured; name one: ${routes.join(', ')}`);
  }
  if (rest.length !== 1) throw new ReposError('expected: crew repos hooks [route] <name> [--suggest] [--agent] [--write route|repo] [--recipes ID,ID] [--hook KEY=CMD] [--json]');
  return { route: route!, name: rest[0]! };
}

/** The checkout directory of repo `name` on `route`, from the raw yaml. */
export function repoDirOf(text: string, base: string, route: string, name: string): string {
  const repos = configuredRepos(text, route, base);
  const hit = repos.find((r) => r.name === name);
  if (!hit) {
    throw new ReposError(`route ${route} has no repo named "${name}" (have: ${repos.map((r) => r.name).join(', ') || 'none'})`);
  }
  return hit.dir;
}

export interface RouteWritePlan {
  text: string;
  /** Hook names written. */
  written: string[];
  /** Hook names left alone because the route already sets them. */
  kept: string[];
}

/**
 * Add `hooks` to the route-level config of repo `name`. A route on `dir:` takes
 * them under its own `hooks:`; a route on `repos:` takes them under that repo's
 * entry (a bare path entry becomes `{ dir, hooks }`). Hooks the route already
 * sets are kept, never overwritten. Comments and other routes are untouched.
 */
export function planRouteHooks(text: string, route: string, name: string, hooks: SuggestedHooks): RouteWritePlan {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new ReposError(`config is not valid YAML — ${doc.errors[0]!.message}`);
  const m = routeMapOf(doc, route);
  const repos = m.get('repos', true);
  let target: YAMLMap = m;
  if (isMap(repos)) {
    const entry = repos.get(name, true);
    if (isMap(entry)) target = entry;
    else {
      const created = new YAMLMap();
      created.set('dir', String(repos.get(name)));
      repos.set(name, created);
      target = created;
    }
  }
  const current = target.get('hooks', true);
  let hooksMap: YAMLMap;
  if (isMap(current)) hooksMap = current;
  else {
    hooksMap = new YAMLMap();
    target.set('hooks', hooksMap);
  }
  const written: string[] = [];
  const kept: string[] = [];
  for (const [k, v] of Object.entries(hooks)) {
    if (v === undefined) continue;
    if (hooksMap.has(k)) kept.push(k);
    else {
      hooksMap.set(k, v);
      written.push(k);
    }
  }
  return { text: String(doc), written, kept };
}

/**
 * A commented starter `.crew.yaml` for the user to review and commit. Validated
 * against the repo spec's own parser before it is returned, so the file it
 * hands over is one `crew doctor` accepts.
 */
export function starterRepoConfig(hooks: SuggestedHooks, release?: RecipeRelease): string {
  const lines = [
    '# Starter .crew.yaml proposed by `crew repos hooks --write repo`.',
    '# Review the hooks, then commit this file; it is the durable home for them',
    '# (docs/REPO_SPEC.md). A route-level copy in crew.yaml is shadowed by it.',
    `version: ${SPEC_VERSION}`,
    'platform: any',
    '',
    'hooks:',
  ];
  const entries = Object.entries(hooks).filter(([, v]) => v !== undefined);
  if (entries.length === 0) lines.push('  # test: "..."', '  # build: "..."');
  for (const [k, v] of entries) lines.push(`  ${k}: ${JSON.stringify(v)}`);
  if (release) {
    lines.push('', 'release:', `  mode: ${release.mode}`);
    if (release.ci) lines.push(`  ci: { provider: ${release.ci} }`);
    if (release.verifyMatch) lines.push('  verify:', `    match: ${release.verifyMatch}`);
    lines.push('');
  }
  else lines.push('', 'release:', '  # integrate: merging to the base branch is the release; nothing is deployed.', '  mode: integrate', '');
  const text = lines.join('\n');
  parseRepoConfig(text, '.crew.yaml');
  return text;
}

/** The existing repo-spec file at the checkout root, if any (a write must not clobber it). */
export function existingRepoConfig(f: CheckoutFiles): string | undefined {
  return REPO_CONFIG_FILENAMES.find((n) => f.exists(n));
}

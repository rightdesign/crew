/**
 * `.crew.yaml` — the repo contract. See docs/REPO_SPEC.md, which is the
 * specification this implements and the thing to change first if the two
 * ever disagree.
 *
 * The repo describes ITSELF: what a ship must be to build it, and what the
 * commands are. What it cannot know — which area it serves, which other repos
 * must release before it — lives on the tracker's `Repos` row instead.
 *
 * Hooks are deliberately here rather than in the tracker: a hook is code and
 * belongs beside what it builds, and shell stored in a workspace record would
 * make that record a remote-code-execution vector on every connected ship.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { isPlatformRequirement, type PlatformRequirement } from './platform.ts';

export const SPEC_VERSION = 1;
export const REPO_CONFIG_FILENAMES = ['.crew.yaml', '.crew.yml', '.crew.json'] as const;

export type ReleaseMode = 'local' | 'ci_manual' | 'ci_auto';
export type CiProvider = 'github' | 'buildkite' | 'other' | 'none';

export interface RepoHooks {
  test?: string;
  build?: string;
  setup?: string;
  deploy?: string;
  ports?: string;
  /**
   * Prints this repo's current version, on one line. Where a version lives is
   * entirely a repo's business — package.json, Cargo.toml, pyproject.toml, a
   * VERSION file, `git describe --tags`.
   */
  version?: string;
  /**
   * Applies a version increment and prints the NEW version, on one line.
   * Receives `CREW_BUMP` = major | minor | patch in its environment.
   *
   * Defining this replaces `release.versionFiles`: the repo owns both where
   * the version is written and how it is computed, which is the only way a
   * project that is not npm-shaped can be released at all. The crew uses what
   * the hook printed rather than recomputing, so a calendar version or a
   * build counter is correct by construction instead of a disagreement.
   */
  bump?: string;
  /**
   * Prints, on one line, what is live right now — a commit sha or a version.
   *
   * This is how the crew learns the outcome of a release it did not perform,
   * which is the whole difficulty of `ci_manual` and `ci_auto`: it pushes or
   * triggers, and then has to observe. A hook rather than a URL because "what
   * is live" is answered very differently per project — an HTTP health
   * endpoint, `npm view <pkg> version`, a registry query, a kubectl lookup.
   */
  released?: string;
}

export type VerifyMatch = 'commit' | 'version';

/**
 * Whether the crew touches this repo's version at all.
 *
 *   auto  the crew bumps on release — via `hooks.bump`, or by rewriting
 *         `versionFiles` when there is none.
 *   none  the crew never writes a version. A release is identified by its
 *         commit. Right for a repo that does not version, and for one whose
 *         version a human or another tool controls — `hooks.version` is still
 *         read, if defined, so releases can be *reported* by version without
 *         the crew ever setting one.
 */
export type Versioning = 'auto' | 'none';

export interface ReleaseVerify {
  /** What `hooks.released` prints: a sha (prefix-matched) or a version (exact). */
  match: VerifyMatch;
  /**
   * How long to keep asking before calling a release unconfirmed, and how
   * often. Unconfirmed is NOT failed — the deploy may simply be slower than
   * the window — so it is reported rather than treated as an error.
   */
  timeoutSeconds: number;
  intervalSeconds: number;
}

export interface RepoConfig {
  version: number;
  platform: PlatformRequirement;
  shell?: string;
  hooks: RepoHooks;
  labels: Partial<Record<keyof RepoHooks, string>>;
  release: {
    mode: ReleaseMode;
    ci: { provider: CiProvider; ref?: string };
    verify: ReleaseVerify;
    versioning: Versioning;
    versionFiles: string[];
    /** null when this repo keeps no changelog — not every project does. */
    changelog: string | null;
  };
  /** Where this was read from, for error messages and `doctor`. */
  file: string;
}

export class RepoConfigError extends Error {}

const HOOK_NAMES: Array<keyof RepoHooks> = [
  'test', 'build', 'setup', 'deploy', 'ports', 'version', 'bump', 'released',
];
/** The values `CREW_BUMP` may take. */
export const BUMP_SIZES = ['major', 'minor', 'patch'] as const;
export type BumpSize = (typeof BUMP_SIZES)[number];
const TOP_LEVEL = new Set(['version', 'platform', 'shell', 'hooks', 'labels', 'release']);
const RELEASE_KEYS = new Set(['mode', 'ci', 'verify', 'versioning', 'versionFiles', 'changelog']);
const VERSIONINGS: Versioning[] = ['auto', 'none'];
const CI_KEYS = new Set(['provider', 'ref']);
const VERIFY_KEYS = new Set(['match', 'timeoutSeconds', 'intervalSeconds']);
const MATCHES: VerifyMatch[] = ['commit', 'version'];
const MODES: ReleaseMode[] = ['local', 'ci_manual', 'ci_auto'];
const PROVIDERS: CiProvider[] = ['github', 'buildkite', 'other', 'none'];

/** The path of the repo contract in `dir`, or null if it has none. */
export function findRepoConfig(dir: string): string | null {
  for (const name of REPO_CONFIG_FILENAMES) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Unknown keys are an ERROR, not a warning: a typo in a hook name would
 * otherwise mean a suite that silently never runs, which is the worst
 * outcome available for a test hook.
 */
function rejectUnknown(obj: unknown, allowed: Set<string>, where: string, file: string): void {
  if (!obj || typeof obj !== 'object') return;
  const unknown = Object.keys(obj as object).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new RepoConfigError(
      `${file}: unknown ${where} ${unknown.length === 1 ? 'key' : 'keys'}: ${unknown.join(', ')}` +
        ` (allowed: ${[...allowed].sort().join(', ')})`,
    );
  }
}

export function parseRepoConfig(text: string, file: string): RepoConfig {
  let raw: any;
  try {
    raw = file.endsWith('.json') ? JSON.parse(text) : parse(text);
  } catch (e) {
    throw new RepoConfigError(`${file}: could not be parsed — ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object') throw new RepoConfigError(`${file} is empty or not a mapping`);

  rejectUnknown(raw, TOP_LEVEL, 'top-level', file);
  rejectUnknown(raw.hooks, new Set(HOOK_NAMES), 'hooks', file);
  rejectUnknown(raw.labels, new Set(HOOK_NAMES), 'labels', file);
  rejectUnknown(raw.release, RELEASE_KEYS, 'release', file);
  rejectUnknown(raw.release?.ci, CI_KEYS, 'release.ci', file);
  rejectUnknown(raw.release?.verify, VERIFY_KEYS, 'release.verify', file);

  if (raw.version === undefined) throw new RepoConfigError(`${file}: version is required`);
  if (raw.version !== SPEC_VERSION) {
    throw new RepoConfigError(
      `${file}: version ${raw.version} is not supported by this crew (understands ${SPEC_VERSION})`,
    );
  }

  const platform = String(raw.platform ?? 'any');
  if (!isPlatformRequirement(platform)) {
    throw new RepoConfigError(
      `${file}: platform must be one of any|unix|macos|linux|windows (got "${platform}")`,
    );
  }

  const hooks: RepoHooks = {};
  for (const h of HOOK_NAMES) {
    const v = raw.hooks?.[h];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') throw new RepoConfigError(`${file}: hooks.${h} must be a string`);
    if (v.trim() === '') throw new RepoConfigError(`${file}: hooks.${h} is empty`);
    hooks[h] = v;
  }

  const labels: RepoConfig['labels'] = {};
  for (const h of HOOK_NAMES) if (raw.labels?.[h]) labels[h] = String(raw.labels[h]);

  const mode = String(raw.release?.mode ?? 'local') as ReleaseMode;
  if (!MODES.includes(mode)) {
    throw new RepoConfigError(`${file}: release.mode must be one of ${MODES.join('|')} (got "${mode}")`);
  }
  const provider = String(raw.release?.ci?.provider ?? 'none') as CiProvider;
  if (!PROVIDERS.includes(provider)) {
    throw new RepoConfigError(
      `${file}: release.ci.provider must be one of ${PROVIDERS.join('|')} (got "${provider}")`,
    );
  }
  // A CI release with nothing to trigger or watch cannot work, and failing
  // here is far better than discovering it mid-release.
  if (mode !== 'local' && provider === 'none') {
    throw new RepoConfigError(`${file}: release.mode "${mode}" needs release.ci.provider`);
  }
  // Without this the crew would report a CI release as successful purely on
  // the basis of having pushed. Refuse at load, not at release time.
  if (mode !== 'local' && !hooks.released) {
    throw new RepoConfigError(
      `${file}: release.mode "${mode}" needs a hooks.released — the crew cannot ` +
        'observe a release it did not perform without one',
    );
  }
  if (mode === 'local' && !hooks.deploy) {
    throw new RepoConfigError(`${file}: release.mode "local" needs a hooks.deploy`);
  }

  const vmatch = String(raw.release?.verify?.match ?? 'commit') as VerifyMatch;
  if (!MATCHES.includes(vmatch)) {
    throw new RepoConfigError(`${file}: release.verify.match must be commit|version (got "${vmatch}")`);
  }
  const num = (v: unknown, key: string, dflt: number): number => {
    if (v === undefined || v === null) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) {
      throw new RepoConfigError(`${file}: release.verify.${key} must be a positive number (got "${v}")`);
    }
    return n;
  };
  const verify: ReleaseVerify = {
    match: vmatch,
    timeoutSeconds: num(raw.release?.verify?.timeoutSeconds, 'timeoutSeconds', 600),
    intervalSeconds: num(raw.release?.verify?.intervalSeconds, 'intervalSeconds', 15),
  };
  if (verify.intervalSeconds > verify.timeoutSeconds) {
    throw new RepoConfigError(
      `${file}: release.verify.intervalSeconds (${verify.intervalSeconds}) exceeds timeoutSeconds ` +
        `(${verify.timeoutSeconds}) — it would never be asked twice`,
    );
  }

  const versioning = String(raw.release?.versioning ?? 'auto') as Versioning;
  if (!VERSIONINGS.includes(versioning)) {
    throw new RepoConfigError(`${file}: release.versioning must be auto|none (got "${versioning}")`);
  }
  // A repo that has opted out of versioning but still defines the machinery
  // has almost certainly changed its mind in one place only.
  if (versioning === 'none' && hooks.bump) {
    throw new RepoConfigError(
      `${file}: release.versioning is "none" but hooks.bump is defined — ` +
        'the crew would never call it. Remove one.',
    );
  }
  const versionFilesGiven = Array.isArray(raw.release?.versionFiles);
  if (versioning === 'none' && versionFilesGiven) {
    throw new RepoConfigError(
      `${file}: release.versioning is "none" but release.versionFiles is set — ` +
        'the crew would never write them. Remove one.',
    );
  }
  if (hooks.bump && versionFilesGiven) {
    throw new RepoConfigError(
      `${file}: define either hooks.bump or release.versionFiles, not both — ` +
        'two mechanisms writing the version is how they drift apart',
    );
  }
  const versionFiles = versionFilesGiven ? raw.release.versionFiles.map(String) : ['package.json'];
  if (versionFiles.length === 0) {
    throw new RepoConfigError(`${file}: release.versionFiles cannot be empty`);
  }

  return {
    version: SPEC_VERSION,
    platform: platform as PlatformRequirement,
    shell: raw.shell ? String(raw.shell) : undefined,
    hooks,
    labels,
    release: {
      mode,
      ci: { provider, ref: raw.release?.ci?.ref ? String(raw.release.ci.ref) : undefined },
      verify,
      versioning,
      versionFiles,
      // `changelog: false` (or null) means this repo keeps none.
      changelog:
        raw.release?.changelog === false || raw.release?.changelog === null
          ? null
          : String(raw.release?.changelog ?? 'CHANGELOG.md'),
    },
    file,
  };
}

/**
 * The repo contract for `dir`, or null when the repo has none — which is not
 * an error: the crew falls back to whatever the ship's own crew.yaml declares
 * for that repo, so a repo that has not adopted the spec still gets worked.
 */
export function loadRepoConfig(dir: string): RepoConfig | null {
  const file = findRepoConfig(dir);
  if (!file) return null;
  return parseRepoConfig(readFileSync(file, 'utf8'), file);
}

/** A hook's readable name, for a log line or a filed ticket. */
export function hookLabel(cfg: RepoConfig, hook: keyof RepoHooks): string {
  return cfg.labels[hook] ?? cfg.hooks[hook] ?? hook;
}

// ---------------------------------------------------------------------------
// Effective config: the repo contract, or the ship's own settings for a repo
// that has not adopted one.
// ---------------------------------------------------------------------------

/**
 * What a ship's `crew.yaml` may say about a repo. Every field is optional and
 * acts as a FALLBACK — the repo's own `.crew.yaml` wins wherever it speaks,
 * so a repo can adopt the spec one field at a time without the ship's config
 * silently disagreeing with it.
 */
export interface ShipRepoSettings {
  platform?: PlatformRequirement;
  shell?: string;
  hooks?: RepoHooks;
  labels?: Partial<Record<keyof RepoHooks, string>>;
  release?: Partial<RepoConfig['release']>;
}

export type Source = 'repo' | 'ship' | 'default';

export interface EffectiveRepoConfig extends RepoConfig {
  /** Where each setting actually came from. `doctor` renders this. */
  provenance: Record<string, Source>;
  /**
   * Settings the ship declared that the repo overrode. Not an error — the
   * repo is the source of truth — but reported rather than swallowed, since
   * a shadowed hook is otherwise invisible and reads as if it were in use.
   */
  shadowed: string[];
}

const DEFAULTS = {
  platform: 'any' as PlatformRequirement,
  mode: 'local' as ReleaseMode,
  provider: 'none' as CiProvider,
  versionFiles: ['package.json'],
  changelog: 'CHANGELOG.md' as string | null,
  versioning: 'auto' as Versioning,
  match: 'commit' as VerifyMatch,
  timeoutSeconds: 600,
  intervalSeconds: 15,
};

/**
 * Merge a repo's own contract with the ship's fallback settings for it.
 *
 * Precedence is repo > ship > default, per field. A repo with no `.crew.yaml`
 * is driven entirely by the ship's settings, which is how a repo that has not
 * adopted the spec still gets worked.
 */
export function resolveRepoConfig(
  repo: RepoConfig | null,
  ship: ShipRepoSettings | undefined,
  dir: string,
): EffectiveRepoConfig {
  const provenance: Record<string, Source> = {};
  const shadowed: string[] = [];

  const pick = <T>(key: string, fromRepo: T | undefined, fromShip: T | undefined, fallback: T): T => {
    if (fromRepo !== undefined && fromRepo !== null) {
      if (fromShip !== undefined && fromShip !== null) shadowed.push(key);
      provenance[key] = 'repo';
      return fromRepo;
    }
    if (fromShip !== undefined && fromShip !== null) {
      provenance[key] = 'ship';
      return fromShip;
    }
    provenance[key] = 'default';
    return fallback;
  };

  const hooks: RepoHooks = {};
  const labels: RepoConfig['labels'] = {};
  for (const h of HOOK_NAMES) {
    const v = pick(`hooks.${h}`, repo?.hooks[h], ship?.hooks?.[h], undefined as string | undefined);
    if (v !== undefined) hooks[h] = v;
    else delete provenance[`hooks.${h}`]; // an absent hook has no source to report
    const l = pick(`labels.${h}`, repo?.labels[h], ship?.labels?.[h], undefined as string | undefined);
    if (l !== undefined) labels[h] = l;
    else delete provenance[`labels.${h}`];
  }

  const mode = pick('release.mode', repo?.release.mode, ship?.release?.mode, DEFAULTS.mode);
  const provider = pick(
    'release.ci.provider',
    repo?.release.ci.provider === 'none' ? undefined : repo?.release.ci.provider,
    ship?.release?.ci?.provider,
    DEFAULTS.provider,
  );

  return {
    version: SPEC_VERSION,
    platform: pick('platform', repo?.platform === 'any' ? undefined : repo?.platform, ship?.platform, DEFAULTS.platform),
    shell: pick('shell', repo?.shell, ship?.shell, undefined as string | undefined),
    hooks,
    labels,
    release: {
      mode,
      ci: {
        provider,
        ref: pick('release.ci.ref', repo?.release.ci.ref, ship?.release?.ci?.ref, undefined as string | undefined),
      },
      verify: {
        match: pick('release.verify.match',
          repo?.release.verify.match === 'commit' ? undefined : repo?.release.verify.match,
          ship?.release?.verify?.match, DEFAULTS.match),
        timeoutSeconds: pick('release.verify.timeoutSeconds',
          repo?.release.verify.timeoutSeconds === DEFAULTS.timeoutSeconds ? undefined : repo?.release.verify.timeoutSeconds,
          ship?.release?.verify?.timeoutSeconds, DEFAULTS.timeoutSeconds),
        intervalSeconds: pick('release.verify.intervalSeconds',
          repo?.release.verify.intervalSeconds === DEFAULTS.intervalSeconds ? undefined : repo?.release.verify.intervalSeconds,
          ship?.release?.verify?.intervalSeconds, DEFAULTS.intervalSeconds),
      },
      versioning: pick('release.versioning',
        repo?.release.versioning === 'auto' ? undefined : repo?.release.versioning,
        ship?.release?.versioning, DEFAULTS.versioning),
      versionFiles: pick(
        'release.versionFiles', repo?.release.versionFiles, ship?.release?.versionFiles, DEFAULTS.versionFiles,
      ),
      changelog: pick('release.changelog', repo?.release.changelog, ship?.release?.changelog, DEFAULTS.changelog),
    },
    file: repo?.file ?? `${dir} (no .crew.yaml — configured by this ship)`,
    provenance,
    shadowed,
  };
}

/**
 * The same consistency rules the repo contract enforces, applied to the
 * MERGED result — a repo with no `.crew.yaml` must not escape them just
 * because its settings arrived from the ship.
 */
export function validateEffective(cfg: EffectiveRepoConfig): string[] {
  const problems: string[] = [];
  if (cfg.release.mode !== 'local' && cfg.release.ci.provider === 'none') {
    problems.push(`release.mode "${cfg.release.mode}" needs a CI provider`);
  }
  if (cfg.release.mode === 'local' && !cfg.hooks.deploy) {
    problems.push('release.mode "local" needs a deploy hook');
  }
  if (cfg.release.mode !== 'local' && !cfg.hooks.released) {
    problems.push(
      `release.mode "${cfg.release.mode}" needs a released hook — without one a CI release ` +
        'would be reported as successful merely for having been pushed',
    );
  }
  // NB: when a repo defines `bump` it still carries the DEFAULT versionFiles,
  // so provenance reads 'repo' and cannot distinguish "declared" from
  // "defaulted". The shadow list is the honest signal: it means the ship
  // declared something the repo's value displaced.
  if (cfg.release.versioning === 'none' && cfg.hooks.bump) {
    problems.push('release.versioning is "none", so the bump hook will never be called');
  }
  if (cfg.hooks.bump && (cfg.shadowed.includes('release.versionFiles')
      || cfg.provenance['release.versionFiles'] === 'ship')) {
    problems.push(
      'this repo defines a bump hook, but the ship also configures versionFiles — ' +
        'the bump hook wins and the ship setting is ignored',
    );
  }
  if (!cfg.hooks.test) problems.push('no test hook — a release cannot be gated');
  if (!cfg.hooks.build) problems.push('no build hook');
  return problems;
}

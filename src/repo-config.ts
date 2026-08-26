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
import { join, basename } from 'node:path';
import { parse } from 'yaml';
import { isPlatformRequirement, type PlatformRequirement } from './platform.ts';

export const SPEC_VERSION = 1;
export const REPO_CONFIG_FILENAMES = ['.crew.yaml', '.crew.yml', '.crew.json'] as const;

/**
 * Who releases this repo.
 *
 *   local      the crew merges, versions and runs the deploy hook itself
 *   integrate  the crew merges, versions, changelogs and tags — and there is
 *              nothing to deploy. Merging to the base branch IS the release:
 *              a CLI, a library, a tool an operator upgrades by pulling. No
 *              deploy hook, no CI provider, no `released` verification,
 *              because there is nothing to verify against.
 *   ci_manual  the crew merges, then triggers CI and waits
 *   ci_auto    the crew merges; CI releases on its own and the crew watches
 *   external   the crew does NOT release at all. It pushes a branch and
 *              stops — a human merges the PR and someone else's pipeline
 *              takes it from there. No merge, no version, no changelog, no
 *              tag, no deploy. The crew's only remaining interest is whether
 *              the work landed (`hooks.merged`).
 *
 * `external` exists because the alternative was composing three settings
 * (review + ci_auto + versioning:none) that had to agree, and a wrong
 * combination read as contradictory rather than merely unusual.
 *
 * `integrate` exists for the same reason, and against a specific temptation:
 * declaring `local` with `deploy: exit 0`. A hook that exits zero without
 * shipping anything reports success for something that did not happen, and
 * the release then stamps tickets as deployed on the strength of it. The
 * crew's own repository is the first instance (ISSUE-345); before this it was
 * declared `external`, which meant its verified branches were never merged and
 * every Crew ticket had to be closed by hand.
 */
export type ReleaseMode = 'local' | 'integrate' | 'ci_manual' | 'ci_auto' | 'external';
export type CiProvider = 'github' | 'buildkite' | 'other' | 'none';

export interface RepoHooks {
  test?: string;
  build?: string;
  /**
   * Makes a freshly created worktree usable: install dependencies, generate
   * clients, whatever this repo needs before anything can run in it.
   *
   * A hook rather than a convention because a fresh worktree is missing more
   * than dependencies — gitignored files it needs are not in git by
   * definition, and which ones matter is not inferable (see
   * `worktrees.copy`).
   */
  setup?: string;
  deploy?: string;
  ports?: string;
  /**
   * Prints environment overrides (`KEY=value` per line) that point this
   * worktree at state of its OWN — typically a separate database.
   *
   * Receives `CREW_TICKET` and `CREW_BRANCH`. The principle it exists to
   * enforce is that a headless session must not be able to destroy the
   * operator's working state: migrating the shared dev database is not
   * reversible, and an agent asked to change a schema will otherwise do
   * exactly that. The principle is general; where a repo keeps its state is
   * not, so the repo prints the answer.
   */
  isolate?: string;
  /**
   * Leaves the operator able to open what was built, and prints how.
   *
   * Receives `CREW_TICKET` and `CREW_BRANCH`, and whatever `isolate` printed.
   * For this project it seeds an admin login, because isolated state means a
   * database nobody has an account on, there is no password reset on local
   * dev and no mail to send one — so an un-seeded database can only be fixed
   * by re-provisioning it. Whatever a repo's version of that is, its output
   * belongs in the agent's progress comment.
   */
  handoff?: string;
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
   * Opens a pull request for the pushed branch. Optional: without it the crew
   * pushes and prints where to open one by hand.
   *
   * Receives CREW_TICKET, CREW_BRANCH, CREW_BASE and CREW_TITLE. Typically:
   *
   *   gh pr create --head "$CREW_BRANCH" --base "$CREW_BASE" \
   *     --title "$CREW_TITLE" --body "Worked by the crew for $CREW_TICKET."
   *
   * A hook rather than built-in forge support, for the same reason as the
   * rest: the repo knows its forge and the crew must not.
   */
  pr?: string;
  /**
   * Answers "did this ticket's work land?" — exit 0 for yes, non-zero for no.
   *
   * Receives CREW_TICKET (ISSUE-326), CREW_BRANCH (the pushed branch) and
   * CREW_BASE in its environment.
   *
   * This exists because the crew's own detection is a heuristic and the repo
   * usually knows better. On a forge-based process one line is definitive:
   *
   *   gh pr list --head "$CREW_BRANCH" --state merged --json number \
   *     | grep -q number
   *
   * Without it the crew falls back to searching the base branch for the
   * ticket key, which a squash merge preserves only if whoever merged left
   * the PR title alone. That is good enough to be useful and too fragile to
   * be authoritative — so where closure matters, define this.
   */
  merged?: string;
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

/**
 * How this repo names the branches the crew creates, and what it is called
 * when pushed for review.
 *
 * A convention, not a constant: `issue-326` suits one org, `feature/ISSUE-326`
 * or `bc/issue-326-add-widget` another, and a repo with branch protection may
 * require a prefix to be pushable at all.
 *
 * Placeholders: {key} (ISSUE-326), {number} (326), {slug} (title, slugified),
 * {role} (dev/design/qa).
 */
export interface BranchNaming {
  /**
   * The branch work is cut from and merged back into. NOT assumed to be
   * `main`: an established repo may integrate on `master`, `develop`, or a
   * release train, and the crew has to fit an existing process rather than
   * require one.
   */
  base: string;
  /** The local working branch. */
  name: string;
  /** What it is called on the remote, if different. Defaults to `name`. */
  push: string;
  /** Where a review branch is pushed. */
  remote: string;
}

/**
 * What a freshly cut worktree needs before work can start in it.
 *
 * A worktree is a clean checkout, which means it is missing precisely the
 * files git was told to ignore — and those are often the ones without which
 * nothing runs. Which ones matter cannot be inferred: an `.env` must usually
 * be carried over, `node_modules` must NOT (it is rebuilt, and copying it
 * across is both slow and wrong when native modules are involved).
 */
export interface Worktrees {
  /**
   * Gitignored paths to copy from the main checkout into a new worktree,
   * relative to the repository root. Copied before `hooks.setup` runs.
   */
  copy: string[];
  /**
   * What this repository's worktrees are called: a ticket's worktree is cut
   * beside the checkout at `../<prefix><number>`.
   *
   * A fact about the repository, not about the ship or the board — the same
   * kind of convention as `branch.name`, and it lived on the CONNECTION until
   * ISSUE-350. A route spans several repos (ISSUE-331), so one prefix
   * there told a session working the second repo to cut its worktree under
   * the first repo's name.
   *
   * Defaults to the checkout's own directory name plus `-issue-`, which is
   * what every repo the crew works was already doing by hand. A ship-level
   * `worktreePrefix` still overrides that default, and this overrides both.
   */
  prefix: string;
}

/**
 * Documents in this repository that a brief needs to point at.
 *
 * A brief may not contain a path (ISSUE-293), but some of what a seat must
 * follow genuinely lives in the project rather than in the crew — a triage
 * policy is the project's own decision about what its statuses mean and when
 * a ticket may be accepted. So the repo says where, and the brief says "the
 * policy document, if this project has one".
 */
export interface RepoDocs {
  /** The contract the triage seat follows for this project. */
  triagePolicy?: string;
  /**
   * How this project designs: its own design brief, house style, component
   * conventions. The design seat reads it before working any surface out.
   */
  designGuide?: string;
}

export interface RepoConfig {
  version: number;
  branch: BranchNaming;
  worktrees: Worktrees;
  docs: RepoDocs;
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
    /**
     * The tag written when a release ships, e.g. "v{version}". **null** for a
     * repo that does not tag.
     *
     * Tags rather than a private ref because a ref is local-only — a second
     * ship would have no idea what was released — and does not survive a
     * fresh clone. A tag is durable, shareable and already meaningful to
     * anyone else looking at the repository.
     */
    tag: string | null;
    /** How to FIND those tags. Derived from `tag` unless stated. */
    tagPattern: string;
  };
  /** Where this was read from, for error messages and `doctor`. */
  file: string;
}

export class RepoConfigError extends Error {}

const HOOK_NAMES: Array<keyof RepoHooks> = [
  'test', 'build', 'setup', 'deploy', 'ports', 'isolate', 'handoff',
  'version', 'bump', 'pr', 'merged', 'released',
];
/** The values `CREW_BUMP` may take. */
export const BUMP_SIZES = ['major', 'minor', 'patch'] as const;
export type BumpSize = (typeof BUMP_SIZES)[number];
const TOP_LEVEL = new Set([
  'version', 'platform', 'shell', 'branch', 'worktrees', 'docs', 'hooks', 'labels', 'release',
]);
const BRANCH_KEYS = new Set(['base', 'name', 'push', 'remote']);
const PLACEHOLDER = /\{(key|number|slug|role)\}/g;
const RELEASE_KEYS = new Set([
  'mode', 'ci', 'verify', 'versioning', 'versionFiles', 'changelog', 'tag', 'tagPattern',
]);
/** Exported so `config.ts` validates a ship's `release:` fallback against the same lists. */
export const VERSIONINGS: Versioning[] = ['auto', 'none'];
const CI_KEYS = new Set(['provider', 'ref']);
const VERIFY_KEYS = new Set(['match', 'timeoutSeconds', 'intervalSeconds']);
export const MATCHES: VerifyMatch[] = ['commit', 'version'];
export const MODES: ReleaseMode[] = ['local', 'integrate', 'ci_manual', 'ci_auto', 'external'];
export const PROVIDERS: CiProvider[] = ['github', 'buildkite', 'other', 'none'];

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
  rejectUnknown(raw.branch, BRANCH_KEYS, 'branch', file);
  rejectUnknown(raw.worktrees, new Set(['copy', 'prefix']), 'worktrees', file);
  rejectUnknown(raw.docs, new Set(['triagePolicy', 'designGuide']), 'docs', file);

  if (raw.version === undefined) throw new RepoConfigError(`${file}: version is required`);
  if (raw.version !== SPEC_VERSION) {
    throw new RepoConfigError(
      `${file}: version ${raw.version} is not supported by this crew (understands ${SPEC_VERSION})`,
    );
  }

  const branchName = String(raw.branch?.name ?? 'issue-{number}');
  // A template naming none of the placeholders would give every ticket the
  // same branch, and the second one would fail to be created.
  if (!PLACEHOLDER.test(branchName)) {
    PLACEHOLDER.lastIndex = 0;
    throw new RepoConfigError(
      `${file}: branch.name ("${branchName}") names no placeholder — every ticket ` +
        'would get the same branch. Use at least one of {key} {number} {slug} {role}.',
    );
  }
  PLACEHOLDER.lastIndex = 0;
  const branch: BranchNaming = {
    base: String(raw.branch?.base ?? 'main'),
    name: branchName,
    push: String(raw.branch?.push ?? branchName),
    remote: String(raw.branch?.remote ?? 'origin'),
  };

  const copyRaw = raw.worktrees?.copy;
  if (copyRaw !== undefined && !Array.isArray(copyRaw)) {
    throw new RepoConfigError(`${file}: worktrees.copy must be a list of paths`);
  }
  const prefixRaw = raw.worktrees?.prefix;
  if (prefixRaw !== undefined && (typeof prefixRaw !== 'string' || prefixRaw.trim() === '')) {
    throw new RepoConfigError(`${file}: worktrees.prefix must be a non-empty string`);
  }
  // A worktree sits beside the checkout, so a prefix that escapes that
  // directory puts it somewhere nobody is looking for it.
  if (typeof prefixRaw === 'string' && /[/\\]/.test(prefixRaw)) {
    throw new RepoConfigError(
      `${file}: worktrees.prefix ("${prefixRaw}") must not contain a path separator — ` +
        'a worktree is cut beside the checkout, not inside a directory of its own',
    );
  }
  const worktrees: Worktrees = {
    copy: (copyRaw ?? []).map((c: unknown) => String(c)),
    // Empty means "not declared" here; the effective config fills it in, since
    // only that layer knows the ship's setting and the checkout's directory.
    prefix: prefixRaw === undefined ? '' : String(prefixRaw),
  };
  const docs: RepoDocs = {};
  if (raw.docs?.triagePolicy) docs.triagePolicy = String(raw.docs.triagePolicy);
  if (raw.docs?.designGuide) docs.designGuide = String(raw.docs.designGuide);
  for (const c of worktrees.copy) {
    // An absolute path or a climb out of the tree would copy something that is
    // not this repo's to copy, into a worktree, on every ticket.
    if (c.startsWith('/') || c.split('/').includes('..')) {
      throw new RepoConfigError(
        `${file}: worktrees.copy entry "${c}" must be a path inside the repository`,
      );
    }
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
  // `external` needs no CI provider: the crew is not watching a pipeline it
  // triggered, it has simply handed the work over.
  // `integrate` needs none either: there is no pipeline, which is the point.
  if (mode !== 'local' && mode !== 'external' && mode !== 'integrate' && provider === 'none') {
    throw new RepoConfigError(`${file}: release.mode "${mode}" needs release.ci.provider`);
  }
  if (mode === 'integrate' && hooks.deploy) {
    throw new RepoConfigError(
      `${file}: release.mode "integrate" means there is nothing to deploy, but hooks.deploy ` +
        'is defined — use "local" if the crew should deploy it',
    );
  }
  if (mode === 'external' && hooks.deploy) {
    throw new RepoConfigError(
      `${file}: release.mode "external" means the crew does not release, but hooks.deploy is defined — ` +
        'remove one, or use ci_manual/ci_auto if the crew should be involved',
    );
  }
  // Without this the crew would report a CI release as successful purely on
  // the basis of having pushed. Refuse at load, not at release time.
  if (mode !== 'local' && mode !== 'external' && mode !== 'integrate' && !hooks.released) {
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
  const tagGiven = raw.release?.tag !== undefined;
  // A repo that does not version has nothing to tag WITH, so the default tag
  // simply does not apply — only an explicit one is a contradiction worth
  // refusing. Erroring on the default would make `versioning: none` require a
  // second, unrelated setting to be turned off.
  const tag = raw.release?.tag === false || raw.release?.tag === null
    ? null
    : versioning === 'none' && !tagGiven
      ? null
      : String(raw.release?.tag ?? 'v{version}');
  if (tag !== null && !tag.includes('{version}')) {
    throw new RepoConfigError(
      `${file}: release.tag ("${tag}") does not include {version} — every release would ` +
        'try to create the same tag, and the second would fail',
    );
  }
  if (tag !== null && versioning === 'none') {
    throw new RepoConfigError(
      `${file}: release.versioning is "none" but release.tag is set — there is no version to tag with. ` +
        'Set release.tag: false, or turn versioning on.',
    );
  }
  // "v{version}" -> "v*": what `git describe --match` needs to find them again.
  const tagPattern = String(
    raw.release?.tagPattern ?? (tag ? tag.replace(/\{version\}/g, '*') : 'v*'),
  );

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
    branch,
    worktrees,
    docs,
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
      tag,
      tagPattern,
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

/** Lowercase, hyphenated, trimmed — safe in a git ref and readable in a PR list. */
export function slugify(title: string, maxLength = 40): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
  return s || 'work';
}

export interface BranchContext {
  key: string;
  title?: string;
  role?: string;
}

export function renderBranchName(template: string, ctx: BranchContext): string {
  const number = ctx.key.replace(/^\D+/, '');
  return template.replace(PLACEHOLDER, (_m, name: string) => {
    switch (name) {
      case 'key': return ctx.key;
      case 'number': return number;
      case 'slug': return slugify(ctx.title ?? '');
      case 'role': return ctx.role ?? '';
      default: return '';
    }
  });
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
  branch?: Partial<BranchNaming>;
  /** The route's `worktreePrefix`, if it declares one (ISSUE-350). */
  worktrees?: { prefix?: string };
  shell?: string;
  hooks?: RepoHooks;
  labels?: Partial<Record<keyof RepoHooks, string>>;
  // `Partial<RepoConfig['release']>` alone still leaves `ci`/`verify`
  // themselves non-optional-field-wise (RepoConfig['release'] is the fully
  // RESOLVED shape, where e.g. `ci.provider` always has a concrete value) —
  // a ship's fallback may reasonably know a release's `ci.ref` without its
  // `provider`, so those two need their own fields optional too.
  release?: Partial<Omit<RepoConfig['release'], 'ci' | 'verify'>> & {
    ci?: Partial<RepoConfig['release']['ci']>;
    verify?: Partial<RepoConfig['release']['verify']>;
  };
}

/**
 * What a repository's worktrees are called when nobody says.
 *
 * The checkout's own directory name plus `-issue-`, which is what every repo
 * the crew works had already settled on by hand: `synthesis-issue-341` beside
 * `synthesis`, `crew-issue-346` beside `crew`. Deriving it means a second repo
 * added to an area needs no configuration to get its own worktree names, which
 * is the failure ISSUE-350 was filed for.
 */
export function defaultWorktreePrefix(dir: string): string {
  const name = basename(dir.replace(/[/\\]+$/, ''));
  return name ? `${name}-issue-` : 'issue-';
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

  provenance['platform'] = repo ? 'repo' : 'default';

  const mode = pick('release.mode', repo?.release.mode, ship?.release?.mode, DEFAULTS.mode);
  const provider = pick(
    'release.ci.provider',
    repo?.release.ci.provider === 'none' ? undefined : repo?.release.ci.provider,
    ship?.release?.ci?.provider,
    DEFAULTS.provider,
  );

  return {
    version: SPEC_VERSION,
    worktrees: {
      // Not merged: which gitignored files a worktree needs is a fact about
      // the repository and nothing else, so a ship cannot supply or override
      // it.
      copy: repo?.worktrees.copy ?? [],
      // Merged, unlike `copy`: this one HAS a ship-level source, because it
      // lived on the route before it lived here (ISSUE-350). The default
      // is derived from the checkout rather than fixed, so a repo that
      // declares nothing and a ship that declares nothing still get the
      // convention already in use.
      prefix: pick('worktrees.prefix', repo?.worktrees.prefix || undefined,
        ship?.worktrees?.prefix, defaultWorktreePrefix(dir)),
    },
    docs: repo?.docs ?? {},
    branch: {
      base: pick('branch.base', repo?.branch.base === 'main' ? undefined : repo?.branch.base,
        ship?.branch?.base, 'main'),
      name: pick('branch.name', repo?.branch.name === 'issue-{number}' ? undefined : repo?.branch.name,
        ship?.branch?.name, 'issue-{number}'),
      push: pick('branch.push', repo?.branch.push === repo?.branch.name ? undefined : repo?.branch.push,
        ship?.branch?.push, repo?.branch.name ?? 'issue-{number}'),
      remote: pick('branch.remote', repo?.branch.remote === 'origin' ? undefined : repo?.branch.remote,
        ship?.branch?.remote, 'origin'),
    },
    // Unlike every other field here, platform has no ship-level fallback: what
    // a repo needs of a host is a fact about that repo alone (its build
    // tooling, its hooks), never about the crew that happens to be serving it
    // — so only the repo's own `.crew.yaml` can say anything but the default.
    platform: repo?.platform ?? DEFAULTS.platform,
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
      tag: pick('release.tag', repo?.release.tag === 'v{version}' ? undefined : repo?.release.tag,
        ship?.release?.tag, 'v{version}'),
      tagPattern: pick('release.tagPattern', repo?.release.tagPattern === 'v*' ? undefined : repo?.release.tagPattern,
        ship?.release?.tagPattern, 'v*'),
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
  if (
    cfg.release.mode !== 'local' && cfg.release.mode !== 'integrate' && cfg.release.mode !== 'external'
    && cfg.release.ci.provider === 'none'
  ) {
    problems.push(`release.mode "${cfg.release.mode}" needs a CI provider`);
  }
  if (cfg.release.mode === 'local' && !cfg.hooks.deploy) {
    problems.push('release.mode "local" needs a deploy hook');
  }
  if (cfg.release.mode === 'external' && !cfg.hooks.merged) {
    problems.push(
      'release.mode "external" without a merged hook — the crew hands work off and then ' +
        'has no reliable way to learn whether it landed',
    );
  }
  if (
    cfg.release.mode !== 'local' && cfg.release.mode !== 'external'
    && cfg.release.mode !== 'integrate' && !cfg.hooks.released
  ) {
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

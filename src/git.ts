/**
 * The git the crew needs, and nothing more.
 *
 * Isolated so the release phase can be tested against a scratch repository
 * rather than against anyone's real one, and so every git invocation is in
 * one place when it comes to auditing what the crew can do to a checkout.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class GitError extends Error {}

/**
 * The same call without the trailing `.trim()`.
 *
 * `git()` trims because almost every caller wants one clean value — a sha, a
 * branch name, a tag. `git status --porcelain` is the exception: its first two
 * characters ARE data, and for a worktree-only change the first of them is a
 * space. Trimming ate it, which shifted the whole line left and silently
 * removed the first character of the first filename — `.crew.yaml` was
 * reported as `crew.yaml`, a file that does not exist.
 */
export function gitRaw(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string };
    const why = [err.stderr, err.stdout].map((x) => (x ?? '').trim()).filter(Boolean).join(' / ');
    throw new GitError(`git ${args.join(' ')}: ${why || err.message.trim()}`);
  }
}

export function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    // stdout matters as much as stderr here: git reports several failures
    // there, "nothing to commit, working tree clean" among them. Reading only
    // stderr produced a bare "Command failed" with no cause, which is what
    // made a stalled release phase so hard to read.
    const err = e as { stderr?: string; stdout?: string; message: string };
    const why = [err.stderr, err.stdout].map((x) => (x ?? '').trim()).filter(Boolean).join(' / ');
    throw new GitError(`git ${args.join(' ')}: ${why || err.message.trim()}`);
  }
}

/** Non-throwing, for the many "does this ref exist" questions. */
export function gitOk(cwd: string, args: string[]): string | null {
  try { return git(cwd, args); } catch { return null; }
}

export const currentBranch = (cwd: string): string => git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
export const headSha = (cwd: string): string => git(cwd, ['rev-parse', 'HEAD']);

export interface WorkingTreeChange { code: string; path: string; untracked: boolean }

export function status(cwd: string): WorkingTreeChange[] {
  // Raw, not trimmed: see gitRaw. The two-character status code is positional,
  // so leading whitespace on the first line is significant.
  return gitRaw(cwd, ['status', '--porcelain'])
    .split('\n')
    .filter((l) => l.length > 3)
    .map((l) => ({
      code: l.slice(0, 2),
      path: l.slice(3),
      untracked: l.startsWith('??'),
    }));
}

/** Branches matching a prefix, e.g. `issue-`. */
export function branches(cwd: string, pattern: string): string[] {
  const out = git(cwd, ['branch', '--list', pattern, '--format=%(refname:short)']);
  return out ? out.split('\n').filter(Boolean) : [];
}

/**
 * The existing branch for a ticket.
 *
 * Takes the repo's own naming templates (docs/REPO_SPEC.md) rather than
 * assuming `issue-<number>`: an org may use `feature/{key}` or
 * `bc/issue-{number}-{slug}` and the crew has to find what it created.
 *
 * Candidates are tried in order and the FIRST existing branch wins:
 *
 *  - the rendered template, exactly;
 *  - the same with the number unpadded, since `ISSUE-045` may have produced
 *    `issue-045` or `issue-45` depending on when it was created;
 *  - a `{slug}` template rendered as a prefix glob, because the title may
 *    have been edited since the branch was cut and the slug no longer
 *    matches — the branch is still the ticket's.
 */
export function branchForIssue(
  cwd: string,
  issueKey: string,
  templates: { name: string; push?: string } = { name: 'issue-{number}' },
  render: (t: string) => string = (t) => t.replace(/\{number\}/g, issueKey.replace(/^\D+/, '')),
): string | null {
  const num = issueKey.replace(/^\D+/, '');
  const unpadded = String(Number.parseInt(num, 10));
  const candidates: string[] = [];
  for (const template of [templates.name, templates.push].filter(Boolean) as string[]) {
    const exact = render(template);
    candidates.push(exact);
    if (num !== unpadded) candidates.push(exact.replace(num, unpadded));
    // The slug may have drifted; match on everything before it.
    if (template.includes('{slug}')) {
      const prefix = render(template.slice(0, template.indexOf('{slug}')));
      if (prefix) candidates.push(`${prefix}*`);
    }
  }
  for (const c of [...new Set(candidates)]) {
    const found = branches(cwd, c);
    if (found.length) return found[0]!;
  }
  return null;
}

export const commitBodies = (cwd: string, range: string): string =>
  gitOk(cwd, ['log', range, '--format=%B']) ?? '';

export const resolve = (cwd: string, ref: string): string | null =>
  gitOk(cwd, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]);

export const countCommits = (cwd: string, range: string): number =>
  Number.parseInt(gitOk(cwd, ['rev-list', '--count', range]) ?? '0', 10);

/**
 * The most recent release tag reachable from `ref`.
 *
 * Tags rather than a private ref: a private ref is local-only, so a second
 * ship has no idea what was released, and it does not survive a fresh clone.
 * A tag is durable, shareable, and already meaningful to everyone else
 * looking at the repository.
 */
export function latestReleaseTag(cwd: string, pattern = 'v*', ref = 'HEAD'): string | null {
  return gitOk(cwd, ['describe', '--tags', '--abbrev=0', '--match', pattern, ref]);
}

/** The commit a tag points at, following the annotation. */
export const tagCommit = (cwd: string, tag: string): string | null => resolve(cwd, tag);

export function createReleaseTag(cwd: string, tag: string, sha: string, message: string): void {
  git(cwd, ['tag', '-a', tag, sha, '-m', message]);
}

export const tagExists = (cwd: string, tag: string): boolean =>
  gitOk(cwd, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]) !== null;

export function pushTag(cwd: string, remote: string, tag: string): void {
  git(cwd, ['push', remote, tag]);
}

// ---------------------------------------------------------------------------
// Closure detection: what happened to a branch that left this machine?
// ---------------------------------------------------------------------------

/**
 * Once a branch is pushed for review, the decision is made somewhere the crew
 * cannot see — a PR merged, or closed, on a forge. This is how it finds out
 * without a forge credential.
 *
 * SHA ancestry is NOT usable: a squash merge creates a new commit, so the
 * branch head is not an ancestor of the base even though it merged. Verified
 * empirically. What survives every merge style — merge commit, rebase, squash
 * — is the TICKET KEY in the commit subject, because the squash's subject is
 * derived from the PR title, which is derived from the branch or first commit.
 *
 * Which is why, when review is required, the branch template (or the commit
 * convention) has to carry the key: it is the only durable link between a
 * ticket and whatever the forge decided to do with it.
 */
export type Closure = 'merged' | 'abandoned' | 'open' | 'unknown';

/**
 * How much weight the conclusion can bear.
 *
 * `definitive` comes from the repo's own `merged` hook, which knows the
 * forge. `heuristic` comes from the fallbacks below, which can be wrong in
 * both directions: a squash whose subject was rewritten looks unmerged, and
 * a branch deleted for unrelated reasons looks abandoned.
 *
 * Only a definitive answer should close a ticket on its own. A heuristic one
 * is a prompt for a human, because silently mis-closing a ticket is worse
 * than not closing it.
 */
export type Confidence = 'definitive' | 'heuristic';

export interface ClosureCheck {
  state: Closure;
  confidence: Confidence;
  /** The commit on the base branch that carries the key, when merged. */
  mergedAt?: string;
  detail: string;
}

/** Cheap, and the only network the crew does against a git remote. */
export function fetchRemote(cwd: string, remote = 'origin'): boolean {
  return gitOk(cwd, ['fetch', '--prune', '--quiet', remote]) !== null;
}

/**
 * Whether `remote` is even configured — a repo synced some other way (a
 * Synology-shared folder, say) legitimately has none, which `refreshBase`
 * treats as "nothing to take, carry on" rather than a fault. Checking this
 * FIRST is what lets that case stay quiet: a fetch attempted anyway would
 * fail the same way a real network/auth problem does, and the two are not
 * the same thing to a person reading the log.
 */
export function remoteConfigured(cwd: string, remote = 'origin'): boolean {
  return gitOk(cwd, ['remote', 'get-url', remote]) !== null;
}

export function remoteBranchExists(cwd: string, remote: string, branch: string): boolean {
  return gitOk(cwd, ['rev-parse', '-q', '--verify', `refs/remotes/${remote}/${branch}`]) !== null;
}

/**
 * `since` bounds the search — usually the last commit the crew already knew
 * about on the base, so a long-lived repo is not re-scanned every cycle.
 */
export function findKeyOnBase(
  cwd: string, key: string, remote: string, base: string, since?: string | null,
): string | null {
  const range = since ? `${since}..${remote}/${base}` : `${remote}/${base}`;
  // Bounded on both sides, NOT a substring search: ISSUE-32 would otherwise
  // match ISSUE-320, ISSUE-321 and ISSUE-326, and report a ticket merged
  // because a different one was. The trailing guard excludes a digit only, so
  // "(ISSUE-32)" and "ISSUE-32:" still match.
  const escaped = key.replace(/[.[\]{}()*+?^$|\\]/g, '\\$&');
  const pattern = `(^|[^0-9A-Za-z_-])${escaped}([^0-9]|$)`;
  const out = gitOk(cwd, ['log', range, '--format=%H %s', '--extended-regexp', `--grep=${pattern}`]);
  if (!out) return null;
  return out.split('\n')[0]?.split(' ')[0] ?? null;
}

/**
 * The fallback, used only when the repo defines no `merged` hook.
 *
 * Every branch of this is a HEURISTIC and says so. The key search depends on
 * whoever merged leaving the PR title alone, which nothing enforces.
 */
export function detectClosureHeuristically(
  cwd: string, key: string, pushedBranch: string, remote = 'origin', base = 'main',
  since?: string | null,
): ClosureCheck {
  const merged = findKeyOnBase(cwd, key, remote, base, since);
  if (merged) {
    return {
      state: 'merged', confidence: 'heuristic', mergedAt: merged,
      detail: `${key} appears on ${remote}/${base} at ${merged.slice(0, 8)}`,
    };
  }
  if (remoteBranchExists(cwd, remote, pushedBranch)) {
    return {
      state: 'open', confidence: 'heuristic',
      detail: `${remote}/${pushedBranch} still exists and ${key} is not on ${base}`,
    };
  }
  // The branch is gone and nothing on the base names the ticket. A forge that
  // deletes on merge would usually have left the key behind — but a rewritten
  // squash subject looks exactly like this, and so does an unrelated branch
  // deletion. Reported for a human, never acted on.
  return {
    state: 'abandoned', confidence: 'heuristic',
    detail:
      `${remote}/${pushedBranch} no longer exists and ${key} never reached ${base} — ` +
      'this is also what a squash merge with a rewritten subject looks like',
  };
}

export interface ClosureOptions {
  cwd: string;
  key: string;
  pushedBranch: string;
  remote?: string;
  base?: string;
  since?: string | null;
  /**
   * The repo's own `merged` hook. When present its answer is authoritative
   * and the heuristics below are not consulted at all.
   */
  mergedHook?: (env: Record<string, string>) => Promise<number>;
}

/**
 * Did this ticket's work land?
 *
 * Asks the repo first, because the repo knows its forge and the crew must
 * not. Falls back to inspecting git only when it has not been told how.
 */
export async function detectClosure(o: ClosureOptions): Promise<ClosureCheck> {
  const remote = o.remote ?? 'origin';
  const base = o.base ?? 'main';
  if (o.mergedHook) {
    const code = await o.mergedHook({
      CREW_TICKET: o.key, CREW_BRANCH: o.pushedBranch, CREW_BASE: base,
    });
    if (code === 0) {
      // The hook only answers WHETHER it merged, not WHERE — resolve the same
      // way the heuristic path does, so a hook-confirmed merge still carries a
      // commit sha when the base names the key. A squash whose subject was
      // rewritten leaves this undefined; the hook's answer is still definitive
      // either way, just without a sha to stamp.
      const mergedAt = findKeyOnBase(o.cwd, o.key, remote, base, o.since) ?? undefined;
      return {
        state: 'merged', confidence: 'definitive', mergedAt,
        detail: `the repo's merged hook says ${o.key} landed`,
      };
    }
    // A hook that ran and said "no" is still definitive about not-merged; it
    // just cannot distinguish "still open" from "closed unmerged", which the
    // branch's existence can.
    return remoteBranchExists(o.cwd, remote, o.pushedBranch)
      ? { state: 'open', confidence: 'definitive', detail: `the repo's merged hook says ${o.key} has not landed` }
      : { state: 'abandoned', confidence: 'definitive', detail: `${o.key} has not landed and ${remote}/${o.pushedBranch} is gone` };
  }
  return detectClosureHeuristically(o.cwd, o.key, o.pushedBranch, remote, base, o.since);
}

// ---------------------------------------------------------------------------
// Worktree sync: keeping local work level with what reviewers pushed
// ---------------------------------------------------------------------------

/** The upstream ref for a branch, e.g. "origin/issue-326". */
export function upstreamOf(cwd: string, branch: string): string | null {
  return gitOk(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`]);
}

export interface SyncState {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  /**
   * Safe to fast-forward: there is something to take, nothing of our own to
   * lose, and no uncommitted work to disturb.
   */
  canFastForward: boolean;
  detail: string;
}

/**
 * Is this worktree level with the branch reviewers are pushing to?
 *
 * A reviewer's own commits, or a pull from a shared branch carrying other
 * people's work, land on the remote — and until the worktree takes them, the
 * dev seat would build on stale code and the QA seat would verify something
 * nobody is reviewing.
 *
 * Fast-forward ONLY, and only from a clean tree. Diverged or dirty is
 * reported for a human: merging or rebasing on someone's behalf risks losing
 * work, and the crew has no standing to resolve a conflict nobody asked it to.
 */
export function syncState(cwd: string, branch: string): SyncState {
  const upstream = upstreamOf(cwd, branch);
  if (!upstream) {
    return {
      branch, upstream: null, ahead: 0, behind: 0,
      dirty: status(cwd).length > 0, canFastForward: false,
      detail: `${branch} tracks no remote branch`,
    };
  }
  const counts = gitOk(cwd, ['rev-list', '--left-right', '--count', `${upstream}...${branch}`]) ?? '0\t0';
  const [behindStr, aheadStr] = counts.split(/\s+/);
  const behind = Number.parseInt(behindStr ?? '0', 10);
  const ahead = Number.parseInt(aheadStr ?? '0', 10);
  const dirty = status(cwd).length > 0;

  let detail: string;
  if (behind === 0 && ahead === 0) detail = `level with ${upstream}`;
  else if (dirty) detail = `${behind} behind ${upstream}, but the worktree is dirty — not touching it`;
  else if (ahead > 0 && behind > 0) detail = `diverged from ${upstream} (${ahead} ahead, ${behind} behind) — needs a human`;
  else if (behind > 0) detail = `${behind} behind ${upstream} — fast-forwardable`;
  else detail = `${ahead} ahead of ${upstream}, nothing to take`;

  return {
    branch, upstream, ahead, behind, dirty,
    canFastForward: behind > 0 && ahead === 0 && !dirty,
    detail,
  };
}

/** Takes what the remote has. Refuses anything that is not a fast-forward. */
export function fastForward(cwd: string, branch: string): boolean {
  const s = syncState(cwd, branch);
  if (!s.canFastForward) return false;
  return gitOk(cwd, ['merge', '--ff-only', s.upstream!]) !== null;
}

export interface WorktreeInfo { path: string; branch: string | null }

export function worktrees(cwd: string): WorktreeInfo[] {
  const out = gitOk(cwd, ['worktree', 'list', '--porcelain']) ?? '';
  const list: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) list.push({ path: current.path, branch: current.branch ?? null });
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line === 'detached') {
      current.branch = null;
    }
  }
  if (current.path) list.push({ path: current.path, branch: current.branch ?? null });
  return list;
}

/**
 * `owner/repo` (the tracker's `Repos.remote` shape) -> a real clone URL.
 *
 * SSH over GitHub, matching what every checkout actually observed on this
 * fleet uses (no ship here authenticates over HTTPS) — not configurable
 * per-workspace yet because nothing has needed it to be; revisit if a repo
 * genuinely lives somewhere else.
 */
export function cloneUrlFor(remote: string): string {
  return `git@github.com:${remote}.git`;
}

/**
 * Clones `remote` into `dir` if `dir` isn't a real checkout yet — the lazy
 * half of the base-path convention (`config.ts`'s `defaultRepoDir`): a
 * route can name every repo its area covers without every ship needing a
 * pre-existing clone of each one, at the cost of doing the clone on first
 * need instead of up front. `crew connect` deliberately does NOT call this
 * for every repo it discovers — that would fetch repos this ship may never
 * actually be asked to work, for no benefit over doing it when a ticket
 * first needs it.
 *
 * A no-op, not an error, when `dir` already has a `.git` — an operator-
 * placed checkout (explicit `repos:` entry) or one this function already
 * cloned on an earlier run.
 */
export function ensureRepoCheckout(dir: string, remote: string | undefined): boolean {
  if (existsSync(`${dir}/.git`)) return false;
  if (!remote) {
    throw new GitError(
      `${dir} does not exist and this repo has no discovered remote to clone from — ` +
      `re-run \`crew connect\`, or check out the repository yourself and point \`repos:\` at it`,
    );
  }
  mkdirSync(dirname(dir), { recursive: true });
  try {
    execFileSync('git', ['clone', cloneUrlFor(remote), dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string };
    const why = [err.stderr, err.stdout].map((x) => (x ?? '').trim()).filter(Boolean).join(' / ');
    throw new GitError(`git clone ${cloneUrlFor(remote)} ${dir}: ${why || err.message.trim()}`);
  }
  return true;
}

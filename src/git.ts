/**
 * The git the crew needs, and nothing more.
 *
 * Isolated so the release phase can be tested against a scratch repository
 * rather than against anyone's real one, and so every git invocation is in
 * one place when it comes to auditing what the crew can do to a checkout.
 */

import { execFileSync } from 'node:child_process';

export class GitError extends Error {}

export function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new GitError(`git ${args.join(' ')}: ${(err.stderr || err.message).trim()}`);
  }
}

/** Non-throwing, for the many "does this ref exist" questions. */
export function gitOk(cwd: string, args: string[]): string | null {
  try { return git(cwd, args); } catch { return null; }
}

export const currentBranch = (cwd: string): string => git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
export const headSha = (cwd: string): string => git(cwd, ['rev-parse', 'HEAD']);
export const shortSha = (cwd: string, sha: string): string => git(cwd, ['rev-parse', '--short', sha]);

export interface WorkingTreeChange { code: string; path: string; untracked: boolean }

export function status(cwd: string): WorkingTreeChange[] {
  const out = git(cwd, ['status', '--porcelain']);
  if (!out) return [];
  return out.split('\n').map((l) => ({
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

export const setRef = (cwd: string, ref: string, sha: string): void => {
  git(cwd, ['update-ref', ref, sha]);
};

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
      return { state: 'merged', confidence: 'definitive', detail: `the repo's merged hook says ${o.key} landed` };
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

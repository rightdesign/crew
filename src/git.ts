/**
 * The git the crew needs, and nothing more.
 *
 * Isolated so the release phase can be tested against a scratch repository
 * rather than against anyone's real one, and so every git invocation is in
 * one place when it comes to auditing what the crew can do to a checkout.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, openSync, closeSync, writeSync, statSync, unlinkSync,
} from 'node:fs';
import { dirname, basename } from 'node:path';

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
  // ISSUE-969: a repo's default template now depends on whether the TICKET
  // carries a project tag (`effectiveBranchTemplate`), not only on the repo
  // — so a ticket cut before the workspace adopted tags, or one with no tag
  // at all, may still be sitting on the plain `issue-{number}` branch even
  // though today's default for a *tagged* sibling ticket in the same repo
  // is `{prefix}-{number}`. Tried last, and only when not already covered
  // by the templated candidates above.
  candidates.push(`issue-${num}`);
  if (num !== unpadded) candidates.push(`issue-${unpadded}`);
  for (const c of [...new Set(candidates)]) {
    const found = branches(cwd, c);
    if (found.length) return found[0]!;
  }
  return null;
}

/**
 * The worktree already on disk for a ticket number, found by scanning
 * `git worktree list` rather than guessing its directory name from a prefix.
 *
 * A repo names its worktrees after whichever project a ticket happens to
 * belong to (ISSUE-969), and the naming scheme itself has changed over
 * time — `tabl-946`, `synthesis-issue-946`, `crew-issue-336` can all exist
 * side by side on the same fleet. Ticket numbers are globally unique
 * (`tracker.ts`), so matching on the trailing `-<number>` finds the
 * worktree regardless of which scheme created it, with no need to know —
 * or agree on — the "correct" prefix first.
 */
export function worktreeForNumber(cwd: string, num: string): WorktreeInfo | null {
  const re = new RegExp(`(?:^|-)${num}$`);
  return worktrees(cwd).find((w) => re.test(basename(w.path))) ?? null;
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
/**
 * The sha of the first commit in `range` whose subject names `key` — or, when
 * given more than one, any of them.
 *
 * A ticket has two names once it carries a project tag (ISSUE-969):
 * `issue_id` (`ISSUE-969`, globally unique, what the crew looks the ticket up
 * by) and `issue_tag` (`CREW-969`, what a commit or branch is actually likely
 * to say, since that is the convention branches/commits now follow). A
 * commit can reference either — the search has to try both, or a ticket
 * whose work landed under its tag reads as never having landed at all.
 *
 * Bounded on both sides, NOT a substring search: ISSUE-32 would otherwise
 * match ISSUE-320, ISSUE-321 and ISSUE-326, and report a ticket merged
 * because a different one was. The trailing guard excludes a digit only, so
 * "(ISSUE-32)" and "ISSUE-32:" still match.
 */
export function findKeyInRange(cwd: string, key: string | string[], range: string): string | null {
  return keyCommitsInRange(cwd, key, range)[0] ?? null;
}

/** Every commit in `range` naming `key`, newest first. Same matching as `findKeyInRange`. */
export function keyCommitsInRange(cwd: string, key: string | string[], range: string): string[] {
  const keys = Array.isArray(key) ? key : [key];
  const escaped = keys.map((k) => k.replace(/[.[\]{}()*+?^$|\\]/g, '\\$&'));
  const pattern = `(^|[^0-9A-Za-z_-])(${escaped.join('|')})([^0-9]|$)`;
  const out = gitOk(cwd, ['log', range, '--format=%H %s', '--extended-regexp', `--grep=${pattern}`]);
  if (!out) return [];
  return out.split('\n').map((l) => l.split(' ')[0]!).filter(Boolean);
}

/** The stable patch-id of a diff between two refs, or null when it is empty or unreadable. */
function patchIdOf(cwd: string, from: string, to: string): string | null {
  try {
    const diff = execFileSync('git', ['diff', from, to], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (!diff) return null;
    const out = execFileSync('git', ['patch-id', '--stable'], { cwd, encoding: 'utf8', input: diff });
    return out.split(' ')[0]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The commit in `range` that already carries `branch`'s work, or null.
 *
 * A squash-merge leaves the branch alive until the release stamps the ticket,
 * and re-squashing it later is only a no-op while nothing else has touched
 * the same files — once a later commit does, the replay reports a conflict
 * for work that is live on the base. So ask the question directly instead of
 * inferring it from an empty squash: among commits naming the ticket, is
 * there one whose tree IS the branch's, or whose own change (vs its parent)
 * is the branch's change (vs where it forked from `base`)? The second test
 * is what survives unrelated commits landing in between, because the
 * patch-id ignores the surrounding context.
 */
export function findSquashOfBranch(
  cwd: string, key: string | string[], branch: string, base: string, range: string,
): string | null {
  const candidates = keyCommitsInRange(cwd, key, range);
  if (candidates.length === 0) return null;
  const mb = gitOk(cwd, ['merge-base', base, branch]);
  const branchPatch = mb ? patchIdOf(cwd, mb, branch) : null;
  for (const sha of candidates) {
    if (gitOk(cwd, ['diff', '--quiet', branch, sha]) !== null) return sha;
    if (branchPatch && gitOk(cwd, ['rev-parse', '--verify', '-q', `${sha}^`]) !== null
      && patchIdOf(cwd, `${sha}^`, sha) === branchPatch) return sha;
  }
  return null;
}

/**
 * Whether `ancestor` is reachable from `descendant` — i.e. already folded
 * into its history.
 *
 * Used, rather than exact-sha equality, to match a released commit reported
 * by `hooks.released` against a ticket's own merge commit: a batched CI
 * build on the base branch usually reports a commit LATER than any single
 * ticket's own merge, so equality (or the prefix match `confirm()` uses for
 * `ci_auto`/`ci_manual`, where the crew controls exactly what it pushed)
 * would false-negative on every ticket but the very last one folded into
 * that build. Any git error — an unknown sha, most likely one neither side
 * has fetched yet — reads as "not an ancestor" rather than throwing: this is
 * a confirmation check, and an unconfirmed answer is the correct response to
 * not being able to tell.
 */
export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return gitOk(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]) !== null;
}

/**
 * The content of `path` as of `ref`, without checking it out — for reading a
 * version file at a commit this checkout merely has fetched, not built.
 * `null` when the ref or the path can't be read locally (not fetched, wrong
 * path), same "can't tell, so don't" posture as `isAncestor`.
 */
export function fileAtRef(cwd: string, ref: string, path: string): string | null {
  return gitOk(cwd, ['show', `${ref}:${path}`]);
}

export function findKeyOnBase(
  cwd: string, key: string | string[], remote: string, base: string, since?: string | null,
): string | null {
  const range = since ? `${since}..${remote}/${base}` : `${remote}/${base}`;
  return findKeyInRange(cwd, key, range);
}

/**
 * The fallback, used only when the repo defines no `merged` hook.
 *
 * Every branch of this is a HEURISTIC and says so. The key search depends on
 * whoever merged leaving the PR title alone, which nothing enforces.
 *
 * `aliases` (ISSUE-969) are other names the same commit might carry — a
 * ticket's `issue_tag` alongside its canonical `issue_id` — searched
 * alongside `key` but never used in place of it for the messages below,
 * which stay in terms of the canonical key a person looked this ticket up
 * by.
 */
export function detectClosureHeuristically(
  cwd: string, key: string, pushedBranch: string, remote = 'origin', base = 'main',
  since?: string | null, aliases: string[] = [],
): ClosureCheck {
  const merged = findKeyOnBase(cwd, [key, ...aliases], remote, base, since);
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
   * Other names a commit might carry for the same ticket (ISSUE-969) —
   * typically its `issue_tag`, e.g. `CREW-969` beside the canonical
   * `issue_id` `ISSUE-969`. Only widens the git-history search; `key` alone
   * is still what is passed to the `merged` hook and what every message here
   * names.
   */
  aliases?: string[];
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
  const aliases = o.aliases ?? [];
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
      const mergedAt = findKeyOnBase(o.cwd, [o.key, ...aliases], remote, base, o.since) ?? undefined;
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
  return detectClosureHeuristically(o.cwd, o.key, o.pushedBranch, remote, base, o.since, aliases);
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

// ---------------------------------------------------------------------------
// Base branch refresh: keeping the PRIMARY checkout (not a worktree) level
// with the remote, both before a release decides anything and before an
// agent cuts a new ticket's worktree from it.
// ---------------------------------------------------------------------------

export type BaseRefreshOutcome =
  | { action: 'not-applicable'; detail: string }
  | { action: 'fetch-failed'; detail: string }
  | { action: 'level'; detail: string }
  | { action: 'would-fast-forward'; behind: number; detail: string }
  | { action: 'fast-forwarded'; behind: number; detail: string }
  | { action: 'diverged'; ahead: number; behind: number; detail: string }
  | { action: 'ff-failed'; behind: number; detail: string };

/**
 * Brings `base`'s local ref in `cwd` level with `<remote>/<base>`,
 * fast-forward only, from a clean tree.
 *
 * `syncState`/`fastForward` above answer the same question for a WORKTREE's
 * branch, via its own `@{upstream}` — set automatically because a worktree's
 * branch was either pushed for review or cut with `-b`. A checkout's base
 * branch is different: an operator or script placed it, so it very often
 * tracks nothing, and comparing through `@{upstream}` would silently report
 * "tracks no remote branch" forever. This measures against `<remote>/<base>`
 * directly instead, the same way `release-run.ts`'s own pre-release refresh
 * always has.
 *
 * `not-applicable` covers every "nothing to take, carry on" case that isn't
 * a fault: `cwd` isn't on `base`, `cwd` is dirty, no remote is configured, or
 * the remote has no `base` at all (three repos on this ship legitimately
 * have none of any of these). A caller that wants to warn on `fetch-failed`
 * specifically may; the rest are quiet by design, same reasoning
 * `release-run.ts` already documented for its own copy of this check.
 */
export function refreshBaseBranch(cwd: string, remote: string, base: string, dryRun = false): BaseRefreshOutcome {
  if (currentBranch(cwd) !== base || status(cwd).length > 0) {
    return { action: 'not-applicable', detail: `${cwd} is not on a clean ${base}` };
  }
  if (!remoteConfigured(cwd, remote)) {
    return { action: 'not-applicable', detail: `${remote} is not configured` };
  }
  if (!fetchRemote(cwd, remote)) {
    return { action: 'fetch-failed', detail: `could not fetch ${remote}` };
  }
  if (!remoteBranchExists(cwd, remote, base)) {
    return { action: 'not-applicable', detail: `${remote}/${base} does not exist` };
  }
  const upstream = `${remote}/${base}`;
  const counts = gitOk(cwd, ['rev-list', '--left-right', '--count', `${upstream}...${base}`]) ?? '0\t0';
  const [behindStr, aheadStr] = counts.split(/\s+/);
  const behind = Number.parseInt(behindStr ?? '0', 10);
  const ahead = Number.parseInt(aheadStr ?? '0', 10);
  if (ahead > 0 && behind > 0) {
    return {
      action: 'diverged', ahead, behind,
      detail: `${base} has diverged from ${upstream} (${ahead} ahead, ${behind} behind)`,
    };
  }
  if (behind === 0) return { action: 'level', detail: `${base} is level with ${upstream}` };
  if (dryRun) {
    return { action: 'would-fast-forward', behind, detail: `would fast-forward ${base}: ${behind} behind ${upstream}` };
  }
  if (gitOk(cwd, ['merge', '--ff-only', upstream]) === null) {
    return { action: 'ff-failed', behind, detail: `${base} is ${behind} behind ${upstream} and would not fast-forward` };
  }
  return {
    action: 'fast-forwarded', behind,
    detail: `fast-forwarded ${base} to ${upstream} (${behind} commit(s) from elsewhere)`,
  };
}

/** Pushes `branch`'s current local commit to `remote`. Throws on rejection. */
export function pushBranch(cwd: string, remote: string, branch: string): void {
  git(cwd, ['push', remote, branch]);
}

/**
 * `prunable` is true when git itself says so (e.g. the gitdir file points to
 * a directory that no longer exists) — a worktree someone deleted by hand
 * rather than through `git worktree remove`, or that this repo's own
 * worktree-drop step already ran for. Callers must skip these rather than
 * running git commands against a path that isn't there (ISSUE-820).
 */
export interface WorktreeInfo { path: string; branch: string | null; prunable: boolean }

export function worktrees(cwd: string): WorktreeInfo[] {
  const out = gitOk(cwd, ['worktree', 'list', '--porcelain']) ?? '';
  const list: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) list.push({ path: current.path, branch: current.branch ?? null, prunable: current.prunable ?? false });
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line === 'detached') {
      current.branch = null;
    } else if (line.startsWith('prunable ')) {
      current.prunable = true;
    }
  }
  if (current.path) list.push({ path: current.path, branch: current.branch ?? null, prunable: current.prunable ?? false });
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

// ---------------------------------------------------------------------------
// Host Passengers' dedicated checkout (ISSUE-554, decisions 7-8 in the Map,
// b9f59bd9-8ed5-4479-b85d-f0a64d00726c): a `crewd`-maintained clone that is
// always a coherent snapshot of `branch.base`, never a role's ephemeral
// build worktree and never even the primary checkout a builder can leave
// dirty or mid-branch.
// ---------------------------------------------------------------------------

export type PassengerCheckoutOutcome = { action: 'cloned'; detail: string } | BaseRefreshOutcome;

/** A sync that legitimately runs a `git fetch`/`clone` never takes anywhere near this long — past it, the holder is presumed crashed mid-sync rather than still working. */
const CHECKOUT_LOCK_STALE_MS = 5 * 60 * 1000;

export function checkoutLockPath(dir: string): string {
  return `${dir}.sync.lock`;
}

/** Synchronous sleep via `Atomics.wait` — consistent with the rest of this module's synchronous-git style; a short busy-wait is fine for a lock two callers hold for well under a second each. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Cross-process advisory lock keyed on the checkout directory, so the
 * poll-cadence sync (`syncAllPassengerCheckouts`, in-process inside `crew
 * run`/`poll`) and the per-container sync daemon's `/sync` handler (a
 * separate detached process, `passenger-sync-daemon.ts`) can never both run
 * `git fetch`/`merge --ff-only` against the same checkout at once and race
 * on `.git/index.lock`/refs. `openSync(path, 'wx')` is what makes acquiring
 * it atomic across processes — the OS refuses a second exclusive-create
 * against the same path. A lock older than `CHECKOUT_LOCK_STALE_MS` is
 * treated as abandoned (its holder crashed) rather than honored forever.
 */
export function acquireCheckoutLock(dir: string, timeoutMs = 30_000): () => void {
  const lockPath = checkoutLockPath(dir);
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => { try { unlinkSync(lockPath); } catch { /* already released */ } };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > CHECKOUT_LOCK_STALE_MS) {
          try { unlinkSync(lockPath); } catch { /* another waiter already cleared it */ }
          continue;
        }
      } catch { /* lock vanished between the failed create and this stat - just retry */ }
      if (Date.now() > deadline) {
        throw new GitError(`timed out waiting for the sync lock on ${dir} (held by another sync)`);
      }
      sleepSync(50);
    }
  }
}

/**
 * Brings a passenger checkout at `dir` level with `base`, cloning it first
 * if this is the first cycle to need it.
 *
 * `githubRemote` (`owner/repo`) is what a first-time clone needs —
 * `ensureRepoCheckout`'s own parameter, the same shape `defaultRepoDir`'s
 * lazy-clone convention already uses elsewhere. `gitRemoteName` (typically
 * `origin`, from the repo's own resolved `branch.remote`) is the LOCAL name
 * `refreshBaseBranch` compares against once the clone exists — a different
 * string with a similar name, so both are required rather than one being
 * derived from the other.
 *
 * A fresh clone lands on whatever the remote's own HEAD default branch is,
 * which is not guaranteed to be `base` (a repo could default to `master`
 * while the ship's contract calls its base `main`) — so a clone that didn't
 * land there switches to it explicitly before reporting `cloned`.
 *
 * Locked for the duration (see `acquireCheckoutLock`) since this is called
 * from two independent processes against the same `dir`.
 */
export function syncPassengerCheckout(
  dir: string, githubRemote: string | undefined, gitRemoteName: string, base: string,
): PassengerCheckoutOutcome {
  const release = acquireCheckoutLock(dir);
  try {
    if (ensureRepoCheckout(dir, githubRemote)) {
      if (currentBranch(dir) !== base) git(dir, ['checkout', base]);
      return { action: 'cloned', detail: `cloned ${githubRemote} into ${dir}` };
    }
    return refreshBaseBranch(dir, gitRemoteName, base);
  } finally {
    release();
  }
}

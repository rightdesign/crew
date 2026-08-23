/**
 * The release phase: merge what QA verified, version it, ship it, confirm it.
 *
 * Ported from release_if_unreleased / merge_verified_branches / next_version /
 * write_changelog in bin/crew. Single-repo; the multi-repo DAG from ISSUE-331
 * is a follow-up.
 *
 * As with the poll, deciding is separated from doing. `checkGuards` and
 * `planMerge` answer "may we, and what would we merge" without touching the
 * checkout, which is what makes a dry run honest and the guards testable.
 */

import {
  branchForIssue, commitBodies, countCommits, currentBranch, latestReleaseTag,
  resolve, status, tagCommit,
} from './git.ts';
import type { Ticket } from './tracker.ts';
import type { Contract } from './contract.ts';

/** A refusal to release, and why. Never an error: refusing is usually correct. */
export interface ReleaseBlock { kind: 'branch' | 'dirty'; detail: string }

/**
 * May this checkout be released at all?
 *
 * The deploy builds from the WORKING TREE, so anything uncommitted would
 * ship. Both refusals are correct and stay; what was wrong historically is
 * that refusing was silent — eight commits once sat unreleased behind a
 * single untracked file with nothing saying so (ISSUE-174). So the detail
 * here names the files: the count conveys urgency, the names make it a
 * ten-second fix.
 */
export function checkGuards(cwd: string, base = 'main'): ReleaseBlock | null {
  const branch = currentBranch(cwd);
  if (branch !== base) {
    return { kind: 'branch', detail: `primary checkout is on '${branch}', not ${base}` };
  }
  const changes = status(cwd);
  if (changes.length === 0) return null;

  const untracked = changes.filter((c) => c.untracked).length;
  const names = changes.slice(0, 3).map((c) => c.path).join(', ');
  const more = changes.length > 3 ? `, +${changes.length - 3} more` : '';
  // Untracked is called out separately because it is the case that surprises
  // people — a scratch file, or a generated file a routine command rewrote.
  const untrackedNote = untracked > 0 ? ` (${untracked} untracked)` : '';
  return {
    kind: 'dirty',
    detail: `working tree has ${changes.length} change(s)${untrackedNote}: ${names}${more}`,
  };
}

export interface MergeCandidate {
  ticket: Ticket;
  branch: string | null;
  /** Changelog: lines from the branch's commits, or a fallback. */
  entries: string[];
  usedFallback: boolean;
  /** Why it is not mergeable, when branch is null. */
  skipReason?: 'already-merged' | 'never-built';
}

const CHANGELOG_LINE = /^Changelog:[ \t]*(.*)$/gm;
const BUMP_LINE = /^Bump:[ \t]*(major|minor|patch)\b/gim;

/**
 * What the merge phase would do.
 *
 * Oldest ticket first, so the changelog reads in filing order and the older
 * branch merges against the cleaner tree.
 *
 * A verified ticket with no branch is two very different situations wearing
 * the same shape: already merged on an earlier cycle whose deploy has not
 * succeeded yet (normal — the stamp after that deploy closes it), or nobody
 * ever wrote code for it (worth saying out loud, every cycle).
 */
export function planMerge(
  cwd: string, tickets: Ticket[], contract: Contract, lastReleased: string | null,
  branchFor: (t: Ticket) => string | null = (t) => branchForIssue(cwd, t.issue_id),
  base = 'main',
): MergeCandidate[] {
  const verified = tickets
    .filter((t) => t.status === contract.statuses.verified)
    .sort((a, b) => Number.parseInt(a.issue_id.replace(/^\D+/, ''), 10) - Number.parseInt(b.issue_id.replace(/^\D+/, ''), 10));

  return verified.map((ticket) => {
    const branch = branchFor(ticket);
    if (!branch) {
      const onMain = lastReleased
        ? commitBodies(cwd, `${lastReleased}..HEAD`).includes(ticket.issue_id)
        : false;
      return {
        ticket, branch: null, entries: [], usedFallback: false,
        skipReason: onMain ? 'already-merged' : 'never-built',
      };
    }
    // Read the Changelog:/Bump: lines while the branch history is still
    // reachable — the squash is about to flatten it.
    const bodies = commitBodies(cwd, `${base}..${branch}`);
    const entries = [...bodies.matchAll(CHANGELOG_LINE)].map((m) => m[1]!.trim()).filter(Boolean);
    const usedFallback = entries.length === 0;
    return {
      ticket, branch,
      entries: usedFallback ? [`${ticket.title || ticket.issue_id} (${ticket.issue_id})`] : entries,
      usedFallback,
    };
  });
}

export type BumpSize = 'major' | 'minor' | 'patch';

/**
 * The bump the merged branches asked for.
 *
 * `major` is deliberately NOT reachable from a commit message: it is the
 * operator's call alone, and the prompts tell every seat so. A branch that
 * asks for it is honoured as `minor` and the request reported, rather than
 * silently downgraded the way the bash arithmetic did.
 */
export function requestedBump(bodies: string): { size: BumpSize; majorRequested: boolean } {
  const asks = [...bodies.matchAll(BUMP_LINE)].map((m) => m[1]!.toLowerCase());
  const majorRequested = asks.includes('major');
  const size: BumpSize = asks.includes('minor') || majorRequested ? 'minor' : 'patch';
  return { size, majorRequested };
}

/** Newest first, directly under the heading — matching CHANGELOG conventions. */
export function renderChangelogSection(version: string, date: string, entries: string[]): string {
  const body = entries.map((e) => `- ${e}`).join('\n');
  return `## ${version} — ${date}\n\n${body}\n`;
}

export function insertChangelogSection(existing: string, section: string): string {
  const lines = existing.split('\n');
  // After the file's title and any preamble, before the first existing release.
  const firstRelease = lines.findIndex((l) => /^## /.test(l));
  if (firstRelease === -1) return `${existing.trimEnd()}\n\n${section}`;
  return [...lines.slice(0, firstRelease), section, ...lines.slice(firstRelease)].join('\n');
}

export interface ReleaseDecision {
  block: ReleaseBlock | null;
  merges: MergeCandidate[];
  head: string;
  /** The tag naming the last release, e.g. "v0.57.7". */
  lastTag: string | null;
  lastReleased: string | null;
  unreleasedCommits: number;
  /** Nothing new on main — merging may still have happened this cycle. */
  upToDate: boolean;
  /**
   * Set when the repo has no release tag at all. The crew must NOT then treat
   * every commit in history as unreleased: it releases forward from here and
   * says so, rather than deploying an unbounded backlog nobody asked for.
   */
  unseeded: boolean;
}

export interface ReleaseOptions {
  /** Tag pattern, e.g. "v*". Matches the `release.tag` template's prefix. */
  tagPattern?: string;
  /** The integration branch. Not assumed to be `main`. */
  base?: string;
}

export function decideRelease(
  cwd: string, tickets: Ticket[], contract: Contract, opts: ReleaseOptions = {},
): ReleaseDecision {
  const pattern = opts.tagPattern ?? 'v*';
  const base = opts.base ?? 'main';
  const block = checkGuards(cwd, base);
  const lastTag = latestReleaseTag(cwd, pattern, 'HEAD');
  const lastReleased = lastTag ? tagCommit(cwd, lastTag) : null;
  const head = resolve(cwd, 'HEAD') ?? '';
  const merges = block
    ? []
    : planMerge(cwd, tickets, contract, lastReleased, (t) => branchForIssue(cwd, t.issue_id), base);
  const unreleasedCommits = lastReleased ? countCommits(cwd, `${lastReleased}..HEAD`) : 0;
  return {
    block, merges, head, lastTag, lastReleased, unreleasedCommits,
    upToDate: lastReleased === head,
    unseeded: lastTag === null,
  };
}

/** "v{version}" -> "v0.58.0". The only substitution is {version}. */
export const renderTag = (template: string, version: string): string =>
  template.replace(/\{version\}/g, version);

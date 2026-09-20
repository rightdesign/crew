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
  branchForIssue, commitBodies, countCommits, currentBranch, findKeyInRange, latestReleaseTag,
  resolve, status, tagCommit,
} from './git.ts';
import { referenceKeys, type Ticket } from './tracker.ts';
import type { Contract } from './contract.ts';

/**
 * What to say about tickets the release could not place in any checkout.
 *
 * Pure, and separate from emitting, for the reason the rest of this module is:
 * which of these is a WARNING is a decision worth testing, and it used to be
 * wrong. One `unplaceable` list was reported with one sentence — "name no
 * repository" — of which only `no-repo` was ever true (ISSUE-351).
 *
 * `not-served-here` is deliberately NOT a warning. This ship declining a
 * repository it has no checkout for is correct behaviour, another ship
 * serves it, and warning about it every cycle is how an operator learns to
 * ignore the release phase's real warnings.
 */
export interface UnplaceableNote { level: 'warn' | 'info'; message: string }

export function describeUnplaceable(
  unplaceable: Array<{ ticket: Ticket; reason: string; repo?: string }>,
  verifiedStatus: string,
): UnplaceableNote[] {
  const stranded = unplaceable.filter((u) => u.ticket.status === verifiedStatus);
  if (stranded.length === 0) return [];
  const notes: UnplaceableNote[] = [];
  const keysFor = (r: string) =>
    stranded.filter((u) => u.reason === r).map((u) => u.ticket.issue_id);

  const noRepo = keysFor('no-repo');
  if (noRepo.length) {
    notes.push({
      level: 'warn',
      message:
        `${noRepo.length} verified ticket(s) name no repository and cannot be released: ` +
        noRepo.join(', '),
    });
  }

  const unknown = keysFor('unknown-repo');
  if (unknown.length) {
    notes.push({
      level: 'warn',
      message:
        `${unknown.length} verified ticket(s) name a repository this ship does not recognise — ` +
        `run \`crew connect\` to refresh its repo list: ${unknown.join(', ')}`,
    });
  }

  const elsewhere = stranded.filter((u) => u.reason === 'not-served-here');
  if (elsewhere.length) {
    const byRepoName = new Map<string, string[]>();
    for (const u of elsewhere) {
      const name = u.repo ?? '?';
      byRepoName.set(name, [...(byRepoName.get(name) ?? []), u.ticket.issue_id]);
    }
    notes.push({
      level: 'info',
      message:
        `${elsewhere.length} verified ticket(s) belong to a repository this ship has no ` +
        `checkout for — another ship releases them: ` +
        [...byRepoName].map(([n, ids]) => `${n} (${ids.join(', ')})`).join('; '),
    });
  }
  return notes;
}

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
  /**
   * The bump this branch asked for, read from its own commits.
   *
   * Read HERE, with the changelog lines, because the squash is about to
   * flatten the branch and the crew writes its own subject — so a `Bump:`
   * line left on the branch would be gone by the time anything looked for it
   * in the merged history. That was a real bug: a branch asking for `minor`
   * silently shipped as `patch`.
   */
  bump: BumpSize;
  majorRequested: boolean;
  /** Why it is not mergeable, when branch is null. */
  skipReason?: 'already-merged' | 'never-built';
  /**
   * The squash-merge commit this run wrote for it, when it wrote one.
   *
   * Unset for a `noop` merge (no commit — the change was already on the
   * base) and for a dry run (nothing was actually committed). Set here,
   * mutating the candidate `mergeOne` already returned, rather than
   * threaded back through a parallel structure — `merged` (the array of
   * candidates the release loop builds) is already what `planStamp` reads
   * per ticket.
   */
  sha?: string;
}

export type BumpSize = 'major' | 'minor' | 'patch';

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
      // Bounded, and matches either the ticket's issue_id or its issue_tag
      // (ISSUE-969) — a plain `.includes(ticket.issue_id)` would call a
      // ticket "never built" the moment work landed under its tag instead
      // (`CREW-969` rather than `ISSUE-969`), which is now the branch/commit
      // convention for a ticket that has one.
      const onMain = lastReleased
        ? findKeyInRange(cwd, referenceKeys(ticket), `${lastReleased}..HEAD`) !== null
        : false;
      return {
        ticket, branch: null, entries: [], usedFallback: false,
        bump: 'patch', majorRequested: false,
        skipReason: onMain ? 'already-merged' : 'never-built',
      };
    }
    // Read the Changelog:/Bump: lines while the branch history is still
    // reachable — the squash is about to flatten it.
    const bodies = commitBodies(cwd, `${base}..${branch}`);
    const entries = [...bodies.matchAll(CHANGELOG_LINE)].map((m) => m[1]!.trim()).filter(Boolean);
    const usedFallback = entries.length === 0;
    const { size, majorRequested } = requestedBump(bodies);
    return {
      ticket, branch,
      entries: usedFallback ? [`${ticket.title || ticket.issue_id} (${ticket.issue_id})`] : entries,
      usedFallback,
      bump: size,
      majorRequested,
    };
  });
}

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

/**
 * Keep a Changelog style — `## [1.2.3] — 2026-08-24` — because that is what
 * real changelogs in this shape use, including the one this replaced. An
 * unbracketed heading would read as a different document convention halfway
 * down the file.
 */
export function renderChangelogSection(version: string, date: string, entries: string[]): string {
  const body = entries.map((e) => `- ${e}`).join('\n');
  return `## [${version}] — ${date}\n\n${body}\n`;
}

/**
 * Anchors on the first heading that looks like a RELEASE, not merely the
 * first `##`.
 *
 * A real changelog often carries prose sections of its own — "How this file
 * is maintained", "Unreleased", a format note — above the releases. Inserting
 * before the first `##` put a new release between such a section's heading
 * and its body, silently corrupting the document. Fixtures never showed this;
 * the project's actual CHANGELOG.md did, immediately.
 *
 * A release heading is one whose text starts with something version-shaped:
 * `## 1.2.3`, `## v1.2.3 — 2026-08-24`, `## [1.2.3]`.
 */
const RELEASE_HEADING = /^##\s+\[?v?\d+\./;
const UNRELEASED_HEADING = /^##\s+\[?Unreleased\]?/i;

export function insertChangelogSection(existing: string, section: string): string {
  const lines = existing.split('\n');

  // Whichever comes FIRST decides — an "Unreleased" section only means
  // anything if it sits above the releases. A real changelog can carry a
  // stale one buried mid-file (the project's own does, 600 lines down); the
  // new release still belongs at the top, not next to that.
  const anchor = lines.findIndex((l) => UNRELEASED_HEADING.test(l) || RELEASE_HEADING.test(l));

  // No releases yet: append after everything, so a preamble stays intact.
  if (anchor === -1) return `${existing.trimEnd()}\n\n${section}`;

  if (UNRELEASED_HEADING.test(lines[anchor]!)) {
    // The new release goes BELOW it: Unreleased is a running list of what has
    // not shipped, not a release. Inserting above would push it down the file
    // one version at a time.
    let j = anchor + 1;
    while (j < lines.length && !/^## /.test(lines[j]!)) j++;
    return [...lines.slice(0, j), section, ...lines.slice(j)].join('\n');
  }
  return [...lines.slice(0, anchor), section, ...lines.slice(anchor)].join('\n');
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

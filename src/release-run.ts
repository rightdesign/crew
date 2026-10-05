/**
 * Performing a release.
 *
 * `release.ts` decides; this does. Every step reports what it would do before
 * doing it, and `dryRun` stops short of every mutation — so the printed plan
 * and the real run are the same code path rather than two descriptions that
 * can drift.
 *
 * Single-repo. The multi-repo DAG (ISSUE-331) is a follow-up.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createReleaseTag, detectClosure, fileAtRef, git, gitOk, GitError, headSha,
  isAncestor, latestReleaseTag, pushBranch, pushTag, refreshBaseBranch, remoteConfigured, tagCommit, tagExists,
  type ClosureCheck,
} from './git.ts';
import {
  decideRelease, insertChangelogSection, renderChangelogSection, renderTag,
  type MergeCandidate, type ReleaseBlock, type ReleaseDecision,
} from './release.ts';
import type { EffectiveRepoConfig } from './repo-config.ts';
import { hookLabel } from './repo-config.ts';
import { existingBranchForTicket } from './ticket-branch.ts';
import { runScript, resolveShell } from './shell.ts';
import type { Emitter } from './events.ts';
import { referenceKeys, type Ticket } from './tracker.ts';
import { planStamp } from './stamp.ts';
import type { Contract } from './contract.ts';

export interface ReleaseRunOptions {
  /**
   * Remembers a failed deploy and counts consecutive refusals, for THIS
   * route — `State#release(name)`. Scoped, because a ship releases each
   * board's repo independently and one repo's broken deploy must not suppress
   * another's release.
   */
  state?: {
    deployFailedSha(): string | null;
    noteDeployFailed(sha: string): void;
    clearDeployFailed(): void;
    blockedCount(): number;
    noteBlocked(): number;
    clearBlocked(): void;
  };
  cwd: string;
  repo: EffectiveRepoConfig;
  contract: Contract;
  tickets: Ticket[];
  emit: Emitter;
  /**
   * `route/repo`, prefixed onto a message that would otherwise read the same
   * whether this ship has one repo or a dozen — `emit`'s own `route` field
   * (on the underlying JSONL event) never told you WHICH of a route's
   * several repos a refusal was about, only which route. Optional: a caller
   * exercising this against a scratch repo with no real route/repo identity
   * (most of this file's own tests) has nothing meaningful to put here.
   */
  scope?: string;
  dryRun: boolean;
  /** Skip the test gate — a hotfix that cannot wait on a red suite. */
  skipTests?: boolean;
  /**
   * Merge what QA verified and stop. No version, no build, no deploy, no tag.
   * `crew merge` — for getting verified work onto the integration branch
   * without waiting for a cycle, or shipping it.
   */
  mergeOnly?: boolean;
  /**
   * Release even when nothing new merged this cycle. `crew deploy` — for a
   * commit a previous deploy failed on, where the work IS unreleased but the
   * merge phase has nothing left to do.
   */
  force?: boolean;
  /**
   * Set only for `crew deploy`'s own fan-out, never for `crew merge`,
   * `crew release`, or the inline release at the tail of `crew run` (even
   * with `--force`, which also sets `force` above but is a different act).
   * A repo on `release.mode: integrate` with no `hooks.deploy` has nothing
   * that `crew deploy` could ship — the test gate protects a deploy that
   * isn't happening — so this skips just that hook, just for this command.
   * Routine merge-time test gating for the same repo is untouched: it still
   * runs on `crew merge`/`crew release`/`crew run`, which is the whole
   * point of the gate.
   */
  isDeployCommand?: boolean;
  shell?: string;
}

export interface ReleaseOutcome {
  merged: MergeCandidate[];
  version?: string;
  tag?: string;
  deployed: boolean;
  confirmed?: boolean;
  /**
   * `release.mode: integrate` — merged, versioned and tagged, with nothing to
   * deploy. Separate from `deployed` because saying a thing deployed when
   * there was no deploy is the lie this mode exists to avoid; the tickets
   * still have to be stamped, and this is what says so.
   */
  integrated?: boolean;
  /**
   * Everything merged this cycle was already present on the base branch, and
   * nothing else was unreleased. Nothing shipped because nothing needed to —
   * but the tickets are live and must still be stamped.
   */
  alreadyLive?: boolean;
  /**
   * Set when a cycle that had nothing new to release re-confirmed the LAST
   * release for tickets still `verified` (see `reconfirmLastRelease`): the
   * base of the range `planStamp` should read, since `decision.lastReleased`
   * is HEAD itself and so names nothing.
   */
  stampFrom?: string | null;
  /** Why nothing happened, when nothing did. */
  stopped?: string;
  /**
   * Verified branches that would not merge. Empty on almost every cycle.
   *
   * The release does not act on these — it has already shipped everything
   * else by the time they are known, and resolving a merge is not a thing to
   * do while holding the release lock. The caller turns them into work on the
   * board instead.
   */
  conflicts?: ConflictFailure[];
  /**
   * Verified tickets with no branch here AND no commit on the base naming
   * their key — `planMerge`'s `never-built` skip reason. Empty on almost
   * every cycle.
   *
   * Not acted on here for the same reason `conflicts` isn't: the release has
   * already shipped everything else, and this is a call for a person, not
   * something to decide while holding the release lock. The caller turns
   * this into work on the board — see stranded-verified.ts.
   */
  unbuildable?: MergeCandidate[];
  decision: ReleaseDecision;
  /**
   * Consecutive cycles `decision.block` has refused this release, from
   * `state.release(route).noteBlocked()`. Only set when a block just
   * happened — `describeRelease` uses it to escalate a persisting block
   * (ISSUE-174 made it loud in the log; this is what makes it loud beyond
   * the log too, once it has had more than one cycle to resolve itself).
   */
  blockedCycles?: number;
  /**
   * `decision.block.kind`, alongside `blockedCycles` — a stable (no file
   * names) category `describeRelease` can put in a dedupable headline.
   */
  blockKind?: ReleaseBlock['kind'];
  /**
   * `release.mode: external` only: whether each verified ticket's branch has
   * landed on the other side of the handoff, per `hooks.merged` (or the
   * heuristic fallback), and — when the repo also defines `hooks.released` —
   * whether that merge has actually shipped. The crew does not act on this
   * itself — it does not merge, version, tag or deploy an external repo,
   * that authority belongs to whatever released it — but the caller needs
   * `state`/`mergedAt` to write the same `commit_sha`/`merged_at` fields the
   * automated-merge path stamps (ISSUE-218), and `confirmed`/`version` to
   * additionally close the ticket out to `deployed` once a real release has
   * carried it (ISSUE-811), so an external ticket's record means the same
   * thing regardless of which path closed it.
   */
  externalClosures?: ExternalClosure[];
}

/**
 * One verified ticket's external-mode status: whether its branch landed
 * (`closure`), and — only once `hooks.released` has been polled — whether a
 * real release has carried that landing (`confirmed`) and, if the repo
 * versions, what version that was (`version`).
 */
export interface ExternalClosure {
  ticket: Ticket;
  closure: ClosureCheck;
  confirmed?: boolean;
  version?: string;
}

/**
 * One repo's outcome from a release phase, for the fan-out summary the CLI
 * prints once every repo on a route has run.
 *
 * `crew deploy <route>` (and `merge`/`release`) run every repo of a route
 * one after another, each through its own independent test/build/deploy
 * gate. Streamed together with no per-repo roll-up, a run where one repo's
 * tests genuinely failed (correctly skipping its deploy) and another's
 * passed and shipped read as "test failures didn't block the deploy" — they
 * did, for the repo that failed; the other repo was never gated by it. This
 * is that roll-up (ISSUE-583).
 */
export interface RepoReleaseSummary {
  scope: string;
  tests: 'pass' | 'fail' | 'skipped';
  outcome:
    | 'deployed' | 'merged' | 'integrated' | 'nothing'
    | 'build-failed' | 'deploy-failed' | 'tag-push-failed' | 'skipped' | 'error';
  detail: string;
}

/** A summary row plus the route it belongs to — what the roll-up labels its events by. */
export type RoutedReleaseSummary = RepoReleaseSummary & { route: string };

/**
 * One line per repo, emitted once every repo a fan-out touched has run.
 *
 * Only when there is more than one: a single-repo release already has its
 * own outcome in the log immediately above with nothing to disambiguate it
 * from. The ambiguity this exists to remove — a mixed pass/fail run reading
 * as "tests didn't block the deploy" — only arises once a route or `--fleet`
 * run spans more than one repo (ISSUE-583).
 *
 * One block per route, each through `emit.forRoute(...)` (CREW-994): a
 * fleet-wide run's top-level Emitter is stamped with just `routes[0]`, so
 * emitting the roll-up through it labelled every row with whichever route
 * came first in crew.yaml, even when none of the rows were about it — the
 * one release call site CREW-979 missed.
 */
export function emitReleaseSummary(emit: Emitter, summaries: RoutedReleaseSummary[]): void {
  if (summaries.length <= 1) return;
  const routes = [...new Set(summaries.map((s) => s.route))];
  for (const route of routes) {
    const rows = summaries.filter((s) => s.route === route);
    const remit = emit.forRoute(route);
    remit.enter('release');
    remit.emit(`release summary — ${rows.length} repo(s):`);
    for (const s of rows) {
      const testLabel = s.tests === 'pass' ? 'tests passed' : s.tests === 'fail' ? 'tests FAILED' : 'tests skipped';
      remit.emit(`  ${s.scope}: ${testLabel}, ${s.outcome} — ${s.detail}`, {
        level: s.outcome === 'error' || s.tests === 'fail' ? 'warn' : 'info',
      });
    }
  }
}

/**
 * Turns a completed `runRelease` outcome into one summary row.
 *
 * `hadTestHook` is whether the test gate actually ran for this repo at all
 * (a test hook configured and `--skip-tests` not passed) — several of
 * `outcome.stopped`'s reasons return before the test gate runs, so
 * "no test hook" and "returned before testing" both read as `'skipped'`
 * rather than a false `'pass'`.
 */
export function summarizeOutcome(o: ReleaseOutcome, scope: string, hadTestHook: boolean): RepoReleaseSummary {
  const tests: 'pass' | 'fail' | 'skipped' =
    o.stopped === 'tests failed' ? 'fail' : hadTestHook ? 'pass' : 'skipped';
  switch (o.stopped) {
    case 'tests failed':
      return { scope, tests, outcome: 'nothing', detail: 'test gate failed — not deployed' };
    case 'nothing to release':
    case 'nothing merged and no release marker':
    case 'already contained in the base branch':
      // Tests never ran on any of these paths — they return before the test
      // gate because there is genuinely nothing to test yet.
      return { scope, tests: 'skipped', outcome: 'nothing', detail: o.stopped };
    case 'setup failed':
      return { scope, tests: 'skipped', outcome: 'nothing', detail: 'setup failed — not tested or deployed' };
    case 'build failed':
      return { scope, tests, outcome: 'build-failed', detail: 'build failed — not deployed' };
    case 'deploy failed':
      return { scope, tests, outcome: 'deploy-failed', detail: 'deploy failed' };
    case 'tag push failed':
      return { scope, tests, outcome: 'tag-push-failed', detail: 'tag push failed' };
  }
  if (o.deployed) return { scope, tests, outcome: 'deployed', detail: `deployed${o.version ? ` ${o.version}` : ''}` };
  if (o.integrated) {
    return { scope, tests, outcome: 'integrated', detail: `merged${o.version ? ` ${o.version}` : ''}, nothing to deploy` };
  }
  return {
    scope, tests, outcome: 'merged',
    detail: `${o.merged.length} merged${o.version ? `, ${o.version}` : ''}${o.tag ? `, tagged ${o.tag}` : ''}`,
  };
}

/**
 * Whether a failed test hook's output looks like a worker crash rather than a
 * real assertion failure — a jest (or similar) worker process getting killed
 * by a signal, with no failing-test diff in the output to explain it.
 *
 * Narrow on purpose: this exists to retry a transient crash once, not to
 * paper over a real red suite. Two release cycles (2026-08-24T20:05Z and
 * 2026-08-28T05:43Z, ISSUE-490) both hit the same jest signature — a
 * different spec file each time, `signal=SIGSEGV` with no assertion diff,
 * consistent with a native-addon crash under concurrent-lane resource
 * contention — and both times the very next cycle ran clean. So a
 * crash-shaped failure with nothing else in the output is worth one retry
 * before filing a failure-alert ticket.
 */
function looksLikeWorkerCrash(output: string): boolean {
  const crashSignature = /worker process was terminated by another process|signal=SIG(SEGV|ABRT|BUS)/i;
  const assertionDiff = /(AssertionError|Expected:|Received:|✕|not ok \d)/;
  return crashSignature.test(output) && !assertionDiff.test(output);
}

/**
 * Whether a failed build/deploy hook's output looks like a bundler unable to
 * resolve an already-declared dependency, rather than a real code problem —
 * ISSUE-703: a release's `deploy` hook (`scripts/deploy-all.sh`, which builds
 * `apps/frontend` a second time, independently of `hooks.build`'s own build a
 * few seconds earlier in the same run) failed with `[vite]: Rolldown failed
 * to resolve import "react-router-dom"`, a package that was confirmed present
 * in both `package.json` and `node_modules` on that exact commit — a fresh
 * local rebuild with no code changes succeeded immediately. That signature
 * (bundler resolve failure, not a type/syntax error) means the checkout's
 * `node_modules` was transiently inconsistent at the moment this build read
 * it, not that the import is actually wrong — one retry a few seconds later
 * reads a settled `node_modules` and should succeed, same reasoning as
 * `looksLikeWorkerCrash` above.
 */
function looksLikeTransientResolveFailure(output: string): boolean {
  const resolveFailure = /Rolldown failed to resolve import|Could not resolve|\[vite\]: Failed to resolve import/i;
  const realBuildError = /(TS\d{4}:|SyntaxError|error TS|Cannot find module '\.)/;
  return resolveFailure.test(output) && !realBuildError.test(output);
}

const hook = async (o: ReleaseRunOptions, name: 'setup' | 'test' | 'build' | 'deploy' | 'bump' | 'released',
                    env: Record<string, string> = {}) => {
  const script = o.repo.hooks[name];
  if (!script) return null;
  return runScript(script, {
    cwd: o.cwd,
    env,
    shell: resolveShell(o.repo.shell ?? o.shell),
    onLine: (l) => { if (l.trim()) o.emit.emit(l.trim(), { data: { hook: name } }); },
  });
};

/**
 * `release.mode: external`'s only remaining interest: has each verified
 * ticket's branch landed on the other side of the handoff? `hooks.merged` is
 * repo-config's own validation guarantees exist whenever `external` is
 * declared (repo-config.ts), so it is always defined here — the heuristic
 * fallback inside `detectClosure` is for callers with no hook, not this one.
 *
 * A ticket with no branch here (`c.branch === null`) is skipped: it is either
 * already accounted for (`already-merged`) or has never been built
 * (`never-built`), and stranded-verified.ts is what handles that, the same as
 * every other release mode — closure detection needs a branch name to ask
 * the hook about.
 */
async function detectExternalClosures(
  o: ReleaseRunOptions, candidates: MergeCandidate[],
): Promise<ExternalClosure[]> {
  const script = o.repo.hooks.merged;
  const mergedHook = script
    ? async (env: Record<string, string>) => (await runScript(script, {
        cwd: o.cwd,
        env,
        shell: resolveShell(o.repo.shell ?? o.shell),
        onLine: (l) => { if (l.trim()) o.emit.emit(l.trim(), { data: { hook: 'merged' } }); },
      })).code
    : undefined;

  const out: ExternalClosure[] = [];
  for (const c of candidates) {
    if (!c.branch) continue;
    const closure = await detectClosure({
      cwd: o.cwd, key: c.ticket.issue_id, aliases: referenceKeys(c.ticket).slice(1), pushedBranch: c.branch,
      remote: o.repo.branch.remote, base: o.repo.branch.base, mergedHook,
    });
    o.emit.emit(closure.detail, { ticket: c.ticket.issue_id, data: { confidence: closure.confidence } });
    out.push({ ticket: c.ticket, closure });
  }
  return out;
}

/**
 * `release.mode: external`'s optional second question, only asked when the
 * repo also defines `hooks.released`: has a real release actually carried
 * each landed merge? `detectExternalClosures` above only knows the merge
 * happened — a separate CI pipeline (Buildkite, say) builds and deploys off
 * it independently, and until now nothing captured whether that pipeline
 * ever ran, let alone passed.
 *
 * Polls `hooks.released` once for a live commit, reusing `release.verify`'s
 * timeout/interval the same way `confirm()` does for the non-external
 * modes — then matches every landed closure against that ONE live commit by
 * ancestry (`isAncestor`, git.ts), not equality: a batched CI build on the
 * base branch commonly reports a commit later than any individual ticket's
 * own merge, so exact-prefix equality (right for `ci_auto`/`ci_manual`,
 * where the crew controls exactly what it pushed) would false-negative on
 * every ticket but the very last one folded into that build.
 *
 * A closure that never reached `state: 'merged'` (still open, or abandoned)
 * has nothing to confirm and passes through unchanged. `hooks.released`
 * returning nothing before the deadline is the same "unconfirmed, not
 * failed" outcome `confirm()` reports — the tracker is left exactly as
 * `detectExternalClosures` found it, to be asked again next cycle.
 */
async function confirmExternalReleased(
  o: ReleaseRunOptions, closures: ExternalClosure[],
): Promise<ExternalClosure[]> {
  if (!o.repo.hooks.released) return closures;
  const landed = closures.filter((c) => c.closure.state === 'merged' && c.closure.mergedAt);
  if (!landed.length) return closures;

  if (o.dryRun) {
    o.emit.emit(`would poll the released hook to confirm ${landed.length} landed ticket(s) actually shipped`);
    return closures;
  }

  const { timeoutSeconds, intervalSeconds } = o.repo.release.verify;
  const deadline = Date.now() + timeoutSeconds * 1000;
  let live = '';
  for (;;) {
    const r = await hook(o, 'released');
    live = r?.output.trim().split('\n').filter(Boolean).pop() ?? '';
    if (live) break;
    if (Date.now() >= deadline) {
      o.emit.warn(`not confirmed within ${timeoutSeconds}s — the released hook reported nothing`);
      return closures;
    }
    await new Promise((res) => setTimeout(res, intervalSeconds * 1000));
  }

  return closures.map((c) => {
    if (c.closure.state !== 'merged' || !c.closure.mergedAt) return c;
    const confirmed = isAncestor(o.cwd, c.closure.mergedAt, live);
    if (!confirmed) {
      o.emit.emit(`not yet carried by ${live.slice(0, 12)}`, { ticket: c.ticket.issue_id });
      return { ...c, confirmed };
    }
    const version = o.repo.release.versioning === 'none' || !o.repo.release.versionFiles[0]
      ? undefined
      : (() => {
          const content = fileAtRef(o.cwd, live, o.repo.release.versionFiles[0]!);
          if (!content) return undefined;
          try { return (JSON.parse(content) as { version?: string }).version; } catch { return undefined; }
        })();
    o.emit.emit(`confirmed shipped in ${live.slice(0, 12)}`, { ticket: c.ticket.issue_id, data: { version } });
    return { ...c, confirmed, version };
  });
}

/**
 * Squash-merges one verified branch.
 *
 * Squash rather than merge because the branch's own history is an agent's
 * working record — dozens of commits of trial and correction — and what
 * belongs on the integration branch is the change, once, with a message a
 * human wrote for the changelog.
 */
/**
 * `applied` wrote a commit (and names its sha); `noop` merged a branch whose
 * change was already present; `conflict` failed. The caller needs the
 * distinction: a cycle in which every merge was a no-op has nothing to
 * release, however many branches it merged.
 */
type MergeResult = { applied: true; sha?: string } | 'noop' | { conflict: ConflictFailure };

/**
 * A branch that would not merge, and what it disagreed about.
 *
 * Carried out of the release rather than merely logged: a conflict that only
 * reaches a log line is retried identically every cycle forever, which is
 * exactly what ISSUE-346 did six times in an hour. The caller turns this into
 * work on the board — see conflict.ts.
 */
export interface ConflictFailure {
  candidate: MergeCandidate;
  /** Paths git could not merge, read before the checkout was rewound. */
  paths: string[];
  message: string;
}

function mergeOne(o: ReleaseRunOptions, c: MergeCandidate): MergeResult {
  const subject = c.entries[0] ?? `${c.ticket.title ?? c.ticket.issue_id} (${c.ticket.issue_id})`;
  if (o.dryRun) {
    o.emit.emit(`would squash-merge ${c.branch} — "${subject}"`, { ticket: c.ticket.issue_id });
    return { applied: true };
  }
  // Where to rewind to if this branch does not apply cleanly. A squash merge
  // never writes MERGE_HEAD, so `git merge --abort` cannot undo one — it fails
  // with "no merge to abort", and when that failure came from inside the catch
  // block it replaced the real error and killed the whole cycle.
  const before = headSha(o.cwd);
  try {
    git(o.cwd, ['merge', '--squash', c.branch!]);

    // A verified branch can stage nothing: its change is already on the
    // integration branch, because another ticket's fix covered it or it was
    // cherry-picked. That is a MERGED branch with nothing to apply, not a
    // failure — and treating it as one is what stalled the whole release,
    // since `git commit` refuses an empty index and the error propagated.
    if (!git(o.cwd, ['diff', '--cached', '--name-only'])) {
      git(o.cwd, ['reset', '--hard', before]);   // drop SQUASH_MSG and the empty index
      o.emit.emit(
        `${c.branch} is already contained in the integration branch — nothing to apply`,
        { ticket: c.ticket.issue_id },
      );
      return 'noop';
    }

    // The ticket key goes in the SUBJECT deliberately: it is the only durable
    // link once a forge squashes this again, and closure detection reads it.
    git(o.cwd, ['commit', '-m', `${subject}\n\nCloses ${c.ticket.issue_id}.`]);
    const sha = headSha(o.cwd);
    o.emit.emit(`merged ${c.branch}`, { ticket: c.ticket.issue_id });
    return { applied: true, sha };
  } catch (e) {
    // WHAT disagreed, read while the failed merge is still in the index —
    // after the rewind below there is nothing left to ask. This is the only
    // moment the information exists.
    const paths = (gitOk(o.cwd, ['diff', '--name-only', '--diff-filter=U']) ?? '')
      .split('\n').filter(Boolean);

    // Rewind to exactly where this branch started and stop touching it: a
    // half-applied squash is not something to paper over, and leaving conflict
    // markers staged would poison every later candidate in this run.
    //
    // Best-effort on purpose. If the rewind itself fails there is nothing
    // useful left to do about it here, and the ORIGINAL error is the one worth
    // reporting — the release phase reads this return value and stops.
    gitOk(o.cwd, ['reset', '--hard', before]);
    o.emit.error(`could not merge ${c.branch}: ${(e as Error).message}`, { ticket: c.ticket.issue_id });
    return { conflict: { candidate: c, paths, message: (e as Error).message } };
  }
}

/** The new version, from the repo's own bump hook or from `versionFiles`. */
async function bump(o: ReleaseRunOptions, size: string): Promise<string | null> {
  if (o.repo.release.versioning === 'none') return null;

  if (o.repo.hooks.bump) {
    if (o.dryRun) {
      // The hook owns the version and only running it would reveal it — and
      // running it writes files. So a dry run reports the input, not a made-up
      // output; anything else would print a version that will not be the one.
      o.emit.emit(`would run the bump hook with CREW_BUMP=${size} — it decides the version`);
      return null;
    }
    const r = await hook(o, 'bump', { CREW_BUMP: size });
    if (!r || r.code !== 0) {
      o.emit.error(`bump hook failed (exit ${r?.code})`);
      return null;
    }
    // The hook prints the version it produced, and the crew uses THAT rather
    // than recomputing — a calendar version or build counter is then correct
    // by construction instead of a disagreement.
    const printed = r.output.trim().split('\n').filter(Boolean).pop() ?? '';
    if (!printed) { o.emit.error('bump hook printed no version'); return null; }
    return printed;
  }

  // The built-in path: npm-shaped, and documented as such.
  const files = o.repo.release.versionFiles.map((f) => join(o.cwd, f));
  const first = files[0]!;
  if (!existsSync(first)) { o.emit.error(`no ${o.repo.release.versionFiles[0]} to read a version from`); return null; }
  const current = (JSON.parse(readFileSync(first, 'utf8')) as { version?: string }).version;
  if (!current) { o.emit.error(`no version field in ${o.repo.release.versionFiles[0]}`); return null; }
  const [maj, min, pat] = current.split('.').map(Number) as [number, number, number];
  const next = size === 'major' ? [maj + 1, 0, 0] : size === 'minor' ? [maj, min + 1, 0] : [maj, min, pat + 1];
  const version = next.join('.');
  if (o.dryRun) { o.emit.emit(`would bump ${current} -> ${version} in ${files.length} file(s)`); return version; }
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const out = src.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
    if (out === src) { o.emit.error(`no version field in ${f}`); return null; }
    writeFileSync(f, out);
  }
  return version;
}

function writeChangelog(o: ReleaseRunOptions, version: string, entries: string[]): void {
  const file = o.repo.release.changelog;
  if (!file || entries.length === 0) return;
  const path = join(o.cwd, file);
  const section = renderChangelogSection(version, new Date().toISOString().slice(0, 10), entries);
  if (o.dryRun) {
    o.emit.emit(`would prepend ${entries.length} entr(ies) to ${file}`);
    return;
  }
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '# Changelog\n';
  writeFileSync(path, insertChangelogSection(existing, section));
}

/**
 * Ask the target what it is actually running, rather than assuming the deploy
 * landed — a restarted-but-stale service is exactly the failure this catches.
 * Unconfirmed is NOT failed: the deploy may simply be slower than the window.
 */
async function confirm(o: ReleaseRunOptions, expected: string): Promise<boolean | undefined> {
  if (!o.repo.hooks.released) return undefined;
  const { timeoutSeconds, intervalSeconds, match } = o.repo.release.verify;
  if (o.dryRun) {
    o.emit.emit(`would poll the released hook for ${match}=${expected.slice(0, 8)} (up to ${timeoutSeconds}s)`);
    return undefined;
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const r = await hook(o, 'released');
    const live = r?.output.trim().split('\n').filter(Boolean).pop() ?? '';
    const hit = match === 'commit' ? live.startsWith(expected.slice(0, 7)) || expected.startsWith(live.slice(0, 7)) : live === expected;
    if (live && hit) { o.emit.emit(`confirmed live: ${live.slice(0, 12)}`); return true; }
    if (Date.now() >= deadline) {
      o.emit.warn(`not confirmed within ${timeoutSeconds}s — target reports ${live || 'nothing'}`);
      return false;
    }
    await new Promise((r2) => setTimeout(r2, intervalSeconds * 1000));
  }
}


/**
 * Take what the remote has before deciding anything.
 *
 * With one ship this is housekeeping. With SEVERAL it is the difference
 * between releasing and corrupting a release: ships share nothing but the
 * remote and the board, so another ship's merges exist only as commits on
 * `origin/<base>` until this one fetches them. Releasing without doing so
 * versions a base that is already behind, cuts a tag that omits shipped work,
 * and produces a push the remote will reject.
 *
 * `crew sync` has always been able to do this, but nothing in a cycle called
 * it — drift was unbounded until an operator typed it by hand.
 *
 * Three outcomes, and the third is why this returns anything:
 *   - no remote, or a base that tracks none: nothing to take, carry on. Three
 *     of the repos on this ship are exactly that, and it is not a fault.
 *   - behind: fast-forward, and release from what everyone else has.
 *   - DIVERGED: stop. Local commits the remote has not got AND remote commits
 *     this ship has not got means two ships have both written to the base.
 *     Fast-forwarding is impossible and merging would be this crew inventing a
 *     resolution nobody asked for, on the branch everything ships from.
 */
function refreshBase(o: ReleaseRunOptions): { ok: true } | { ok: false; why: string } {
  // The actual fetch-and-compare is `refreshBaseBranch` (git.ts), shared with
  // `crew sync`'s equivalent check before an agent cuts a new ticket's
  // worktree — this wrapper only adds the emitting and blocking this call
  // site wants around it.
  const r = refreshBaseBranch(o.cwd, o.repo.branch.remote, o.repo.branch.base, o.dryRun);
  switch (r.action) {
    // "Nothing to take, carry on": not on a clean base, no remote configured,
    // the remote has no base branch at all (three repos on this ship,
    // legitimately), or already level. None of these are a fault — warning
    // about them every cycle would train an operator to ignore the warning,
    // which is worse than not having one for the cycle a REAL fetch failure
    // (network, auth) needs it.
    case 'not-applicable':
    case 'level':
      return { ok: true };
    case 'fetch-failed':
      o.emit.warn(`${r.detail} — releasing from what this ship already has`);
      return { ok: true };
    case 'would-fast-forward':
    case 'fast-forwarded':
      o.emit.emit(r.detail);
      return { ok: true };
    // DIVERGED: stop. Local commits the remote has not got AND remote
    // commits this ship has not got means two ships have both written to the
    // base. Fast-forwarding is impossible and merging would be this crew
    // inventing a resolution nobody asked for, on the branch everything
    // ships from.
    case 'diverged':
    case 'ff-failed':
      return { ok: false, why: r.detail };
  }
}

/**
 * In ci_* modes the tickets are only stamped once `confirm()` sees the release
 * live. If that timed out (CI slower than `verify.timeoutSeconds`), the next
 * cycle sees `upToDate` and used to stop at "nothing to release", leaving the
 * batch `verified` until some unrelated ticket forced another release.
 *
 * So when up to date, look at whether any still-`verified` ticket is named in
 * the last release's own range; if so, confirm that release again and let the
 * caller stamp. No such ticket means no polling, so an idle repo costs nothing.
 */
async function reconfirmLastRelease(
  o: ReleaseRunOptions, decision: ReleaseDecision,
): Promise<{ confirmed: boolean; version: string; from: string } | undefined> {
  if (!canReconfirm(o, decision)) return undefined;
  const prevTag = latestReleaseTag(o.cwd, o.repo.release.tagPattern ?? 'v*', `${decision.lastTag}^`);
  const from = prevTag ? tagCommit(o.cwd, prevTag) : null;
  if (!from) return undefined;
  const pending = planStamp(o.cwd, o.tickets, o.contract, from, decision.lastReleased!);
  if (pending.length === 0) return undefined;
  o.emit.emit(
    `${pending.length} verified ticket(s) were in ${decision.lastTag} but never confirmed live — re-checking`,
  );
  return { ...(await confirmLastRelease(o, decision)), from };
}

const canReconfirm = (o: ReleaseRunOptions, decision: ReleaseDecision): boolean =>
  !o.dryRun && (o.repo.release.mode === 'ci_manual' || o.repo.release.mode === 'ci_auto') &&
  !!o.repo.hooks.released && !!decision.lastTag && !!decision.lastReleased;

async function confirmLastRelease(
  o: ReleaseRunOptions, decision: ReleaseDecision,
): Promise<{ confirmed: boolean; version: string }> {
  const version = decision.lastTag!.replace(/^v/, '');
  const expected = o.repo.release.verify.match === 'version' ? version : decision.lastReleased!;
  const confirmed = (await confirm(o, expected)) === true;
  if (!confirmed) o.emit.warn(`${decision.lastTag} is still not confirmed live — tickets stay verified`);
  return { confirmed, version };
}

export async function runRelease(o: ReleaseRunOptions): Promise<ReleaseOutcome> {
  const scoped = (msg: string) => (o.scope ? `${o.scope}: ${msg}` : msg);
  const tagPattern = o.repo.release.tagPattern ?? 'v*';

  // Before anything is decided: what does the remote have? Every number the
  // decision below rests on — the last tag, the head, what is unreleased — is
  // wrong if another ship has pushed since this one last looked.
  o.emit.enter('release');
  const fresh = refreshBase(o);

  const decision = decideRelease(o.cwd, o.tickets, o.contract, {
    tagPattern, base: o.repo.branch.base,
    branchFor: (t) => existingBranchForTicket(o.cwd, o.repo, t),
  });

  if (!fresh.ok) {
    // Deliberately not `--force`-able: `crew deploy` exists to retry a deploy
    // that failed, not to release over another ship's work.
    o.emit.error(scoped(`refusing to release — ${fresh.why}; a person has to reconcile the two`));
    return { merged: [], conflicts: [], deployed: false, stopped: fresh.why, decision };
  }

  if (decision.block) {
    // Refusing is correct; refusing SILENTLY is what let eight commits sit
    // unreleased behind one untracked file (ISSUE-174). One blocked cycle is
    // normal — someone is mid-edit — so the alarm starts at two.
    const n = o.state?.noteBlocked() ?? 1;
    const msg = scoped(`refusing to release — ${decision.block.detail}`);
    // `cycles`/`reason` go out on both branches, not only the LOUD one: a
    // watcher folding this cycle's events needs to tell "release blocked
    // since cycle 1" from "release in progress" from its very first cycle,
    // not only once the alarm escalates at two (ISSUE-399).
    const data = { cycles: n, reason: decision.block.detail };
    if (n >= 2) o.emit.error(`${msg} (blocked ${n} cycles running)`, { data });
    else o.emit.warn(msg, { data });
    return {
      merged: [], deployed: false, stopped: decision.block.detail, decision,
      blockedCycles: n, blockKind: decision.block.kind,
    };
  }
  o.state?.clearBlocked();

  // A commit a deploy already failed on is not retried until something
  // changes. Otherwise a broken deploy repeats every cycle forever, and the
  // original failure is buried under identical ones.
  const failedAt = o.state?.deployFailedSha();
  if (!o.force && failedAt && failedAt === decision.head) {
    o.emit.warn(
      `a deploy already failed on ${failedAt.slice(0, 8)} — not retrying until a new commit lands ` +
        '(force it with `crew deploy`)',
    );
    return { merged: [], deployed: false, stopped: 'previous deploy failed on this commit', decision };
  }

  // `external` means the crew is not the thing that releases. It must not
  // merge, version, changelog, tag or deploy — doing any of them would fight
  // whatever does.
  if (o.repo.release.mode === 'external') {
    o.emit.emit('release.mode is external — the crew hands work off and does not release');
    const landed = await detectExternalClosures(o, decision.merges);
    const externalClosures = await confirmExternalReleased(o, landed);
    return { merged: [], deployed: false, stopped: 'external', decision, externalClosures };
  }

  o.emit.enter('merge');
  const merged: MergeCandidate[] = [];
  const conflicts: ConflictFailure[] = [];
  // `never-built` candidates: no branch here, and the key names no commit on
  // the base either. Carried out rather than only logged, same reasoning as
  // `conflicts` — reported once per cycle forever otherwise (ISSUE-379). The
  // caller turns this into work on the board; see stranded-verified.ts.
  const unbuildable: MergeCandidate[] = [];
  let applied = 0;
  for (const c of decision.merges) {
    if (!c.branch || c.mergedSha) {
      if (c.skipReason === 'already-merged') {
        o.emit.emit(
          `verified and already merged${c.mergedSha ? ` (on the base as ${c.mergedSha.slice(0, 7)})` : ''}, waiting on a successful release`,
          { ticket: c.ticket.issue_id },
        );
      } else {
        o.emit.emit('verified but has no branch and nothing on the base names it — nothing to merge', { ticket: c.ticket.issue_id });
        unbuildable.push(c);
      }
      continue;
    }
    const r = mergeOne(o, c);
    if (typeof r === 'object' && 'conflict' in r) { conflicts.push(r.conflict); continue; }
    if (typeof r === 'object' && r.applied) {
      applied++;
      c.sha = r.sha;
    }
    merged.push(c);
  }

  if (o.mergeOnly) {
    o.emit.emit(`merge only: ${merged.length} branch(es) merged, not releasing`);
    return { merged, conflicts, unbuildable, deployed: false, stopped: 'merge only', decision };
  }

  o.emit.enter('release');
  const head = o.dryRun ? decision.head : headSha(o.cwd);
  if (merged.length === 0 && decision.upToDate && !o.force) {
    const re = await reconfirmLastRelease(o, decision);
    if (re) {
      return {
        merged, conflicts, unbuildable, deployed: false, version: re.version, confirmed: re.confirmed || undefined,
        stampFrom: re.from, stopped: 'nothing to release', decision,
      };
    }
    o.emit.emit('nothing to release');
    return { merged, conflicts, unbuildable, deployed: false, stopped: 'nothing to release', decision };
  }

  // Nothing merged, and no tag to measure against.
  //
  // `upToDate` is `lastReleased === head`, so a repo that has never been
  // tagged reports "not up to date" forever — there is no marker saying what
  // shipped. That is indistinguishable from genuinely-unshipped work, and the
  // release proceeded on it: an untagged repo with `versioning: none` ran its
  // full test suite and build on EVERY cycle, every two minutes, merging
  // nothing and stamping nothing. The test gate exists to protect a release;
  // with nothing merged and no marker, there is no release to protect.
  //
  // A repo that will legitimately never tag (`versioning: none`) therefore
  // releases exactly when something merges, which is the only moment it can
  // have anything to do.
  if (merged.length === 0 && decision.unseeded && !o.force) {
    o.emit.emit(
      `nothing merged, and ${o.repo.branch.base} carries no release tag to compare against — ` +
        'nothing to release',
    );
    return { merged, conflicts, unbuildable, deployed: false, stopped: 'nothing merged and no release marker', decision };
  }

  // Branches were merged, but none of them wrote a commit and nothing else was
  // waiting: every one was already contained in the base. There is nothing to
  // version, build, deploy or tag — the work is live already, under whatever
  // release carried it.
  //
  // Their tickets DO still have to be stamped, which is why this returns
  // `alreadyLive` rather than simply stopping. Cutting a version whose entire
  // diff is its own version bump, purely to have something to stamp against,
  // is what produced two empty releases (ISSUE-342).
  if (applied === 0 && merged.length > 0 && decision.upToDate && !o.force) {
    // The branches survive until the stamp, so a ci_* release whose confirm
    // timed out comes back through here rather than the case above. Their work
    // is in the last tag but not necessarily live yet: confirm before stamping.
    if (canReconfirm(o, decision)) {
      const re = await confirmLastRelease(o, decision);
      if (!re.confirmed) {
        return { merged, conflicts, unbuildable, deployed: false, stopped: 'release not yet confirmed live', decision };
      }
    }
    o.emit.emit(
      `nothing to release — ${merged.length} branch(es) were already contained in ` +
        `${o.repo.branch.base}; stamping without cutting a version`,
    );
    return {
      merged, conflicts, unbuildable, deployed: false, alreadyLive: true,
      version: decision.lastTag?.replace(/^v/, ''),
      stopped: 'already contained in the base branch', decision,
    };
  }
  if (merged.length === 0 && decision.upToDate && o.force) {
    o.emit.emit('forced: nothing new merged and nothing unreleased, releasing anyway');
  }

  const nothingToDeploy = o.repo.release.mode === 'integrate' && !o.repo.hooks.deploy;
  if (o.isDeployCommand && nothingToDeploy) {
    o.emit.emit(
      `${hookLabel(o.repo, 'test')} skipped — release.mode is integrate with no deploy hook, ` +
        `so this "crew deploy" run has nothing to ship`,
    );
  }

  // The release checkout is the operator's primary checkout, which nobody
  // installed dependencies into unless they happened to do it by hand — a
  // freshly added repo has no node_modules, so every test-gate file died with
  // ERR_MODULE_NOT_FOUND and the release looked like a test failure forever
  // (CREW-1323). Run the repo's own setup hook (same command a ticket worktree
  // gets) before anything that needs the toolchain. A failure here stops the
  // release as `setup failed` rather than masquerading as a failed test gate.
  const gatesNeedSetup = (!o.skipTests && o.repo.hooks.test && !(o.isDeployCommand && nothingToDeploy)) ||
    o.repo.hooks.build;
  if (o.repo.hooks.setup && gatesNeedSetup) {
    if (o.dryRun) o.emit.emit(`would run setup: ${hookLabel(o.repo, 'setup')}`);
    else {
      const r = await hook(o, 'setup');
      if (r && r.code !== 0) {
        o.emit.error(`setup FAILED (exit ${r.code}) — not testing or deploying; the target stays on the previous release`);
        return { merged, conflicts, unbuildable, deployed: false, stopped: 'setup failed', decision };
      }
    }
  }

  if (!(o.isDeployCommand && nothingToDeploy) && !o.skipTests && o.repo.hooks.test) {
    if (o.dryRun) o.emit.emit(`would run the test gate: ${hookLabel(o.repo, 'test')}`);
    else {
      let r = await hook(o, 'test');
      if (r && r.code !== 0 && looksLikeWorkerCrash(r.output)) {
        o.emit.warn('test gate failed with what looks like a worker crash, not a real failure — retrying once');
        r = await hook(o, 'test');
      }
      if (r && r.code !== 0) {
        o.emit.error(`test gate FAILED — not deploying; the target stays on the previous release`);
        return { merged, conflicts, unbuildable, deployed: false, stopped: 'tests failed', decision };
      }
    }
  }

  // Read off the BRANCHES, before the squash flattened them — not out of the
  // merged history, where the crew's own commit subject has replaced them.
  const size: 'major' | 'minor' | 'patch' =
    merged.some((m) => m.bump === 'minor') ? 'minor' : 'patch';
  const majorRequested = merged.some((m) => m.majorRequested);
  if (majorRequested) {
    o.emit.warn('a branch asked for a MAJOR bump — honoured as minor; major is the operator\'s call');
  }
  // Where `base` stood before the Release commit, so a failed build can
  // take that commit back (CREW-1326).
  const preBump = headSha(o.cwd);
  const version = (await bump(o, size)) ?? undefined;
  if (!version && o.dryRun && o.repo.hooks.bump) {
    o.emit.emit('would then commit the version bump and changelog');
  } else if (version) {
    writeChangelog(o, version, merged.flatMap((m) => m.entries));
    if (!o.dryRun) {
      git(o.cwd, ['add', '-A']);
      git(o.cwd, ['commit', '-m', `Release ${o.repo.release.tag ? renderTag(o.repo.release.tag, version) : version}`]);
    } else {
      o.emit.emit(`would commit the version bump and changelog`);
    }
  }

  if (o.repo.hooks.build) {
    if (o.dryRun) o.emit.emit(`would run: ${hookLabel(o.repo, 'build')}`);
    else {
      let r = await hook(o, 'build');
      if (r && r.code !== 0 && looksLikeTransientResolveFailure(r.output)) {
        o.emit.warn('build failed with what looks like a transient dependency-resolution glitch, not a real failure — retrying once');
        r = await hook(o, 'build');
      }
      if (r && r.code !== 0) {
        o.emit.error('build failed — not deploying');
        // The Release commit must not outlive the release it describes: left
        // in place, every failed cycle stacked another bump on the base
        // branch and the eventual real release skipped version numbers. The
        // merge commits stay (they are verified work); only the bump goes.
        if (version && !o.dryRun && headSha(o.cwd) !== preBump) {
          git(o.cwd, ['reset', '--hard', preBump]);
          o.emit.warn(`dropped the unreleased version commit for ${version} (reset ${o.repo.branch.base} to ${preBump.slice(0, 8)}) so a retry starts clean`);
        }
        return { merged, conflicts, unbuildable, version, deployed: false, stopped: 'build failed', decision };
      }
    }
  }

  let deployed = false;
  let integrated = false;
  if (o.repo.release.mode === 'integrate') {
    // Merging to the base branch WAS the release. Nothing to deploy, so
    // nothing to fail and nothing to verify — but the tickets are live and
    // must be stamped, which is what `integrated` carries.
    o.emit.emit('release.mode is integrate — merged and versioned; there is nothing to deploy');
    integrated = true;
  } else if (o.repo.release.mode === 'local' && o.repo.hooks.deploy) {
    if (o.dryRun) o.emit.emit(`would run: ${hookLabel(o.repo, 'deploy')}`);
    else {
      let r = await hook(o, 'deploy');
      if (r && r.code !== 0 && looksLikeTransientResolveFailure(r.output)) {
        o.emit.warn('deploy failed with what looks like a transient dependency-resolution glitch, not a real failure — retrying once');
        r = await hook(o, 'deploy');
      }
      if (r && r.code !== 0) {
        o.emit.error(`deploy FAILED (exit ${r.code}) — the target may be partially deployed`);
        o.state?.noteDeployFailed(headSha(o.cwd));
        return { merged, conflicts, unbuildable, version, deployed: false, stopped: 'deploy failed', decision };
      }
      deployed = true;
      o.state?.clearDeployFailed();
    }
  } else if (o.repo.release.mode !== 'local') {
    o.emit.emit(`release.mode is ${o.repo.release.mode} — CI takes it from here`);
  }

  // Keep the remote in sync with what actually landed on the base. Merging a
  // verified branch onto `base` (above) has always been local-only — nothing
  // pushed it, so a repo whose release.mode never pushes anything else
  // (local, integrate) left every merge stranded on this one ship's disk,
  // and even ci_manual/ci_auto only pushed the release TAG, whose objects
  // reach the remote without moving `<remote>/<base>` itself. A repo with no
  // remote configured (three on this ship) is never asked to push and this
  // is never an error for them. Same treatment as the deploy hook and the
  // tag push below: the merge and version-bump commits already landed
  // locally, so a failed push is a failed release, not a warning.
  if (remoteConfigured(o.cwd, o.repo.branch.remote)) {
    if (o.dryRun) {
      o.emit.emit(`would push ${o.repo.branch.base} to ${o.repo.branch.remote}`);
    } else {
      try {
        pushBranch(o.cwd, o.repo.branch.remote, o.repo.branch.base);
        o.emit.emit(`pushed ${o.repo.branch.base} to ${o.repo.branch.remote}`);
      } catch (e) {
        o.emit.error(
          `failed to push ${o.repo.branch.base} to ${o.repo.branch.remote} — ${(e as GitError).message}`,
        );
        return {
          merged, conflicts, unbuildable, version, deployed, integrated, decision,
          stopped: 'base branch push failed',
        };
      }
    }
  }

  // Tag AFTER a successful deploy, never before: a tag is the record that
  // this version shipped, and tagging a failed release would make the next
  // cycle believe it already had.
  let tag: string | undefined;
  if (!version && o.dryRun && o.repo.hooks.bump && o.repo.release.tag) {
    o.emit.emit(`would then tag using ${o.repo.release.tag}, with whatever version the hook printed`);
  } else if (version && o.repo.release.tag) {
    tag = renderTag(o.repo.release.tag, version);
    const at = o.dryRun ? head : headSha(o.cwd);
    if (o.dryRun) o.emit.emit(`would tag ${tag} at ${at.slice(0, 8)}`);
    else if (tagExists(o.cwd, tag)) o.emit.warn(`tag ${tag} already exists — not retagging`);
    else { createReleaseTag(o.cwd, tag, at, `Release ${tag}`); o.emit.emit(`tagged ${tag}`); }
  }

  // For ci_manual/ci_auto the tag push IS the CI trigger, so it has to
  // happen AFTER the version commit but BEFORE the verify wait below starts
  // — otherwise `confirm` polls the whole timeout for a release nobody
  // asked CI to start. local/integrate/external never reach here with a
  // release.mode that pushes, so a repo with no remote configured (three on
  // this ship) is never asked to push and this is never an error for them.
  //
  // This is the first thing in the release phase that reaches the outside
  // world, so it gets the same treatment as the deploy hook: a failed push
  // is a failed release, not a warning — the version commit already landed
  // on the base branch, and something has to say the release did not
  // actually happen.
  if (tag && (o.repo.release.mode === 'ci_manual' || o.repo.release.mode === 'ci_auto')) {
    if (o.dryRun) {
      o.emit.emit(`would push tag ${tag} to ${o.repo.branch.remote}`);
    } else {
      try {
        pushTag(o.cwd, o.repo.branch.remote, tag);
        o.emit.emit(`pushed tag ${tag} to ${o.repo.branch.remote}`);
      } catch (e) {
        o.emit.error(`failed to push tag ${tag} to ${o.repo.branch.remote} — ${(e as GitError).message}`);
        return { merged, conflicts, unbuildable, version, tag, deployed, integrated, decision, stopped: 'tag push failed' };
      }
    }
  }

  // `match: version` compares against what the released hook prints, which is
  // a version (e.g. `npm view <pkg> version`) — never the HEAD sha. Handing it
  // the sha made every ci_* release time out.
  const expected = o.repo.release.verify.match === 'version' && version ? version : o.dryRun ? head : headSha(o.cwd);
  const confirmed = await confirm(o, expected);
  o.emit.emit(
    `release ${o.dryRun ? 'plan complete' : 'complete'}: ${merged.length} merged` +
      `${version ? `, ${version}` : ''}${tag ? `, tagged ${tag}` : ''}`,
    { data: { merged: merged.length, version, tag, deployed, integrated, confirmed } },
  );
  return { merged, conflicts, unbuildable, version, tag, deployed, integrated, confirmed, decision };
}

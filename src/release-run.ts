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
  createReleaseTag, currentBranch, fetchRemote, git, gitOk, GitError, headSha,
  pushTag, remoteBranchExists, status, tagExists,
} from './git.ts';
import {
  decideRelease, insertChangelogSection, renderChangelogSection, renderTag,
  type MergeCandidate, type ReleaseDecision,
} from './release.ts';
import type { EffectiveRepoConfig } from './repo-config.ts';
import { hookLabel } from './repo-config.ts';
import { runScript, resolveShell } from './shell.ts';
import type { Emitter } from './events.ts';
import type { Ticket } from './tracker.ts';
import type { Contract } from './contract.ts';

export interface ReleaseRunOptions {
  /**
   * Remembers a failed deploy and counts consecutive refusals, for THIS
   * connection — `State#release(name)`. Scoped, because a ship releases each
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
  decision: ReleaseDecision;
}

const hook = async (o: ReleaseRunOptions, name: 'test' | 'build' | 'deploy' | 'bump' | 'released',
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
 * Squash-merges one verified branch.
 *
 * Squash rather than merge because the branch's own history is an agent's
 * working record — dozens of commits of trial and correction — and what
 * belongs on the integration branch is the change, once, with a message a
 * human wrote for the changelog.
 */
/**
 * `applied` wrote a commit; `noop` merged a branch whose change was already
 * present; `false` failed. The caller needs the distinction: a cycle in which
 * every merge was a no-op has nothing to release, however many branches it
 * merged.
 */
type MergeResult = 'applied' | 'noop' | { conflict: ConflictFailure };

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
    return 'applied';
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
    o.emit.emit(`merged ${c.branch}`, { ticket: c.ticket.issue_id });
    return 'applied';
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
  const base = o.repo.branch.base;
  const remote = o.repo.branch.remote;

  // Only from a clean checkout sitting on the base. Neither is this
  // function's job to report — `checkGuards` says it better a moment later —
  // but fast-forwarding from anywhere else would move the wrong branch.
  if (currentBranch(o.cwd) !== base || status(o.cwd).length > 0) return { ok: true };

  // A fetch touches only remote-tracking refs, so it runs in a dry run too:
  // without it a dry run would report drift that is merely unobserved, which
  // is worse than useless. Nothing that moves a local branch runs below.
  if (!fetchRemote(o.cwd, remote)) {
    o.emit.warn(`could not fetch ${remote} — releasing from what this ship already has`);
    return { ok: true };
  }

  // Measured against `<remote>/<base>` directly rather than through a
  // configured upstream: a crew checkout is cut by an operator or a script and
  // very often tracks nothing, and `git branch -u` is not something this is
  // entitled to set on someone's repo. The remote-tracking ref is there either
  // way once the fetch above succeeded.
  const upstream = `${remote}/${base}`;
  if (!remoteBranchExists(o.cwd, remote, base)) return { ok: true };

  const counts = gitOk(o.cwd, ['rev-list', '--left-right', '--count', `${upstream}...${base}`]);
  if (!counts) return { ok: true };
  const [behindStr, aheadStr] = counts.split(/\s+/);
  const behind = Number.parseInt(behindStr ?? '0', 10);
  const ahead = Number.parseInt(aheadStr ?? '0', 10);

  if (ahead > 0 && behind > 0) {
    return { ok: false, why: `${base} has diverged from ${upstream} (${ahead} ahead, ${behind} behind)` };
  }
  // Ahead only is the normal state of a ship between releases: it has merged
  // work the remote has not seen, and the release is what pushes it.
  if (behind === 0) return { ok: true };

  if (o.dryRun) {
    o.emit.emit(`would fast-forward ${base}: ${behind} behind ${upstream}`);
    return { ok: true };
  }
  if (gitOk(o.cwd, ['merge', '--ff-only', upstream]) === null) {
    return { ok: false, why: `${base} is ${behind} behind ${upstream} and would not fast-forward` };
  }
  o.emit.emit(`fast-forwarded ${base} to ${upstream} (${behind} commit(s) from elsewhere)`);
  return { ok: true };
}

export async function runRelease(o: ReleaseRunOptions): Promise<ReleaseOutcome> {
  const tagPattern = o.repo.release.tagPattern ?? 'v*';

  // Before anything is decided: what does the remote have? Every number the
  // decision below rests on — the last tag, the head, what is unreleased — is
  // wrong if another ship has pushed since this one last looked.
  o.emit.enter('release');
  const fresh = refreshBase(o);

  const decision = decideRelease(o.cwd, o.tickets, o.contract, {
    tagPattern, base: o.repo.branch.base,
  });

  if (!fresh.ok) {
    // Deliberately not `--force`-able: `crew deploy` exists to retry a deploy
    // that failed, not to release over another ship's work.
    o.emit.error(`refusing to release — ${fresh.why}; a person has to reconcile the two`);
    return { merged: [], conflicts: [], deployed: false, stopped: fresh.why, decision };
  }

  if (decision.block) {
    // Refusing is correct; refusing SILENTLY is what let eight commits sit
    // unreleased behind one untracked file (ISSUE-174). One blocked cycle is
    // normal — someone is mid-edit — so the alarm starts at two.
    const n = o.state?.noteBlocked() ?? 1;
    const msg = `refusing to release — ${decision.block.detail}`;
    if (n >= 2) o.emit.error(`${msg} (blocked ${n} cycles running)`, { data: { cycles: n } });
    else o.emit.warn(msg);
    return { merged: [], deployed: false, stopped: decision.block.detail, decision };
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
    return { merged: [], deployed: false, stopped: 'external', decision };
  }

  o.emit.enter('merge');
  const merged: MergeCandidate[] = [];
  const conflicts: ConflictFailure[] = [];
  let applied = 0;
  for (const c of decision.merges) {
    if (!c.branch) {
      o.emit.emit(
        c.skipReason === 'already-merged'
          ? 'verified and already merged, waiting on a successful release'
          : 'verified but has no branch and nothing on the base names it — nothing to merge',
        { ticket: c.ticket.issue_id },
      );
      continue;
    }
    const r = mergeOne(o, c);
    if (typeof r === 'object') { conflicts.push(r.conflict); continue; }
    if (r === 'applied') applied++;
    merged.push(c);
  }

  if (o.mergeOnly) {
    o.emit.emit(`merge only: ${merged.length} branch(es) merged, not releasing`);
    return { merged, conflicts, deployed: false, stopped: 'merge only', decision };
  }

  o.emit.enter('release');
  const head = o.dryRun ? decision.head : headSha(o.cwd);
  if (merged.length === 0 && decision.upToDate && !o.force) {
    o.emit.emit('nothing to release');
    return { merged, conflicts, deployed: false, stopped: 'nothing to release', decision };
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
    return { merged, conflicts, deployed: false, stopped: 'nothing merged and no release marker', decision };
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
    o.emit.emit(
      `nothing to release — ${merged.length} branch(es) were already contained in ` +
        `${o.repo.branch.base}; stamping without cutting a version`,
    );
    return {
      merged, conflicts, deployed: false, alreadyLive: true,
      version: decision.lastTag?.replace(/^v/, ''),
      stopped: 'already contained in the base branch', decision,
    };
  }
  if (merged.length === 0 && decision.upToDate && o.force) {
    o.emit.emit('forced: nothing new merged and nothing unreleased, releasing anyway');
  }

  if (!o.skipTests && o.repo.hooks.test) {
    if (o.dryRun) o.emit.emit(`would run the test gate: ${hookLabel(o.repo, 'test')}`);
    else {
      const r = await hook(o, 'test');
      if (r && r.code !== 0) {
        o.emit.error(`test gate FAILED — not deploying; the target stays on the previous release`);
        return { merged, conflicts, deployed: false, stopped: 'tests failed', decision };
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
      const r = await hook(o, 'build');
      if (r && r.code !== 0) {
        o.emit.error('build failed — not deploying');
        return { merged, conflicts, version, deployed: false, stopped: 'build failed', decision };
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
      const r = await hook(o, 'deploy');
      if (r && r.code !== 0) {
        o.emit.error(`deploy FAILED (exit ${r.code}) — the target may be partially deployed`);
        o.state?.noteDeployFailed(headSha(o.cwd));
        return { merged, conflicts, version, deployed: false, stopped: 'deploy failed', decision };
      }
      deployed = true;
      o.state?.clearDeployFailed();
    }
  } else if (o.repo.release.mode !== 'local') {
    o.emit.emit(`release.mode is ${o.repo.release.mode} — CI takes it from here`);
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
        return { merged, conflicts, version, tag, deployed, integrated, decision, stopped: 'tag push failed' };
      }
    }
  }

  const confirmed = await confirm(o, o.dryRun ? head : headSha(o.cwd));
  o.emit.emit(
    `release ${o.dryRun ? 'plan complete' : 'complete'}: ${merged.length} merged` +
      `${version ? `, ${version}` : ''}${tag ? `, tagged ${tag}` : ''}`,
    { data: { merged: merged.length, version, tag, deployed, integrated, confirmed } },
  );
  return { merged, conflicts, version, tag, deployed, integrated, confirmed, decision };
}

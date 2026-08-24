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
import { createReleaseTag, git, headSha, tagExists } from './git.ts';
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
  /** Why nothing happened, when nothing did. */
  stopped?: string;
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
function mergeOne(o: ReleaseRunOptions, c: MergeCandidate): boolean {
  const subject = c.entries[0] ?? `${c.ticket.title ?? c.ticket.issue_id} (${c.ticket.issue_id})`;
  if (o.dryRun) {
    o.emit.emit(`would squash-merge ${c.branch} — "${subject}"`, { ticket: c.ticket.issue_id });
    return true;
  }
  try {
    git(o.cwd, ['merge', '--squash', c.branch!]);
    // The ticket key goes in the SUBJECT deliberately: it is the only durable
    // link once a forge squashes this again, and closure detection reads it.
    git(o.cwd, ['commit', '-m', `${subject}\n\nCloses ${c.ticket.issue_id}.`]);
    o.emit.emit(`merged ${c.branch}`, { ticket: c.ticket.issue_id });
    return true;
  } catch (e) {
    // Leave the tree as git left it and stop touching this branch: a
    // half-applied squash is not something to paper over.
    git(o.cwd, ['merge', '--abort']);
    o.emit.error(`could not merge ${c.branch}: ${(e as Error).message}`, { ticket: c.ticket.issue_id });
    return false;
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

export async function runRelease(o: ReleaseRunOptions): Promise<ReleaseOutcome> {
  const tagPattern = o.repo.release.tagPattern ?? 'v*';
  const decision = decideRelease(o.cwd, o.tickets, o.contract, {
    tagPattern, base: o.repo.branch.base,
  });
  o.emit.enter('release');

  if (decision.block) {
    o.emit.warn(`refusing to release — ${decision.block.detail}`);
    return { merged: [], deployed: false, stopped: decision.block.detail, decision };
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
    if (mergeOne(o, c)) merged.push(c);
  }

  if (o.mergeOnly) {
    o.emit.emit(`merge only: ${merged.length} branch(es) merged, not releasing`);
    return { merged, deployed: false, stopped: 'merge only', decision };
  }

  o.emit.enter('release');
  const head = o.dryRun ? decision.head : headSha(o.cwd);
  if (merged.length === 0 && decision.upToDate && !o.force) {
    o.emit.emit('nothing to release');
    return { merged, deployed: false, stopped: 'nothing to release', decision };
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
        return { merged, deployed: false, stopped: 'tests failed', decision };
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
        return { merged, version, deployed: false, stopped: 'build failed', decision };
      }
    }
  }

  let deployed = false;
  if (o.repo.release.mode === 'local' && o.repo.hooks.deploy) {
    if (o.dryRun) o.emit.emit(`would run: ${hookLabel(o.repo, 'deploy')}`);
    else {
      const r = await hook(o, 'deploy');
      if (r && r.code !== 0) {
        o.emit.error(`deploy FAILED (exit ${r.code}) — the target may be partially deployed`);
        return { merged, version, deployed: false, stopped: 'deploy failed', decision };
      }
      deployed = true;
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

  const confirmed = await confirm(o, o.dryRun ? head : headSha(o.cwd));
  o.emit.emit(
    `release ${o.dryRun ? 'plan complete' : 'complete'}: ${merged.length} merged` +
      `${version ? `, ${version}` : ''}${tag ? `, tagged ${tag}` : ''}`,
    { data: { merged: merged.length, version, tag, deployed, confirmed } },
  );
  return { merged, version, tag, deployed, confirmed, decision };
}

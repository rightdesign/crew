/**
 * A run's worktree is its own (CREW-1385).
 *
 * A ticket's work used to live in a per-ticket, per-ship worktree that every
 * later run and the QA seat were expected to find at a deterministic path.
 * That only holds when the builder and the verifier are the same ship, and it
 * turned "assigned to me, no worktree" into a mystery that stopped a run for
 * an hour (CREW-1389). Since every hand-off pushes (CREW-1380) the branch on
 * the remote is the source of truth, so a worktree is just a scratch checkout
 * of it:
 *
 *   - a run MATERIALIZES one at its start: from `<remote>/<branch>` when the
 *     branch is already pushed, else fresh from `<remote>/<base>`;
 *   - an old one at the same path is reset to the remote tip when that loses
 *     nothing, re-cut when its branch is gone upstream and it holds no work,
 *     and left strictly alone when it holds anything not on the remote;
 *   - it is REMOVED when the run ends at a verified push, unless the repo
 *     declares a `handoff` hook (which keeps a server up for QA to open).
 *     A QA run has no push to verify, so it is removed on the same terms
 *     plus a check that nothing in it is unpushed (CREW-1405).
 *
 * "A missing worktree is never a reason to stop" — every branch of
 * `planRunWorktree` ends in a usable checkout or a named reason it was left.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  git, gitOk, status, worktrees, worktreeForNumber, fetchRemote, remoteConfigured,
  remoteBranchExists, countCommits,
} from './git.ts';
import { pidsInWorktree, killGently } from './ports.ts';
import type { EffectiveRepoConfig } from './repo-config.ts';
import {
  locateBranchForTicket, worktreeForTicket, branchRenderer, type BranchLookupTicket,
} from './ticket-branch.ts';
import { effectiveBranchTemplate } from './repo-config.ts';
import { ticketBranchContext, type Ticket } from './tracker.ts';

export type RunWorktreePlan =
  /** Nothing at the path; `origin/<branch>` exists. */
  | { action: 'cut-remote'; path: string; branch: string }
  /** Nothing at the path, no branch anywhere: a fresh start from `origin/<base>`. */
  | { action: 'cut-fresh'; path: string; branch: string; base: string }
  /** A clean worktree strictly behind the remote tip: fast-forward it. */
  | { action: 'reset'; path: string; branch: string }
  /** A clean worktree already level with (or, on a remote-less repo, all there is of) its branch. */
  | { action: 'reuse'; path: string; branch: string }
  /** Branch gone upstream, worktree holds no work of its own: remove and cut fresh. */
  | { action: 'recut'; path: string; branch: string; base: string }
  /** Uncommitted changes: someone may be editing it by hand. */
  | { action: 'leave-dirty'; path: string; branch: string | null }
  /** Commits that exist nowhere else (never pushed, or diverged from the remote). */
  | { action: 'leave-unpushed'; path: string; branch: string };

export const describeRunWorktreePlan = (p: RunWorktreePlan): string => {
  switch (p.action) {
    case 'cut-remote': return `cut ${p.path} from the remote branch ${p.branch}`;
    case 'cut-fresh': return `cut ${p.path} fresh from ${p.base} (no branch ${p.branch} anywhere yet)`;
    case 'reset': return `fast-forwarded ${p.path} to the remote tip of ${p.branch}`;
    case 'reuse': return `reusing ${p.path} (${p.branch} is already level with the remote)`;
    case 'recut': return `${p.branch} is gone from the remote and ${p.path} held no work of its own — re-cut it fresh from ${p.base}`;
    case 'leave-dirty': return `left ${p.path} alone: it has uncommitted changes (someone may be editing it by hand)`;
    case 'leave-unpushed': return `left ${p.path} alone: ${p.branch} has commits that are not on the remote`;
  }
};

/** Whether the plan leaves a usable worktree at `path` for the run to work in. */
export const planIsUsable = (p: RunWorktreePlan): boolean =>
  p.action !== 'leave-dirty' && p.action !== 'leave-unpushed';

/** The name a NEW branch for this ticket gets: the rendered template, nothing located. */
function newBranchName(cfg: EffectiveRepoConfig, t: BranchLookupTicket, role?: string): string {
  const { prefix } = ticketBranchContext(t as Ticket);
  return branchRenderer(t, role)(effectiveBranchTemplate(cfg, prefix));
}

/**
 * Decide what to do for this ticket without touching anything but the remote
 * refs (one fetch). `dir` is the primary checkout.
 */
export function planRunWorktree(
  dir: string, cfg: EffectiveRepoConfig, t: BranchLookupTicket, role?: string,
): RunWorktreePlan {
  const { remote, base } = cfg.branch;
  const hasRemote = remoteConfigured(dir, remote);
  if (hasRemote) fetchRemote(dir, remote);

  const num = t.issue_id.replace(/^\D+/, '');
  const existing = worktreeForNumber(dir, num);
  const located = locateBranchForTicket(dir, cfg, t, role);
  const baseRef = hasRemote ? `${remote}/${base}` : base;

  if (existing && !existing.prunable && existsSync(existing.path)) {
    const branch = existing.branch;
    if (status(existing.path).length > 0) return { action: 'leave-dirty', path: existing.path, branch };
    if (!branch) return { action: 'leave-unpushed', path: existing.path, branch: '(detached HEAD)' };
    if (!hasRemote) return { action: 'reuse', path: existing.path, branch };

    if (remoteBranchExists(dir, remote, branch)) {
      const ahead = countCommits(existing.path, `${remote}/${branch}..HEAD`);
      const behind = countCommits(existing.path, `HEAD..${remote}/${branch}`);
      if (ahead > 0) return { action: 'leave-unpushed', path: existing.path, branch };
      return behind > 0
        ? { action: 'reset', path: existing.path, branch }
        : { action: 'reuse', path: existing.path, branch };
    }
    // Not on the remote. Pushed-then-deleted and never-pushed look the same
    // here, so only a branch with nothing of its own beyond the base is safe
    // to throw away.
    if (countCommits(existing.path, `${baseRef}..HEAD`) > 0) return { action: 'leave-unpushed', path: existing.path, branch };
    return { action: 'recut', path: existing.path, branch, base: baseRef };
  }

  // `worktreeForTicket` names the directory; it sits beside the checkout.
  const path = join(dirname(dir), worktreeForTicket(dir, cfg, t, role));
  if (located?.where === 'remote' || (located && hasRemote && remoteBranchExists(dir, remote, located.branch))) {
    return { action: 'cut-remote', path, branch: located.branch };
  }
  if (located) {
    // Local branch only (not checked out anywhere): keep its commits.
    return { action: 'reuse', path, branch: located.branch };
  }
  return { action: 'cut-fresh', path, branch: newBranchName(cfg, t, role), base: baseRef };
}

/** Carry the plan out. Returns the worktree path the run should work in, or null when it was left alone. */
export function applyRunWorktree(dir: string, cfg: EffectiveRepoConfig, plan: RunWorktreePlan): string | null {
  const { remote } = cfg.branch;
  switch (plan.action) {
    case 'leave-dirty':
    case 'leave-unpushed':
      return null;
    case 'reuse':
      if (!worktrees(dir).some((w) => w.path === plan.path)) git(dir, ['worktree', 'add', plan.path, plan.branch]);
      return plan.path;
    case 'reset':
      git(plan.path, ['merge', '--ff-only', `${remote}/${plan.branch}`]);
      return plan.path;
    case 'cut-remote': {
      const local = gitOk(dir, ['rev-parse', '-q', '--verify', `refs/heads/${plan.branch}`]) !== null;
      if (local) {
        git(dir, ['worktree', 'add', plan.path, plan.branch]);
        gitOk(plan.path, ['merge', '--ff-only', `${remote}/${plan.branch}`]);
      } else {
        git(dir, ['worktree', 'add', '--track', '-b', plan.branch, plan.path, `${remote}/${plan.branch}`]);
      }
      return plan.path;
    }
    case 'recut':
      git(dir, ['worktree', 'remove', '--force', plan.path]);
      gitOk(dir, ['branch', '-D', plan.branch]);
      // fallthrough to a fresh cut under the same name
      git(dir, ['worktree', 'add', '-b', plan.branch, plan.path, plan.base]);
      return plan.path;
    case 'cut-fresh':
      git(dir, ['worktree', 'add', '-b', plan.branch, plan.path, plan.base]);
      return plan.path;
  }
}

/**
 * Whether the worktree's HEAD is reachable from no ref of the remote, i.e. the
 * worktree holds work that exists nowhere else (CREW-1405). A QA run ends
 * without a hand-off push to prove the remote has everything, so removal checks
 * for itself. A branch with nothing beyond the base counts as pushed.
 */
export function worktreeHoldsUnpushed(path: string, remote: string): boolean {
  const out = gitOk(path, ['for-each-ref', '--contains', 'HEAD', '--count=1', '--format=%(refname)', `refs/remotes/${remote}/`]);
  return out === null || out.trim() === '';
}

export type FinishOutcome =
  | { kind: 'removed'; path: string }
  /** The repo's `handoff` hook keeps a server up: the worktree stays for QA to open. */
  | { kind: 'kept-handoff'; path: string }
  | { kind: 'kept-dirty'; path: string }
  /** Commits not on the remote: the worktree is the only copy (CREW-1405). */
  | { kind: 'kept-unpushed'; path: string }
  | { kind: 'none' };

/**
 * End of a run that handed on at a verified push: the remote has everything,
 * so the worktree has no further reader — unless a `handoff` hook is serving
 * from it. A dirty tree is never removed (uncommitted work is not on the
 * remote).
 */
export async function finishRunWorktree(
  dir: string, cfg: EffectiveRepoConfig, branch: string,
): Promise<FinishOutcome> {
  const wt = worktrees(dir).find((w) => w.branch === branch && !w.prunable && w.path !== dir);
  if (!wt || !existsSync(wt.path)) return { kind: 'none' };
  if (cfg.hooks.handoff) return { kind: 'kept-handoff', path: wt.path };
  if (status(wt.path).length > 0) return { kind: 'kept-dirty', path: wt.path };
  if (remoteConfigured(dir, cfg.branch.remote) && worktreeHoldsUnpushed(wt.path, cfg.branch.remote)) {
    return { kind: 'kept-unpushed', path: wt.path };
  }
  const n = Number(wt.path.match(/(\d+)$/)?.[1] ?? NaN);
  if (Number.isFinite(n)) {
    const pids = pidsInWorktree(wt.path, n);
    if (pids.length) await killGently(pids);
  }
  gitOk(dir, ['worktree', 'remove', wt.path]);
  return existsSync(wt.path) ? { kind: 'kept-dirty', path: wt.path } : { kind: 'removed', path: wt.path };
}

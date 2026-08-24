/**
 * Removing a worktree once its ticket is done, and deciding whether the
 * branch goes with it.
 *
 * ISSUE-346: nothing ever called `crew drop` on a closed ticket — `crew
 * drop` was manual-only, so worktrees for closed tickets piled up as real
 * disk, and each one is also a place a stale dev server can still be
 * listening (`reap` exists for that consequence but not for the cause).
 *
 * The worktree and the branch are cleaned up on DIFFERENT rules:
 *
 * - The worktree is always disposable once the ticket is resolved. Nothing
 *   reads it after that: QA has finished, the release has merged, or the
 *   ticket was refused.
 * - The branch is deleted only once the work actually landed in the base
 *   branch (`closed_deployed`). For `closed_wont_fix` / `closed_duplicate`
 *   the branch holds commits that were deliberately never merged, and
 *   deleting it would destroy the only copy.
 *
 * `verified` is deliberately excluded even though the contract counts it as
 * resolved for a *blocker*'s purposes (see tracker.ts `terminalTickets`) — it
 * is still pre-release, and its worktree is exactly what the release phase is
 * about to merge.
 *
 * Driven by `git worktree list` rather than a filesystem guess: an actual
 * worktree already carries the branch that is checked out in it, so there is
 * no need to re-derive a branch name (or guess at its zero-padding) to find
 * what to delete.
 */

import { basename } from 'node:path';
import { worktrees, gitOk } from './git.ts';
import { pidsInWorktree, killGently } from './ports.ts';
import type { RepoTarget } from './config.ts';
import type { Contract } from './contract.ts';
import type { Ticket } from './tracker.ts';

export interface SweepAction {
  ticket: Ticket;
  path: string;
  branch: string | null;
  keepBranch: boolean;
}

/**
 * What the sweep would remove for one repository, from its ACTUAL worktrees
 * — not every terminal ticket, only the ones that still have a worktree on
 * disk.
 */
export function planWorktreeSweep(
  target: RepoTarget, tickets: Ticket[], contract: Contract, prefix: string,
): SweepAction[] {
  const terminal = new Set(contract.statuses.resolved.filter((s) => s !== contract.statuses.verified));
  const byNumber = new Map(tickets.map((t) => [t.issue_id.replace(/^\D+/, ''), t]));
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}(\\d+)$`);
  const actions: SweepAction[] = [];
  for (const w of worktrees(target.dir)) {
    const m = re.exec(basename(w.path));
    if (!m) continue;
    const ticket = byNumber.get(m[1]!);
    if (!ticket || !terminal.has(ticket.status)) continue;
    actions.push({
      ticket, path: w.path, branch: w.branch,
      keepBranch: ticket.status !== contract.statuses.deployed,
    });
  }
  return actions;
}

export interface SweepLog {
  emit(msg: string, extra?: Record<string, unknown>): unknown;
  warn(msg: string, extra?: Record<string, unknown>): unknown;
}

/**
 * Perform the plan.
 *
 * Kills anything still running inside a worktree first — `git worktree
 * remove --force` on a directory with a live server leaves the port held,
 * the same problem `reap` exists for on the orphan-process side.
 */
export async function applyWorktreeSweep(
  cwd: string, actions: SweepAction[], dryRun: boolean, log: SweepLog,
): Promise<{ removed: number; keptBranches: number }> {
  let removed = 0;
  let keptBranches = 0;
  for (const a of actions) {
    const n = Number(a.ticket.issue_id.replace(/^\D+/, ''));
    const pids = pidsInWorktree(a.path, n);
    if (pids.length) {
      log.emit(
        `${dryRun ? 'would kill' : 'killing'} processes still inside ${a.path}: ${pids.join(' ')}`,
        { ticket: a.ticket.issue_id, step: 'worktree' },
      );
      if (!dryRun) await killGently(pids);
    }
    const branchNote = a.branch
      ? a.keepBranch
        ? `keeping branch ${a.branch} — never merged`
        : `deleting branch ${a.branch} — merged and deployed`
      : 'no branch checked out';
    if (a.keepBranch) keptBranches++;
    if (dryRun) {
      log.emit(
        `would remove worktree ${a.path} for ${a.ticket.issue_id} (${a.ticket.status}); ${branchNote}`,
        { ticket: a.ticket.issue_id, step: 'worktree' },
      );
      continue;
    }
    gitOk(cwd, ['worktree', 'remove', '--force', a.path]);
    if (!a.keepBranch && a.branch) gitOk(cwd, ['branch', '-D', a.branch]);
    log.emit(
      `removed worktree for ${a.ticket.issue_id} (${a.ticket.status}); ${branchNote}`,
      { ticket: a.ticket.issue_id, step: 'worktree' },
    );
    removed++;
  }
  return { removed, keptBranches };
}

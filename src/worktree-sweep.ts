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
 * `verified` is not terminal — the contract counts it as resolved for a
 * *blocker*'s purposes (see tracker.ts `terminalTickets`) but the branch is
 * still unmerged — so a caller must pass those tickets in explicitly. Its
 * worktree is retired anyway (CREW-1405: a handoff-hook-kept worktree has no
 * reader once QA has passed it; the release merges from the branch, not from
 * a worktree), but only when nothing in it is missing from the remote, and the
 * branch is always kept.
 *
 * Driven by `git worktree list` rather than a filesystem guess: an actual
 * worktree already carries the branch that is checked out in it, so there is
 * no need to re-derive a branch name (or guess at its zero-padding) to find
 * what to delete.
 */

import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { worktrees, gitOk, status, remoteConfigured, deleteRemoteBranch } from './git.ts';
import { pidsInWorktree, killGently } from './ports.ts';
import { worktreeHoldsUnpushed } from './run-worktree.ts';
import type { RepoTarget } from './config.ts';
import type { Contract } from './contract.ts';
import type { Ticket } from './tracker.ts';

export interface SweepAction {
  ticket: Ticket;
  path: string;
  branch: string | null;
  keepBranch: boolean;
  /**
   * The ticket is merely `verified` (CREW-1405): its branch is unmerged, so the
   * worktree is only removed when nothing in it is missing from the remote.
   */
  requirePushed?: boolean;
}

/**
 * What the sweep would remove for one repository, from its ACTUAL worktrees
 * — not every terminal ticket, only the ones that still have a worktree on
 * disk.
 *
 * Matched by the ticket number trailing the worktree's directory name
 * (`(?:^|-)<n>$`), not by a specific prefix — ISSUE-969: a checkout's
 * worktrees have used more than one naming scheme over time (`tabl-946`,
 * `synthesis-issue-946`), and a repo hosts tickets from more than one
 * project, so no single prefix would match every worktree that is
 * genuinely this repo's. Ticket numbers are globally unique, so the number
 * alone is enough to find the right one; `byNumber` (built from the
 * tickets actually fetched for THIS repo) is what keeps this from ever
 * matching an unrelated directory that merely happens to end in digits.
 */
export function planWorktreeSweep(
  target: RepoTarget, tickets: Ticket[], contract: Contract,
): SweepAction[] {
  const terminal = new Set(contract.statuses.resolved.filter((s) => s !== contract.statuses.verified));
  const verified = contract.statuses.verified;
  const byNumber = new Map(tickets.map((t) => [t.issue_id.replace(/^\D+/, ''), t]));
  const actions: SweepAction[] = [];
  for (const w of worktrees(target.dir)) {
    const m = /(?:^|-)(\d+)$/.exec(basename(w.path));
    if (!m) continue;
    const ticket = byNumber.get(m[1]!);
    if (!ticket) continue;
    const isVerified = ticket.status === verified;
    if (!isVerified && !terminal.has(ticket.status)) continue;
    actions.push({
      ticket, path: w.path, branch: w.branch,
      keepBranch: ticket.status !== contract.statuses.deployed,
      ...(isVerified ? { requirePushed: true } : {}),
    });
  }
  return actions;
}

/**
 * Ticket numbers of the worktrees that exist in `target` — what the sweep
 * resolves through the tracker, so its cost follows the worktrees on disk and
 * not the size of the closed-ticket backlog (CREW-1593).
 */
export function worktreeTicketNumbers(target: RepoTarget): string[] {
  const nums = new Set<string>();
  for (const w of worktrees(target.dir)) {
    const m = /(?:^|-)(\d+)$/.exec(basename(w.path));
    if (m) nums.add(m[1]!);
  }
  return [...nums];
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
  cwd: string, actions: SweepAction[], dryRun: boolean, log: SweepLog, remote = 'origin',
): Promise<{ removed: number; keptBranches: number }> {
  let removed = 0;
  let keptBranches = 0;
  for (const a of actions) {
    // CREW-1364: a worktree with uncommitted work is reported, never removed
    // — on a ship that only ever TESTED the ticket this is rare, but `--force`
    // would destroy whatever a person left there.
    if (!dryRun && existsSync(a.path)) {
      let dirty = false;
      try { dirty = status(a.path).length > 0; } catch { /* unreadable: treat as clean, same as before */ }
      if (dirty) {
        log.warn(
          `not removing worktree ${a.path} for ${a.ticket.issue_id} (${a.ticket.status}): it has uncommitted changes`,
          { ticket: a.ticket.issue_id, step: 'worktree' },
        );
        continue;
      }
    }
    if (!dryRun && a.requirePushed && a.branch && existsSync(a.path)
      && remoteConfigured(cwd, remote) && worktreeHoldsUnpushed(a.path, remote)) {
      log.warn(
        `not removing worktree ${a.path} for ${a.ticket.issue_id} (${a.ticket.status}): ${a.branch} has commits that are not on ${remote}`,
        { ticket: a.ticket.issue_id, step: 'worktree' },
      );
      continue;
    }
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
    if (!a.keepBranch && a.branch) {
      gitOk(cwd, ['branch', '-D', a.branch]);
      // Deployed means the squash is on the base, so the pushed copy has
      // nothing left to carry (CREW-1364). Whichever ship sweeps first deletes
      // it; the rest find it already gone, which is success.
      if (remoteConfigured(cwd, remote) && !deleteRemoteBranch(cwd, remote, a.branch)) {
        log.warn(`could not delete ${remote}/${a.branch} — leaving it for the next sweep`, { ticket: a.ticket.issue_id, step: 'worktree' });
      }
    }
    log.emit(
      `removed worktree for ${a.ticket.issue_id} (${a.ticket.status}); ${branchNote}`,
      { ticket: a.ticket.issue_id, step: 'worktree' },
    );
    removed++;
  }
  return { removed, keptBranches };
}

/**
 * Pushed ticket branches whose ticket has been deployed (CREW-1364).
 *
 * `applyWorktreeSweep` only reaches a branch that some worktree on THIS ship
 * has checked out, so the ship that releases a ticket another ship built
 * would never delete the copy pushed at `fixed`. This walks the remote's own
 * branch list instead: one `for-each-ref`, however many tickets are closed,
 * and a branch is a candidate only if its name is exactly a deployed
 * ticket's own branch name (`tabl-1359`, `issue-1359`, `crew-1359-slug`). Anything else is left alone, including the base.
 *
 * The tickets passed in come from `remoteBranchTicketNumbers` resolved through
 * the tracker, not from a closed-ticket listing (CREW-1593).
 */
export function remoteBranchTicketNumbers(cwd: string, remote: string, base: string): string[] {
  if (!remoteConfigured(cwd, remote)) return [];
  const prefix = `refs/remotes/${remote}/`;
  const refs = (gitOk(cwd, ['for-each-ref', '--format=%(refname)', prefix]) ?? '').split('\n').filter(Boolean);
  const nums = new Set<string>();
  for (const ref of refs) {
    const name = ref.slice(prefix.length);
    if (name === 'HEAD' || name === base) continue;
    const m = /^.+?-(\d+)(?:-.*)?$/.exec(name);
    if (m) nums.add(m[1]!);
  }
  return [...nums];
}

export function planRemoteBranchCleanup(
  cwd: string, remote: string, base: string, tickets: Ticket[], contract: Contract,
): string[] {
  if (!remoteConfigured(cwd, remote)) return [];
  const stems = deployedBranchStems(tickets, contract);
  if (stems.size === 0) return [];
  const prefix = `refs/remotes/${remote}/`;
  const refs = (gitOk(cwd, ['for-each-ref', '--format=%(refname)', prefix]) ?? '').split('\n').filter(Boolean);
  return refs.map((ref) => ref.slice(prefix.length)).filter((name) => isTicketBranch(name, base, stems));
}

/**
 * Every stem a deployed ticket's branch could carry (`issue-N`,
 * `<project prefix>-N`), padded and unpadded. Exact names only: a free
 * "contains the number" match would also take `v2`, `release-2` or `node-24`.
 */
function deployedBranchStems(tickets: Ticket[], contract: Contract): Set<string> {
  const stems = new Set<string>();
  for (const t of tickets) {
    if (t.status !== contract.statuses.deployed) continue;
    const num = t.issue_id.replace(/^\D+/, '');
    const unpadded = String(Number.parseInt(num, 10));
    const prefixes = ['issue', t.project_issue_prefix?.toLowerCase()].filter((p): p is string => !!p);
    for (const p of prefixes) { stems.add(`${p}-${num}`); stems.add(`${p}-${unpadded}`); }
  }
  return stems;
}

/** A branch name that is a ticket stem, optionally followed by `-<slug>`. */
function isTicketBranch(name: string, base: string, stems: Set<string>): boolean {
  if (name === 'HEAD' || name === base) return false;
  const m = /^(.+?-\d+)(?:-.*)?$/.exec(name);
  return !!m && stems.has(m[1]!);
}

/**
 * Whether this checkout has anything the sweep could act on: a linked
 * worktree, or a local branch, whose name ends in a ticket number. Local git
 * reads only — the sweep runs every cycle on every repo whether or not this
 * ship released anything (CREW-1592), and a repo with nothing to sweep must
 * not cost a tracker call.
 */
export function sweepCandidatesExist(cwd: string, base: string): boolean {
  const linked = worktrees(cwd).slice(1);
  if (linked.some((w) => /(?:^|-)\d+$/.test(basename(w.path)))) return true;
  return localBranches(cwd).some((b) => b !== base && /-\d+(?:-.*)?$/.test(b));
}

/** Ticket numbers carried by this checkout's local branches (CREW-1592 sweeps those too). */
export function localBranchTicketNumbers(cwd: string, base: string): string[] {
  const nums = new Set<string>();
  for (const b of localBranches(cwd)) {
    const m = b === base ? null : /^.+?-(\d+)(?:-.*)?$/.exec(b);
    if (m) nums.add(m[1]!);
  }
  return [...nums];
}

function localBranches(cwd: string): string[] {
  return (gitOk(cwd, ['branch', '--list', '--format=%(refname:short)']) ?? '').split('\n').filter(Boolean);
}

/**
 * Local branches of deployed tickets that no worktree has checked out
 * (CREW-1592). `applyWorktreeSweep` only deletes a branch as part of removing
 * its worktree, so a branch whose worktree was already gone (removed by hand,
 * or by an earlier sweep that kept the branch) was reaped by nothing. A
 * branch some worktree still has checked out is left to that worktree's
 * sweep, which refuses a dirty one.
 */
export function planLocalBranchCleanup(
  cwd: string, base: string, tickets: Ticket[], contract: Contract,
): string[] {
  const stems = deployedBranchStems(tickets, contract);
  if (stems.size === 0) return [];
  const checkedOut = new Set(worktrees(cwd).map((w) => w.branch).filter((b): b is string => !!b));
  return localBranches(cwd).filter((b) => !checkedOut.has(b) && isTicketBranch(b, base, stems));
}

export function applyLocalBranchCleanup(
  cwd: string, branches: string[], dryRun: boolean, log: SweepLog,
): number {
  let deleted = 0;
  for (const b of branches) {
    if (dryRun) { log.emit(`would delete local branch ${b} — its ticket is deployed`, { step: 'worktree' }); continue; }
    if (gitOk(cwd, ['branch', '-D', b] ) !== null) { deleted++; log.emit(`deleted local branch ${b} — its ticket is deployed`, { step: 'worktree' }); }
    else log.warn(`could not delete local branch ${b} — leaving it for the next sweep`, { step: 'worktree' });
  }
  return deleted;
}

export function applyRemoteBranchCleanup(
  cwd: string, remote: string, branches: string[], dryRun: boolean, log: SweepLog,
): number {
  let deleted = 0;
  for (const b of branches) {
    if (dryRun) { log.emit(`would delete ${remote}/${b} — its ticket is deployed`, { step: 'worktree' }); continue; }
    if (deleteRemoteBranch(cwd, remote, b)) { deleted++; log.emit(`deleted ${remote}/${b} — its ticket is deployed`, { step: 'worktree' }); }
    else log.warn(`could not delete ${remote}/${b} — leaving it for the next sweep`, { step: 'worktree' });
  }
  return deleted;
}

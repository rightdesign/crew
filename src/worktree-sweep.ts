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

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { worktrees, git, gitOk, status, remoteConfigured, deleteRemoteBranch, type WorktreeInfo } from './git.ts';
import { pidsInWorktree, killGently } from './ports.ts';
import { worktreeHoldsUnpushed } from './run-worktree.ts';
import type { RepoTarget } from './config.ts';
import type { Contract } from './contract.ts';
import type { Ticket } from './tracker.ts';
import type { State } from './state.ts';
import { noteHeldWorktree } from './ship-attention.ts';

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
  // Entry 0 is the primary checkout, which is never a ticket's worktree.
  for (const w of worktrees(target.dir).slice(1)) {
    const ticket = ticketForWorktree(w, byNumber, contract);
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

/** `(?:^|-)<n>` at the end of a directory name: the scheme every worktree name has used. */
const DIR_NUMBER = /(?:^|-)(\d+)$/;
/** CREW-2050: the same, with a short suffix a hand-cut worktree carries (`…-1871-qa`). */
const DIR_NUMBER_SUFFIXED = /(?:^|-)(\d+)(?:-[a-z0-9]{1,8})?$/;
/** A ticket branch with any `owner/` directory and `-<slug>` tail removed: `bc/issue-16-old` → `issue-16`. */
const BRANCH_STEM = /^(?:.*\/)?([^/]+?-\d+)(?:-.*)?$/;

/**
 * Which ticket a worktree belongs to (CREW-2050). In order: the checked-out
 * branch (one of the ticket's own stems, whatever the directory is called),
 * the directory's trailing ticket number, and — for a DETACHED worktree only,
 * which has no branch to lose — the number followed by a short suffix. The
 * suffixed form is further limited to a deployed ticket: a detached HEAD can
 * carry commits no branch points at, which only a deployed ticket makes safe
 * to discard.
 */
function ticketForWorktree(
  w: WorktreeInfo, byNumber: Map<string, Ticket>, contract: Contract,
): Ticket | undefined {
  if (w.branch) {
    const stem = BRANCH_STEM.exec(w.branch)?.[1];
    const num = stem && /-(\d+)$/.exec(stem)?.[1];
    const t = num ? byNumber.get(num) : undefined;
    if (t && ticketStems(t).has(stem!)) return t;
  }
  const dir = basename(w.path);
  const m = DIR_NUMBER.exec(dir);
  if (m && byNumber.has(m[1]!)) return byNumber.get(m[1]!);
  if (!w.branch) {
    const t = byNumber.get(DIR_NUMBER_SUFFIXED.exec(dir)?.[1] ?? '');
    if (t && t.status === contract.statuses.deployed) return t;
  }
  return undefined;
}

/**
 * Ticket numbers of the worktrees that exist in `target` — what the sweep
 * resolves through the tracker, so its cost follows the worktrees on disk and
 * not the size of the closed-ticket backlog (CREW-1593). Includes the numbers
 * of sibling directories that look like this checkout's worktrees but are not
 * registered (`orphanedWorktreeDirs`), so those tickets are looked up too.
 */
export function worktreeTicketNumbers(target: RepoTarget): string[] {
  const nums = new Set<string>();
  for (const w of worktrees(target.dir).slice(1)) {
    if (w.branch) {
      const n = /-(\d+)$/.exec(BRANCH_STEM.exec(w.branch)?.[1] ?? '')?.[1];
      if (n) nums.add(n);
    }
    const m = DIR_NUMBER_SUFFIXED.exec(basename(w.path));
    if (m) nums.add(m[1]!);
  }
  for (const d of siblingWorktreeDirs(target)) nums.add(d.number);
  return [...nums];
}

/**
 * Directories beside the checkout named like one of its default-scheme
 * worktrees (`<checkout dir>-<anything>-<n>[-suffix]`) that git does not know.
 */
function siblingWorktreeDirs(target: RepoTarget): { path: string; number: string }[] {
  const parent = dirname(target.dir.replace(/[/\\]+$/, ''));
  const stem = `${basename(target.dir.replace(/[/\\]+$/, ''))}-`;
  const registered = new Set(worktrees(target.dir).map((w) => resolve(w.path)));
  let names: string[];
  try { names = readdirSync(parent); } catch { return []; }
  const out: { path: string; number: string }[] = [];
  for (const name of names) {
    if (!name.startsWith(stem)) continue;
    const m = DIR_NUMBER_SUFFIXED.exec(name);
    const path = join(parent, name);
    if (m && !registered.has(resolve(path))) out.push({ path, number: m[1]! });
  }
  return out;
}

/**
 * Unregistered sibling directories of a deployed ticket — what a
 * `worktree remove` that failed partway leaves behind (CREW-2050). Reported,
 * never deleted: with no `.git` link there is no way to tell what is in them.
 */
export function orphanedWorktreeDirs(target: RepoTarget, tickets: Ticket[], contract: Contract): string[] {
  const deployed = new Set(
    tickets.filter((t) => t.status === contract.statuses.deployed).map((t) => t.issue_id.replace(/^\D+/, '')),
  );
  return siblingWorktreeDirs(target).filter((d) => deployed.has(d.number)).map((d) => d.path);
}

/**
 * Warns about orphaned directories. With `held`, each is recorded like a
 * refused worktree (CREW-2051), so it warns once and then lives on as a ship
 * attention item instead of repeating every cycle.
 */
export function warnOrphanedWorktreeDirs(paths: string[], log: SweepLog, held?: { state: State; repo: string }): void {
  for (const p of paths) {
    const number = DIR_NUMBER_SUFFIXED.exec(basename(p))?.[1];
    const when = held && number
      ? noteHeldWorktree(held.state, { repo: held.repo, path: p, ticket: number, status: 'deployed', reason: 'orphaned directory' })
      : 'first';
    if (when) {
      log.warn(`orphaned directory ${p}: its ticket is deployed but it is not a registered worktree; the sweep will not delete it — remove it by hand`, { step: 'worktree' });
    }
  }
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
  cwd: string, actions: SweepAction[], dryRun: boolean, log: SweepLog, remote = 'origin', base?: string,
  held?: { state: State; repo: string },
): Promise<{ removed: number; keptBranches: number; refused: string[] }> {
  const refused: string[] = [];
  // CREW-2051: a refusal warns once, then lives on as a ship attention item.
  const refuse = (a: SweepAction, reason: string, detail: string): void => {
    refused.push(a.path);
    const when = held
      ? noteHeldWorktree(held.state, { repo: held.repo, path: a.path, ticket: a.ticket.issue_id, status: a.ticket.status, reason })
      : 'first';
    if (when) {
      log.warn(
        `not removing worktree ${a.path} for ${a.ticket.issue_id} (${a.ticket.status}): ${detail}`,
        { ticket: a.ticket.issue_id, step: 'worktree' },
      );
    }
  };
  let removed = 0;
  let keptBranches = 0;
  for (const a of actions) {
    // CREW-2050: crew's own conflict hand-back leaves a half-finished merge of
    // the base here by design. Once the ticket has deployed anyway, nothing is
    // coming back to resolve it; abort it so what remains is only real work.
    if (!dryRun && base && !a.keepBranch && existsSync(a.path) && isHandBackMerge(a.path, base)) {
      if (gitOk(a.path, ['merge', '--abort']) !== null) {
        log.emit(
          `abandoned the hand-back merge of ${base} in ${a.path}: ${a.ticket.issue_id} deployed without it`,
          { ticket: a.ticket.issue_id, step: 'worktree' },
        );
      }
    }
    // CREW-1364: a worktree with uncommitted work is reported, never removed
    // — on a ship that only ever TESTED the ticket this is rare, but `--force`
    // would destroy whatever a person left there.
    if (!dryRun && existsSync(a.path)) {
      let dirty = false;
      try { dirty = status(a.path).length > 0; } catch { /* unreadable: treat as clean, same as before */ }
      if (dirty) {
        refuse(a, 'uncommitted changes', 'it has uncommitted changes');
        continue;
      }
    }
    if (!dryRun && a.requirePushed && a.branch && existsSync(a.path)
      && remoteConfigured(cwd, remote) && worktreeHoldsUnpushed(a.path, remote)) {
      refuse(a, 'unpushed commits', `${a.branch} has commits that are not on ${remote}`);
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
    // CREW-2050: a removal that fails (a locked file, a synced folder) is not a
    // removal; leave the worktree and its branch for the next cycle.
    try { git(cwd, ['worktree', 'remove', '--force', a.path]); } catch (e) {
      refuse(a, 'removal failed', `could not remove it: ${(e as Error).message}`);
      continue;
    }
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
  if (!dryRun && actions.length) gitOk(cwd, ['worktree', 'prune']);
  return { removed, keptBranches, refused };
}

/**
 * A merge in progress whose message is the one `refreshBranch` (conflict.ts)
 * writes when it merges `base` into a ticket branch: `Merge branch 'main' into
 * …` or `Merge remote-tracking branch 'origin/main' into …`.
 */
function isHandBackMerge(path: string, base: string): boolean {
  if (gitOk(path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']) === null) return false;
  const msgPath = gitOk(path, ['rev-parse', '--git-path', 'MERGE_MSG']);
  if (!msgPath) return false;
  let first: string;
  try { first = readFileSync(resolve(path, msgPath), 'utf8').split('\n')[0] ?? ''; } catch { return false; }
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^Merge (?:remote-tracking )?branch '(?:[^']+/)?${escaped}'`).test(first);
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
    for (const st of ticketStems(t)) stems.add(st);
  }
  return stems;
}

function ticketStems(t: Ticket): Set<string> {
  const stems = new Set<string>();
  const num = t.issue_id.replace(/^\D+/, '');
  const unpadded = String(Number.parseInt(num, 10));
  const prefixes = ['issue', t.project_issue_prefix?.toLowerCase()].filter((p): p is string => !!p);
  for (const p of prefixes) { stems.add(`${p}-${num}`); stems.add(`${p}-${unpadded}`); }
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
  if (linked.some((w) => DIR_NUMBER_SUFFIXED.test(basename(w.path)) || (w.branch && BRANCH_STEM.test(w.branch)))) return true;
  if (siblingWorktreeDirs({ name: '', dir: cwd }).length) return true;
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

/**
 * The existing branch for ONE ticket in ONE repo — the single lookup every
 * phase shares.
 *
 * Which template applies depends on the TICKET (its own project tag), not
 * only on the repo (ISSUE-969, `effectiveBranchTemplate`). The poll digest
 * learned that; the release phase did not, kept calling `branchForIssue`
 * with its bare `issue-{number}` default, and so reported every ticket built
 * on a `tabl-961`-style branch as verified-with-no-branch and bounced it to a
 * person (ISSUE-977). Both now come through here so they cannot disagree
 * about where a ticket's work is again.
 */
import {
  branchForIssue, remoteBranchForIssue, remoteConfigured, fetchRemote, materializeRemoteBranch,
} from './git.ts';
import {
  effectiveBranchTemplate, effectiveWorktreeDirName, renderBranchName, type EffectiveRepoConfig,
} from './repo-config.ts';
import { ticketBranchContext, type Ticket } from './tracker.ts';

export type BranchLookupTicket = Pick<Ticket, 'issue_id' | 'issue_tag' | 'project_issue_prefix'> & {
  title?: string | null;
};

/** Renders a branch template for this ticket — `{prefix}`, `{tag}`, `{slug}` and all. */
export function branchRenderer(t: BranchLookupTicket, role?: string): (template: string) => string {
  const { tag, prefix } = ticketBranchContext(t as Ticket);
  return (template) => renderBranchName(template, { key: t.issue_id, title: t.title ?? undefined, role, tag, prefix });
}

/**
 * Where THIS ticket's worktree belongs, beside the checkout at `dir`
 * (ISSUE-1028) — the same `{prefix}` resolution `branchRenderer` uses for
 * the branch name, fed into `effectiveWorktreeDirName` so the digest's
 * `branch` and `worktree` columns can never disagree with each other about
 * which convention applies to this ticket.
 */
export function worktreeForTicket(dir: string, cfg: EffectiveRepoConfig, t: BranchLookupTicket, role?: string): string {
  const { prefix } = ticketBranchContext(t as Ticket);
  const branchName = branchRenderer(t, role)(effectiveBranchTemplate(cfg, prefix));
  const number = t.issue_id.replace(/^\D+/, '');
  return effectiveWorktreeDirName(cfg, dir, branchName, number);
}

function branchTemplates(cfg: EffectiveRepoConfig, t: BranchLookupTicket) {
  const { prefix } = ticketBranchContext(t as Ticket);
  const name = effectiveBranchTemplate(cfg, prefix);
  const push = cfg.provenance['branch.push'] === 'default' ? name : cfg.branch.push;
  return { name, push };
}

/**
 * What this ticket's branch is called on the remote — `branch.push`, rendered
 * for the ticket. The name a reviewer sees and `hooks.merged` is asked about,
 * which is not the local branch's name when the repo sets a `push` template.
 */
export function pushedBranchForTicket(cfg: EffectiveRepoConfig, t: BranchLookupTicket, role?: string): string {
  return branchRenderer(t, role)(branchTemplates(cfg, t).push);
}

/** The ticket's branch on THIS ship only. What a lane resuming its own worktree wants. */
export function existingBranchForTicket(
  dir: string, cfg: EffectiveRepoConfig, t: BranchLookupTicket, role?: string,
): string | null {
  return branchForIssue(dir, t.issue_id, branchTemplates(cfg, t), branchRenderer(t, role));
}

export interface LocatedBranch {
  branch: string;
  /** `local` here, or `remote` only — built on another ship and pushed at `fixed`. */
  where: 'local' | 'remote';
}

/**
 * The ticket's branch wherever it lives: this ship first, then the repo's
 * remote (CREW-1364).
 *
 * A branch built on another ship exists here only as a remote-tracking ref,
 * so a local-only lookup reported finished work as MISSING (QA) or stranded
 * (release). On a local miss this fetches once — `fetchedDirs` remembers
 * which checkouts a caller has already fetched, so a digest over many
 * tickets pays for one fetch per repo, and only when something was missing —
 * then looks at `refs/remotes/<remote>/…` with the same candidate names.
 */
export function locateBranchForTicket(
  dir: string, cfg: EffectiveRepoConfig, t: BranchLookupTicket, role?: string,
  fetchedDirs?: Set<string>,
): LocatedBranch | null {
  const local = existingBranchForTicket(dir, cfg, t, role);
  if (local) return { branch: local, where: 'local' };
  const remote = cfg.branch.remote;
  if (!remoteConfigured(dir, remote)) return null;
  if (fetchedDirs && !fetchedDirs.has(dir)) {
    fetchedDirs.add(dir);
    fetchRemote(dir, remote);
  }
  const found = remoteBranchForIssue(dir, remote, t.issue_id, branchTemplates(cfg, t), branchRenderer(t, role));
  return found ? { branch: found, where: 'remote' } : null;
}

/**
 * `locateBranchForTicket`, then — for the release phase, which needs a local
 * ref to squash — make the branch exist locally (and level with the remote
 * when no worktree holds it). A no-op for a branch that is local and already
 * current.
 */
export function materializeBranchForTicket(
  dir: string, cfg: EffectiveRepoConfig, t: BranchLookupTicket, role?: string,
): string | null {
  const loc = locateBranchForTicket(dir, cfg, t, role);
  if (!loc) return null;
  materializeRemoteBranch(dir, cfg.branch.remote, loc.branch);
  return loc.branch;
}

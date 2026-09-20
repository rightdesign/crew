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
import { branchForIssue } from './git.ts';
import { effectiveBranchTemplate, renderBranchName, type EffectiveRepoConfig } from './repo-config.ts';
import { ticketBranchContext, type Ticket } from './tracker.ts';

export type BranchLookupTicket = Pick<Ticket, 'issue_id' | 'issue_tag' | 'project_issue_prefix'> & {
  title?: string | null;
};

/** Renders a branch template for this ticket — `{prefix}`, `{tag}`, `{slug}` and all. */
export function branchRenderer(t: BranchLookupTicket, role?: string): (template: string) => string {
  const { tag, prefix } = ticketBranchContext(t as Ticket);
  return (template) => renderBranchName(template, { key: t.issue_id, title: t.title ?? undefined, role, tag, prefix });
}

export function existingBranchForTicket(
  dir: string, cfg: EffectiveRepoConfig, t: BranchLookupTicket, role?: string,
): string | null {
  const { prefix } = ticketBranchContext(t as Ticket);
  const name = effectiveBranchTemplate(cfg, prefix);
  const push = cfg.provenance['branch.push'] === 'default' ? name : cfg.branch.push;
  return branchForIssue(dir, t.issue_id, { name, push }, branchRenderer(t, role));
}

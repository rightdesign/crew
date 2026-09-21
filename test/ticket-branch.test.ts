import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRepoConfig, parseRepoConfig } from '../src/repo-config.ts';
import { worktreeForTicket, type BranchLookupTicket } from '../src/ticket-branch.ts';

const MIN = 'version: 1\nhooks:\n  test: t\n  build: b\n  deploy: d\n';

// ISSUE-1028's own acceptance test: a digest row for a ticket carrying a
// project prefix, in a checkout with no explicit `worktrees.prefix`
// override, renders branch `tabl-1026` and worktree `synthesis-tabl-1026`;
// one with no prefix renders `issue-1026` / `synthesis-issue-1026`; one
// under an explicit `worktrees.prefix: foo-` renders `foo-1026`.

test('a ticket with a project prefix gets the checkout-basename-branch worktree', () => {
  const cfg = resolveRepoConfig(parseRepoConfig(MIN, '.crew.yaml'), undefined, '/w/synthesis');
  const t: BranchLookupTicket = { issue_id: 'ISSUE-1026', issue_tag: 'TABL-1026', project_issue_prefix: 'TABL' };
  assert.equal(worktreeForTicket('/w/synthesis', cfg, t), 'synthesis-tabl-1026');
});

test('a ticket with no project prefix falls back to plain issue-{number}', () => {
  const cfg = resolveRepoConfig(parseRepoConfig(MIN, '.crew.yaml'), undefined, '/w/synthesis');
  const t: BranchLookupTicket = { issue_id: 'ISSUE-1026' };
  assert.equal(worktreeForTicket('/w/synthesis', cfg, t), 'synthesis-issue-1026');
});

test('an explicit worktrees.prefix override still wins outright, <prefix><number> form', () => {
  const withPrefix = `${MIN}worktrees:\n  prefix: foo-\n`;
  const cfg = resolveRepoConfig(parseRepoConfig(withPrefix, '.crew.yaml'), undefined, '/w/synthesis');
  const t: BranchLookupTicket = { issue_id: 'ISSUE-1026', issue_tag: 'TABL-1026', project_issue_prefix: 'TABL' };
  assert.equal(worktreeForTicket('/w/synthesis', cfg, t), 'foo-1026');
});

// The whole point of ISSUE-1028: the branch and worktree must always agree
// about which naming convention applies to a given ticket.
test('branch and worktree never disagree about the applicable convention', () => {
  const cfg = resolveRepoConfig(parseRepoConfig(MIN, '.crew.yaml'), undefined, '/w/crew');
  const t: BranchLookupTicket = { issue_id: 'ISSUE-971', issue_tag: 'CREW-971', project_issue_prefix: 'CREW' };
  assert.equal(worktreeForTicket('/w/crew', cfg, t), 'crew-crew-971');
});

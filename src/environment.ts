/**
 * The Environment block — everything a brief used to have to hard-code.
 *
 * The prompts under `prompts/` are shared by every project the crew is ever
 * pointed at, so they may not contain a path, a shell command, an id or a
 * person's name (ISSUE-293). What they CAN do is refer to things by role:
 * "the setup hook", "your worktree", "the Issues table". This module renders
 * what those refer to, for this route and this repository, and the crew
 * injects it above the brief at run time.
 *
 * Everything here is derived. Nothing in this file knows what project it is
 * describing, which is the property that makes the briefs portable.
 */

import { basename } from 'node:path';
import type { Route } from './config.ts';
import type { EffectiveRepoConfig, RepoHooks } from './repo-config.ts';
import type { Contract } from './contract.ts';
import { renderBranchName, effectiveBranchTemplate, effectiveWorktreeDirName } from './repo-config.ts';

/** The environment variable the crew hands the session its tracker key in. */
export const API_KEY_VAR = 'CREW_API_KEY';

/** One repository this route serves, as the brief must describe it. */
export interface EnvironmentRepo {
  /** The name the tracker's `Repos` table uses — the digest's `repo` column. */
  name: string;
  /** The checkout on this machine. */
  dir: string;
  config: EffectiveRepoConfig;
  /**
   * This repo's row id in the tracker's `Repos` table — what a NEW ticket's
   * `repo` column must hold (ISSUE-411: a bug filed without this sits
   * unrouted, invisible to per-repo placement, until a person backfills it).
   * Absent when the route has no resolved id for this repo yet.
   */
  id?: string;
}

export interface EnvironmentInput {
  route: Route;
  /** From the ship: one identity for everything this machine sends. */
  userAgent: string;
  /**
   * Every repository this route serves, not just the first.
   *
   * An area spans several repos (ISSUE-331) and they do not share a branch
   * convention, a worktree name, or a test command. The environment is built
   * before the session picks its ticket, so it cannot know which one applies
   * — it describes them all, and the digest's `repo` column says which is
   * this ticket's (ISSUE-350).
   */
  repos: EnvironmentRepo[];
  contract: Contract;
  /** Where this ticket's work happens, when the cycle knows it. */
  repoDir?: string | null;
  /** The ticket this session was spawned to work, when the cycle knows it. */
  sourceTicket?: string | null;
}

/**
 * What each hook is FOR, in the brief's terms.
 *
 * The order is the order a session encounters them, so the rendered table
 * reads as a sequence rather than an alphabetical list.
 */
const HOOK_PURPOSE: Array<[keyof RepoHooks, string]> = [
  ['setup', 'make a fresh worktree usable — dependencies, generated clients'],
  ['isolate', 'point this worktree at state of its own; prints KEY=value overrides to export'],
  ['ports', 'this worktree\'s port assignments; prints KEY=value overrides to export'],
  ['handoff', 'leave the operator able to open what you built; put its output in your progress comment'],
  ['test', 'run the suite'],
  ['build', 'build it'],
];

function hookTable(repo: EffectiveRepoConfig): string {
  const declared = HOOK_PURPOSE.filter(([name]) => repo.hooks[name]);
  if (declared.length === 0) {
    return 'This repository declares no hooks. Do not guess commands for it — say so ' +
      'in your progress comment and stop.\n';
  }

  // A hook is often a small script, and a newline inside a table cell ends the
  // row — the table renders as wreckage and the command is unreadable. Only
  // one-liners go inline; the rest are written out below the table.
  const inline = (cmd: string) => (cmd.includes('\n') ? '_(below)_' : `\`${cmd}\``);
  const blocks = declared
    .filter(([name]) => repo.hooks[name]!.includes('\n'))
    .map(([name]) => [`### \`${name}\``, '', '```sh', repo.hooks[name]!.trimEnd(), '```', ''].join('\n'));

  const undeclared = HOOK_PURPOSE.filter(([n]) => !repo.hooks[n]);

  return [
    '| hook | what it is for | what it runs |',
    '| --- | --- | --- |',
    ...declared.map(([name, purpose]) => `| \`${name}\` | ${purpose} | ${inline(repo.hooks[name]!)} |`),
    '',
    'Run these **verbatim**, from the worktree. They come from the repository\'s own',
    'configuration, which is the only thing that knows them. A command you invented',
    'yourself is wrong even when it works, because the next repository will differ.',
    '',
    ...blocks,
    ...(undeclared.length
      ? [`Not declared here, so there is nothing to run for them: ${
          undeclared.map(([n]) => `\`${n}\``).join(', ')
        }.`, '']
      : []),
  ].join('\n');
}

/**
 * This repo's own worktree prefix, minus its trailing dash, when it is one
 * this repo actually derived (from `.crew.yaml`, the ship, or a project's
 * Issue Tag) rather than the bare directory-name fallback. `undefined` in
 * the fallback case, which is exactly what `effectiveBranchTemplate` reads
 * as "no prefix, plain `issue-{number}`".
 */
function repoPrefix(repo: EffectiveRepoConfig): string | undefined {
  return repo.provenance['worktrees.prefix'] !== 'default'
    ? repo.worktrees.prefix.replace(/-$/, '')
    : undefined;
}

/**
 * A worked example of this repo's branch name, using a real ticket key.
 *
 * The template alone is not enough: `{number}` and `{key}` are easy to
 * transpose, and a brief that says "substitute the placeholders" invites
 * exactly that mistake. Showing the answer for a concrete ticket removes the
 * substitution step.
 *
 * Uses `effectiveBranchTemplate`, not `repo.branch.name` directly: the
 * default template itself depends on whether this repo has a derivable
 * project prefix (ISSUE-969), which this brief is rendered before any
 * specific ticket is known, so the closest true example is this repo's own
 * prefix, when it has one.
 */
function branchExample(repo: EffectiveRepoConfig, key: string): string {
  const prefix = repoPrefix(repo);
  const template = effectiveBranchTemplate(repo, prefix);
  return renderBranchName(template, { key, title: 'Fix the widget', role: 'dev', prefix });
}

/**
 * The part of the environment that is true of ONE repository.
 *
 * Split out because a route may serve several, and everything in here —
 * where the worktree goes, what the branch is called, which files to copy,
 * which commands may be run — differs between them.
 */
function repoSection(r: EnvironmentRepo, key: string, heading: string): string[] {
  const repo = r.config;
  const branchTemplate = effectiveBranchTemplate(repo, repoPrefix(repo));
  const branchName = branchExample(repo, key);
  const worktreeName = effectiveWorktreeDirName(repo, r.dir, branchName, key.replace(/^\D+/, ''));
  const worktreePattern = repo.provenance['worktrees.prefix'] !== 'default'
    ? `${repo.worktrees.prefix}<number>`
    : `${basename(r.dir.replace(/[/\\]+$/, ''))}-<branch>`;
  const lines: string[] = [
    '',
    heading,
    '',
    `- Cut it from \`${repo.branch.base}\`, beside the checkout, at`,
    `  \`../${worktreePattern}\` — for ${key} that is \`../${worktreeName}\`.`,
    `- Name the branch the way this repository names branches: \`${branchTemplate}\``,
    `  — for ${key} that is \`${branchName}\`.`,
    '- Never work in the main checkout. It is the operator\'s, and the release phase',
    '  uses it.',
    '',
    `${key} above is a placeholder, not a real ticket: this section is rendered`,
    'before any ticket is chosen, so it cannot know a specific ticket\'s own',
    'project prefix. Once you have a ticket, its digest row\'s `branch` and',
    '`worktree` columns are the real, per-ticket values — use those verbatim',
    'over this section\'s worked example if the two ever disagree.',
  ];

  if (repo.worktrees.copy.length) {
    lines.push(
      '',
      'A worktree is a clean checkout, so it is missing exactly the files git ignores.',
      'Copy these across from the main checkout before running anything:',
      '',
      ...repo.worktrees.copy.map((c) => `- \`${c}\``),
    );
  }

  if (repo.docs.designGuide) {
    lines.push(
      '',
      '## This project\'s design brief',
      '',
      `\`${repo.docs.designGuide}\`, in the repository. Read it from the primary`,
      'checkout before you `cd` into any worktree — a worktree cut from the base',
      'branch only has it once it has been committed there.',
    );
  }

  if (repo.docs.triagePolicy) {
    lines.push(
      '',
      '## This project\'s triage policy',
      '',
      `\`${repo.docs.triagePolicy}\`, in the repository. Where it and any brief`,
      'disagree about what a status means or when a ticket may be accepted, the',
      'policy document wins: it is the project\'s own decision, and the brief is',
      'shared with projects that decided differently.',
    );
  }

  return lines;
}

export function renderEnvironment(i: EnvironmentInput): string {
  const { route, contract } = i;
  const repos = i.repos;
  const only = repos.length === 1 ? repos[0]! : undefined;
  const models = route.resolved?.models;
  const epicsModelId = route.resolved?.epicsModelId;
  const key = 'ISSUE-000';

  const lines: string[] = [
    '# Your environment',
    '',
    'Supplied by the crew for THIS run. The brief below is shared by every project',
    'the crew works on and deliberately names nothing specific; this section is where',
    'those names come from. Where the two appear to disagree, this section wins.',
    '',
    '## The board',
    '',
    `- Base URL: \`${route.baseUrl}\``,
    `- Your key is in the \`${API_KEY_VAR}\` environment variable. Send it as`,
    `  \`Authorization: Bearer $${API_KEY_VAR}\`. **Do not read it out of any file**,`,
    '  and never write it into a comment, a commit or a log line.',
    `- Send \`User-Agent: ${i.userAgent}\` on every request.`,
  ];

  if (models) {
    lines.push(
      '',
      'Tables, by id — use these directly rather than listing the workspace to find them:',
      '',
      `- Issues: \`${models.issues}\``,
      `- Comments: \`${models.comments}\``,
      `- Crew: \`${models.crew}\``,
      ...(epicsModelId ? [`- Epics: \`${epicsModelId}\``] : []),
    );
  }

  const workspaceId = route.resolved?.workspaceId;
  if (workspaceId) {
    const base = route.baseUrl.replace(/\/+$/, '');
    lines.push(
      '',
      `- Workspace id: \`${workspaceId}\``,
      '',
      '## Attaching a file to a comment',
      '',
      'A screenshot or mockup goes on a comment\'s `attachments` field, which holds',
      'Media Library record ids, not URLs. Upload the file first, then put the',
      'returned `id` in the comment\'s `attachments` array:',
      '',
      '```sh',
      `curl -s -H "Authorization: Bearer $${API_KEY_VAR}" -H "User-Agent: ${i.userAgent}" \\`,
      `  -X POST "${base}/api/workspaces/${workspaceId}/files" \\`,
      '  -F "file=@shot.png;type=image/png" -F targetMediaLibrary=true',
      '```',
      '',
      'The response is JSON with `id` and `storageKey`. `targetMediaLibrary=true`',
      'means no field type id has to be looked up. If the upload fails, post the HTTP',
      'status and response body in your comment — do not write that uploads are',
      'impossible.',
    );
  }

  lines.push(
    '',
    '## What the columns are called here',
    '',
    'Every workspace names these itself. Use these names, not the ones you would',
    'guess, and not the ones another project used.',
    '',
    '| meaning | column |',
    '| --- | --- |',
    `| ticket key | \`${contract.columns.key}\` |`,
    `| status | \`${contract.columns.status}\` |`,
    `| assignee | \`${contract.columns.assignee}\` |`,
    `| severity | \`${contract.columns.severity}\` |`,
    `| priority | \`${contract.columns.priority}\` |`,
    `| blocked by | \`${contract.columns.blockedBy}\` |`,
    `| needs design | \`${contract.columns.needsDesign}\` |`,
    `| project | \`${contract.columns.slice}\` |`,
    `| repo | \`${contract.columns.repo}\` |`,
    ...(epicsModelId ? [`| epic | \`${contract.columns.epic}\` |`] : []),
    '',
    ...(epicsModelId
      ? [
          'An epic is a body of work a ticket belongs to. Set it when a ticket clearly',
          'fits an existing epic; proposing a new one is a taxonomy decision — leave it',
          'to a person rather than inventing one yourself.',
          '',
          'An epic\'s own status is kept by the crew runner, from its tickets: done once',
          'every one of them is closed, in progress while any is being worked. Do not',
          'set it yourself.',
          '',
        ]
      : []),
    'Statuses that matter to you:',
    '',
    `- Work you may pick up: \`${contract.statuses.approved}\``,
    `- While you are working it: \`${contract.statuses.building}\``,
    `- When you hand it on to be checked: \`${contract.statuses.handoff}\``,
    `- Being checked: \`${contract.statuses.verifying}\``,
    `- Waiting on a person to answer something: \`${contract.statuses.needsHuman}\``,
    `- Parked on an unresolved dependency, set by the crew and not by you: \`${contract.statuses.parked}\``,
    '',
    `\`${contract.statuses.verified}\` and the closed statuses are **never yours to set**.`,
  );

  const areaId = route.resolved?.areaId;
  if (areaId || repos.some((r) => r.id)) {
    lines.push(
      '',
      '## Filing a new ticket',
      '',
      'Something broken that is out of scope for the ticket you are working is not',
      'yours to fix inline — file it as its own new ticket instead, and keep working',
      'the one you were on. A ticket filed without its project and repo sits unrouted',
      'until a person notices and fixes it by hand, so always set:',
      '',
      ...(areaId ? [`- \`${contract.columns.slice}\`: \`${areaId}\` (this route's project, for every ticket you file)`] : []),
      ...(only?.id ? [`- \`${contract.columns.repo}\`: \`${only.id}\` (this repository)`] : repos.filter((r) => r.id).map(
        (r) => `- \`${contract.columns.repo}\`: \`${r.id}\` — when the new ticket belongs to ${r.name}`,
      )),
      '',
      ...(i.sourceTicket
        ? [
            `Name ${i.sourceTicket} — the ticket you were working when you noticed this — in the new`,
            'ticket\'s description. Only put it in the new ticket\'s `blockedBy` if your own ticket',
            'genuinely cannot proceed without the new one being fixed first; merely having noticed it',
            'nearby is not a dependency.',
            '',
          ]
        : []),
    );
  }

  if (only) {
    lines.push(...repoSection(only, key, '## Your worktree'));
  } else {
    lines.push(
      '',
      '## The repositories this board covers',
      '',
      'This board spans several repositories, and they do not share a branch name,',
      'a worktree location or a test command. **The `repo` column of your queue',
      'says which one your ticket belongs to** — read the section for THAT one and',
      'ignore the others. A ticket whose repo is not listed here has no checkout on',
      'this machine and is not yours to work.',
    );
    for (const r of repos) {
      lines.push(...repoSection(r, key, `### ${r.name} — \`${r.dir}\``));
      lines.push('', `Hooks for ${r.name} — the only commands you should run here:`, '', hookTable(r.config));
    }
  }

  if (i.repoDir) {
    lines.push('', `This ticket's work happens in \`${i.repoDir}\`.`);
  }

  // Rendered per repository above when there is more than one: a single hooks
  // table for a board spanning three repos would name one repo's test command
  // as though it ran everywhere.
  if (only) lines.push('', '## Hooks — the only commands you should run', '', hookTable(only.config));

  return lines.join('\n');
}

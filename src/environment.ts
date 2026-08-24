/**
 * The Environment block — everything a brief used to have to hard-code.
 *
 * The prompts under `prompts/` are shared by every project the crew is ever
 * pointed at, so they may not contain a path, a shell command, an id or a
 * person's name (ISSUE-293). What they CAN do is refer to things by role:
 * "the setup hook", "your worktree", "the Issues table". This module renders
 * what those refer to, for this connection and this repository, and the crew
 * injects it above the brief at run time.
 *
 * Everything here is derived. Nothing in this file knows what project it is
 * describing, which is the property that makes the briefs portable.
 */

import type { Connection } from './config.ts';
import type { EffectiveRepoConfig, RepoHooks } from './repo-config.ts';
import type { Contract } from './contract.ts';
import { renderBranchName } from './repo-config.ts';

/** The environment variable the crew hands the session its tracker key in. */
export const API_KEY_VAR = 'CREW_API_KEY';

export interface EnvironmentInput {
  conn: Connection;
  /** From the ship: one identity for everything this machine sends. */
  userAgent: string;
  repo: EffectiveRepoConfig;
  contract: Contract;
  /** Where this ticket's work happens, when the cycle knows it. */
  repoDir?: string | null;
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
 * A worked example of this repo's branch name, using a real ticket key.
 *
 * The template alone is not enough: `{number}` and `{key}` are easy to
 * transpose, and a brief that says "substitute the placeholders" invites
 * exactly that mistake. Showing the answer for a concrete ticket removes the
 * substitution step.
 */
function branchExample(repo: EffectiveRepoConfig, key: string): string {
  return renderBranchName(repo.branch.name, { key, title: 'Fix the widget', role: 'dev' });
}

export function renderEnvironment(i: EnvironmentInput): string {
  const { conn, repo, contract } = i;
  const models = conn.resolved?.models;
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
    `- Base URL: \`${conn.baseUrl}\``,
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
    '',
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
    '',
    '## Your worktree',
    '',
    `- Cut it from \`${repo.branch.base}\`, beside the checkout, at`,
    `  \`../${conn.worktreePrefix}<number>\`.`,
    `- Name the branch the way this repository names branches: \`${repo.branch.name}\``,
    `  — for ${key} that is \`${branchExample(repo, key)}\`.`,
    '- Never work in the main checkout. It is the operator\'s, and the release phase',
    '  uses it.',
  );

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

  if (i.repoDir) {
    lines.push('', `This ticket's work happens in \`${i.repoDir}\`.`);
  }

  lines.push('', '## Hooks — the only commands you should run', '', hookTable(repo));

  return lines.join('\n');
}

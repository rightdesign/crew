/**
 * `crew sample-ticket` (CREW-2242): a throwaway sandbox repo and one ticket
 * that walks the whole dev -> QA -> release loop, so a new operator can watch
 * what the crew does before pointing it at real work.
 *
 * The pure pieces live here (file contents, the ticket body, finding a
 * route's sandbox directory, recognising a sample ticket) so they are tested
 * without git or a tracker; `cli.ts` does the git, tracker and config writes.
 *
 * The sandbox has NO remote. The release phase never pushes for a repo with no
 * remote configured (`remoteConfigured` in release-run.ts), `integrate` mode
 * has nothing to deploy, and the handoff guard treats a missing remote as
 * unverifiable rather than failed, so the loop runs entirely on local
 * branches. A sample run on a repo with a remote would be a second thing that
 * could fail for reasons unrelated to the operator's setup.
 */

import { basename, dirname, join } from 'node:path';

export const SAMPLE_REPO = 'crew-sample';

/** The Repos row's `remote` for the sandbox: the column wants `owner/repo`, and there is no real one. */
export const SAMPLE_REMOTE = `local/${SAMPLE_REPO}`;

/**
 * The line the ticket description opens with. `isSampleTicket` matches on it,
 * and `--remove` closes only tickets carrying it, so a real ticket that merely
 * mentions the sandbox is never touched.
 */
export const SAMPLE_MARKER = 'sample: true';

export const SAMPLE_CREW_YAML = `version: 1
platform: unix
branch:
  base: main
hooks:
  test: "true"
  build: "true"
release:
  mode: integrate
  versioning: none
  changelog: false
`;

export const SAMPLE_README = `# crew-sample

A throwaway repository created by \`crew sample-ticket\`. It exists so the crew
has something safe to work on: its test and build hooks always pass, it has no
remote, and \`crew sample-ticket --remove\` deletes it.
`;

/** Where the sandbox goes: beside the route's first checkout, else under the repos base path. */
export function sampleDir(existing: string[], reposBase: string, workspace: string): string {
  if (existing.length > 0) return join(dirname(existing[0]!), SAMPLE_REPO);
  return join(reposBase, workspace, SAMPLE_REPO);
}

export function isSampleDir(dir: string): boolean {
  return basename(dir) === SAMPLE_REPO;
}

export const SAMPLE_TITLE = 'Sample: add a documented `greet` function with a test';

export function sampleDescription(): string {
  return [
    SAMPLE_MARKER,
    '',
    '> This is a sample ticket filed by `crew sample-ticket` on a throwaway repository. Nothing here is real work.',
    '',
    '## What',
    '',
    'Add `greet.js` exporting `greet(name)`, which returns `Hello, <name>!` (and `Hello, world!` for no name),',
    'with a JSDoc comment, and `greet.test.js` covering both cases using `node:test`.',
    '',
    '## Acceptance',
    '',
    '- `greet("Ada")` returns `Hello, Ada!`; `greet()` returns `Hello, world!`.',
    '- The test file runs with `node --test` and passes.',
    '- Add a line to the README saying the function exists.',
    '',
    '## Notes',
    '',
    'The repo has no remote: leave the branch local. The hooks in `.crew.yaml` always pass, so QA is checking the',
    'diff against the acceptance list above.',
  ].join('\n');
}

export function isSampleTicket(description: string | null | undefined): boolean {
  return (description ?? '').trimStart().startsWith(SAMPLE_MARKER);
}

export interface SampleTicketInput {
  /** The Projects row the route serves. */
  projectId: string;
  /** The sandbox's Repos row. */
  repoId: string;
  /** The contract's approved status (`accepted`). */
  approvedStatus: string;
  /** The filer's Crew row, when the ship has one. */
  filedBy?: string;
}

/** The fields for the one ticket: approved, unassigned, routed to the sandbox's Repos row. */
export function planSampleTicket(i: SampleTicketInput): Record<string, unknown> {
  return {
    title: SAMPLE_TITLE,
    description: sampleDescription(),
    report_type: 'feature',
    severity: 's4',
    reporter_name: 'crew sample-ticket',
    status: i.approvedStatus,
    project_id: i.projectId,
    repo_id: i.repoId,
    ...(i.filedBy ? { filed_by_id: i.filedBy } : {}),
  };
}

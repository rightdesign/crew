import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEnvironment, type EnvironmentRepo } from '../src/environment.ts';
import { resolveRepoConfig, parseRepoConfig } from '../src/repo-config.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import type { Route } from '../src/config.ts';

const route = {
  name: 'synthesis', enabled: true, workspace: 'issues', dir: '/w/synthesis',
  repos: {}, worktreePrefix: 'synthesis-issue-', platform: 'unix',
  baseUrl: 'https://board.example', hooks: {}, labels: {},
  release: {}, contract: undefined,
} as unknown as Route;

const repo = (name: string, dir: string, yaml: string): EnvironmentRepo => ({
  name, dir,
  config: resolveRepoConfig(parseRepoConfig(yaml, '.crew.yaml'), undefined, dir),
});

const SYN = 'version: 1\nhooks:\n  test: pnpm test\n  build: pnpm build\n  deploy: ./ship.sh\n';
const CREW = 'version: 1\nrelease:\n  mode: integrate\nhooks:\n  test: node --test\n  build: tsc --noEmit\n';

const render = (repos: EnvironmentRepo[]) =>
  renderEnvironment({ route, userAgent: 'crew/1', repos, contract: DEFAULT_CONTRACT });

test('one repo reads exactly as it always did', () => {
  const out = render([repo('synthesis', '/w/synthesis', SYN)]);
  assert.match(out, /## Your worktree/);
  assert.match(out, /## Hooks — the only commands you should run/);
  assert.doesNotMatch(out, /## The repositories this board covers/);
});

// ISSUE-350. The environment is built before the session picks its ticket, so
// it cannot know which repo applies — it has to describe them all. Rendering
// only the route's first told a crew ticket to cut
// `../synthesis-issue-350` and to run Synthesis's test command.
test('several repos each get their own worktree name, branch and hooks', () => {
  const out = render([
    repo('synthesis', '/w/synthesis', SYN),
    repo('crew', '/w/crew', CREW),
  ]);
  assert.match(out, /## The repositories this board covers/);
  assert.match(out, /### synthesis — `\/w\/synthesis`/);
  assert.match(out, /### crew — `\/w\/crew`/);
  // Each repo's worktrees are named after that repo, not after the route.
  assert.match(out, /`\.\.\/synthesis-issue-<number>`/);
  assert.match(out, /`\.\.\/crew-issue-<number>`/);
  assert.doesNotMatch(out, /`\.\.\/synthesis-issue-<number>`[\s\S]*### crew[\s\S]*`\.\.\/synthesis-issue-<number>`/);
  // And so are its commands: one hooks table for the board would name one
  // repo's test command as though it ran everywhere.
  assert.match(out, /Hooks for synthesis/);
  assert.match(out, /Hooks for crew/);
  assert.match(out, /`node --test`/);
  assert.match(out, /`pnpm test`/);
  // The queue is what says which section applies.
  assert.match(out, /`repo` column of your queue/);
});

// ISSUE-384. A workspace with no Epics table renders exactly as it does
// today — no mention of epics, no error — since `resolved.epicsModelId` is
// simply absent for it.
test('a workspace with no Epics table says nothing about epics', () => {
  const out = render([repo('synthesis', '/w/synthesis', SYN)]);
  assert.doesNotMatch(out, /epic/i);
});

test('a workspace with an Epics table lists it by id and names the column', () => {
  const withEpics = {
    ...route,
    resolved: {
      models: { issues: 'i', comments: 'c', crew: 'w' },
      epicsModelId: 'epics-model-id',
      seats: {}, operator: 'op', holds: [],
    },
  } as unknown as Route;
  const out = renderEnvironment({
    route: withEpics, userAgent: 'crew/1',
    repos: [repo('synthesis', '/w/synthesis', SYN)], contract: DEFAULT_CONTRACT,
  });
  assert.match(out, /- Epics: `epics-model-id`/);
  assert.match(out, /\| epic \| `epic_id` \|/);
  assert.match(out, /An epic is a body of work a ticket belongs to/);
});

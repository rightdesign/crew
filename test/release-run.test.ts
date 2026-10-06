import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRelease, summarizeOutcome, emitReleaseSummary, type ReleaseOutcome } from '../src/release-run.ts';
import { git } from '../src/git.ts';
import { parseRepoConfig, resolveRepoConfig } from '../src/repo-config.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import { Emitter } from '../src/events.ts';
import type { Ticket } from '../src/tracker.ts';

const T = (issue_id: string, over: Partial<Ticket> = {}): Ticket =>
  ({ id: issue_id, issue_id, status: 'verified', updated_at: '2026-08-23T00:00:00Z', ...over }) as Ticket;

/** A bare repository standing in for the forge `origin` points at. */
function bareRemote() {
  const bare = mkdtempSync(join(tmpdir(), 'crew-rel-bare-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare, stdio: 'pipe' });
  return bare;
}

/**
 * Same as `project()`, but `origin` is a real bare repository the crew can
 * push to — for exercising `ci_manual`/`ci_auto`, where the tag push is the
 * whole point. Takes the bare path rather than creating one, since a
 * `hooks.released` script that watches it needs the path before the project
 * (and its config) exist.
 */
function projectWithRemote(crewYaml: string, bare: string) {
  const p = project(crewYaml);
  p.g('remote', 'add', 'origin', bare);
  p.g('push', '-q', 'origin', 'main');
  return p;
}

/** A repo with a version, a changelog, and a verified branch ready to merge. */
function project(crewYaml: string) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-rel-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.2.3' }, null, 2));
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.3 — 2026-01-01\n\n- Older\n');
  g('add', '.'); g('commit', '-qm', 'base');
  g('tag', '-a', 'v1.2.3', '-m', 'Release v1.2.3');

  g('checkout', '-qb', 'issue-7');
  writeFileSync(join(dir, 'feature.txt'), 'x'); g('add', '.');
  g('commit', '-qm', 'built it\n\nChangelog: Records can now be starred\nBump: minor');
  g('checkout', '-q', 'main');

  const repo = resolveRepoConfig(parseRepoConfig(crewYaml, '.crew.yaml'), undefined, dir);
  return { dir, g, repo };
}

const lines: string[] = [];
const emitter = () => { lines.length = 0; return new Emitter({ route: 'c', console: (l) => lines.push(l), cycleId: 'C' }); };

const LOCAL = `version: 1
hooks:
  test: exit 0
  build: exit 0
  deploy: exit 0
`;

test('a dry run changes absolutely nothing', async () => {
  const { dir, repo, g } = project(LOCAL);
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')],
    emit: emitter(), dryRun: true,
  });
  assert.equal(out.merged.length, 1);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(), before);
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '1.2.3');
  assert.match(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), /## 1\.2\.3/);
  assert.equal(execFileSync('git', ['tag', '--list'], { cwd: dir, encoding: 'utf8' }).trim(), 'v1.2.3');
  assert.ok(lines.some((l) => /would squash-merge issue-7/.test(l)));
});

test('a real release merges, bumps, changelogs, deploys and tags', async () => {
  const { dir, repo } = project(LOCAL);
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')],
    emit: emitter(), dryRun: false,
  });
  assert.equal(out.merged.length, 1);
  assert.equal(out.version, '1.3.0');            // Bump: minor was honoured
  assert.equal(out.tag, 'v1.3.0');
  assert.equal(out.deployed, true);
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '1.3.0');
  const log = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(log, /## \[1\.3\.0\]/);
  assert.match(log, /- Records can now be starred/);
  assert.ok(log.indexOf('1.3.0') < log.indexOf('1.2.3'));   // newest first
  assert.match(execFileSync('git', ['tag', '--list'], { cwd: dir, encoding: 'utf8' }), /v1\.3\.0/);
  // the ticket key is on the integration branch — closure depends on it
  assert.match(execFileSync('git', ['log', '--format=%B', '-3'], { cwd: dir, encoding: 'utf8' }), /ISSUE-7/);
  // the merge candidate carries the sha of its own squash commit (ISSUE-218)
  assert.match(out.merged[0]!.sha ?? '', /^[0-9a-f]{40}$/);
});

test('a dry run reports no sha — nothing was actually committed', async () => {
  const { dir, repo } = project(LOCAL);
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')],
    emit: emitter(), dryRun: true,
  });
  assert.equal(out.merged.length, 1);
  assert.equal(out.merged[0]!.sha, undefined);
});

test('hooks.setup runs before the test gate, so a fresh checkout has its dependencies (CREW-1323)', async () => {
  // test passes only if setup has already created the marker file
  const yaml = LOCAL.replace('test: exit 0', 'test: test -f .installed')
    .replace('hooks:\n', 'hooks:\n  setup: touch .installed\n');
  const { dir, repo } = project(yaml);
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.notEqual(out.stopped, 'tests failed');
  assert.equal(out.stopped, undefined);
  assert.ok(existsSync(join(dir, '.installed')));
});

test('a failing hooks.setup stops as "setup failed", not as a test failure (CREW-1323)', async () => {
  const yaml = LOCAL.replace('hooks:\n', 'hooks:\n  setup: exit 3\n');
  const { dir, repo } = project(yaml);
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.stopped, 'setup failed');
  assert.equal(out.version, undefined);
  assert.ok(lines.some((l) => /setup FAILED/.test(l)));
  assert.equal(summarizeOutcome(out, 'r/x', false).outcome, 'nothing');
});

test('a failing hooks.setup hands its output tail to the outcome, so the alert can show it (CREW-1396)', async () => {
  const yaml = LOCAL.replace('hooks:\n', 'hooks:\n  setup: "echo oops-datasource-url >&2; exit 3"\n');
  const { dir, repo } = project(yaml);
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.hookFailure?.hook, 'setup');
  assert.match(out.hookFailure?.tail ?? '', /oops-datasource-url/);
});

test('a red test gate stops everything before the version moves', async () => {
  const { dir, repo } = project(LOCAL.replace('test: exit 0', 'test: exit 1'));
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.stopped, 'tests failed');
  assert.equal(out.version, undefined);
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '1.2.3');
  assert.doesNotMatch(execFileSync('git', ['tag', '--list'], { cwd: dir, encoding: 'utf8' }), /v1\.3\.0/);
  assert.ok(lines.some((l) => /test gate FAILED/.test(l)));
});

test('a worker-crash-shaped test failure is retried once, and a clean retry proceeds', async () => {
  const { dir, repo } = project(LOCAL.replace('test: exit 0', `test: |
    if [ -f .test-ran-once ]; then exit 0; else touch .test-ran-once; echo "A jest worker process was terminated by another process: signal=SIGSEGV"; exit 1; fi`));
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.stopped, undefined);
  assert.equal(out.deployed, true);
  assert.ok(lines.some((l) => /looks like a worker crash.*retrying once/.test(l)));
});

test('a worker-crash-shaped failure that recurs on retry still stops the release', async () => {
  const { dir, repo } = project(LOCAL.replace('test: exit 0',
    'test: echo "signal=SIGSEGV" && exit 1'));
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.stopped, 'tests failed');
  assert.ok(lines.some((l) => /looks like a worker crash.*retrying once/.test(l)));
  assert.ok(lines.some((l) => /test gate FAILED/.test(l)));
});

const INTEGRATE_NO_DEPLOY = `version: 1
hooks:
  test: exit 1
  build: exit 0
release:
  mode: integrate
  versioning: none
  changelog: false
`;

test('crew deploy skips the test gate on an integrate-mode repo with nothing to deploy', async () => {
  const { dir, repo } = project(INTEGRATE_NO_DEPLOY);
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')],
    emit: emitter(), dryRun: false, isDeployCommand: true,
  });
  assert.equal(out.integrated, true);
  assert.ok(lines.some((l) => /skipped.*nothing to ship/.test(l)));
});

test('routine release/merge still runs the test gate on an integrate-mode repo (only "crew deploy" skips it)', async () => {
  const { dir, repo } = project(INTEGRATE_NO_DEPLOY);
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')],
    emit: emitter(), dryRun: false,
  });
  assert.equal(out.stopped, 'tests failed');
  assert.ok(lines.some((l) => /test gate FAILED/.test(l)));
});

test('a failed deploy leaves no tag — the next cycle must not think it shipped', async () => {
  const { dir, repo } = project(LOCAL.replace('deploy: exit 0', 'deploy: exit 3'));
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.stopped, 'deploy failed');
  assert.equal(out.tag, undefined);
  assert.doesNotMatch(execFileSync('git', ['tag', '--list'], { cwd: dir, encoding: 'utf8' }), /v1\.3\.0/);
});

test('a failed build drops the Release commit so retries do not stack version bumps (CREW-1326)', async () => {
  const { dir, repo } = project(LOCAL.replace('build: exit 0', 'build: exit 1'));
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.stopped, 'build failed');
  const log = execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' });
  assert.doesNotMatch(log, /^Release /m);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), '');
});

test('a transient-resolve-failure-shaped build failure is retried once, and a clean retry proceeds (ISSUE-703)', async () => {
  const { dir, repo } = project(LOCAL.replace('build: exit 0', `build: |
    if [ -f .build-ran-once ]; then exit 0; else touch .build-ran-once; echo 'Error: [vite]: Rolldown failed to resolve import "react-router-dom" from "src/main.tsx".'; exit 1; fi`));
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.stopped, undefined);
  assert.equal(out.deployed, true);
  assert.ok(lines.some((l) => /transient dependency-resolution glitch.*retrying once/.test(l)));
});

test('a transient-resolve-failure-shaped build failure that recurs on retry still stops the release', async () => {
  const { dir, repo } = project(LOCAL.replace('build: exit 0',
    'build: echo "Rolldown failed to resolve import" && exit 1'));
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.stopped, 'build failed');
  assert.ok(lines.some((l) => /transient dependency-resolution glitch.*retrying once/.test(l)));
});

test('a transient-resolve-failure-shaped deploy failure is retried once, and a clean retry proceeds', async () => {
  const { dir, repo } = project(LOCAL.replace('deploy: exit 0', `deploy: |
    if [ -f .deploy-ran-once ]; then exit 0; else touch .deploy-ran-once; echo 'Could not resolve "react-router-dom"'; exit 1; fi`));
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.stopped, undefined);
  assert.equal(out.deployed, true);
  assert.ok(lines.some((l) => /transient dependency-resolution glitch.*retrying once/.test(l)));
});

test('a real build error is never retried, even if it also mentions "resolve"', async () => {
  const { dir, repo } = project(LOCAL.replace('build: exit 0', `build: |
    echo 'Failed to resolve import, and also error TS2307 Cannot find module'; exit 1`));
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.stopped, 'build failed');
  assert.ok(!lines.some((l) => /retrying once/.test(l)));
});

test('external mode does not merge, version, tag or deploy', async () => {
  const { dir, repo } = project(`version: 1
hooks:
  test: exit 0
  build: exit 0
  merged: exit 0
release:
  mode: external
  versioning: none
  tag: false
  changelog: false
`);
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.stopped, 'external');
  assert.equal(out.merged.length, 0);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(), before);
  assert.ok(lines.some((l) => /hands work off and does not release/.test(l)));

  // the merged hook was actually consulted (ISSUE-517) — not left dead like
  // before, when `external` short-circuited before detectClosure ever ran
  assert.equal(out.externalClosures?.length, 1);
  assert.equal(out.externalClosures?.[0]?.ticket.issue_id, 'ISSUE-7');
  assert.equal(out.externalClosures?.[0]?.closure.state, 'merged');
  assert.equal(out.externalClosures?.[0]?.closure.confidence, 'definitive');
});

test('external mode resolves a commit sha for a hook-confirmed merge, same as the heuristic path would', async () => {
  const bare = bareRemote();
  const { dir, repo, g } = projectWithRemote(`version: 1
hooks:
  test: exit 0
  build: exit 0
  merged: exit 0
release:
  mode: external
  versioning: none
  tag: false
  changelog: false
`, bare);

  // a human merged the PR out-of-band: squashed onto main, branch deleted —
  // exactly what the hook is telling the crew happened
  g('push', '-q', 'origin', 'issue-7');
  g('merge', '--squash', 'issue-7'); g('commit', '-qm', 'built it (ISSUE-7) (#3)');
  const squashSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  g('push', '-q', 'origin', 'main');
  g('push', '-q', 'origin', '--delete', 'issue-7');
  g('checkout', '-q', 'main');

  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.externalClosures?.[0]?.closure.state, 'merged');
  assert.equal(out.externalClosures?.[0]?.closure.mergedAt, squashSha);
});

test('external mode confirms and closes a ticket once hooks.released reports a commit that carries it', async () => {
  const bare = bareRemote();
  const { dir, repo, g } = projectWithRemote(`version: 1
hooks:
  test: exit 0
  build: exit 0
  merged: exit 0
release:
  mode: external
  tag: false
  changelog: false
`, bare);

  g('push', '-q', 'origin', 'issue-7');
  g('merge', '--squash', 'issue-7'); g('commit', '-qm', 'built it (ISSUE-7) (#3)');
  const squashSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  g('push', '-q', 'origin', 'main');
  g('push', '-q', 'origin', '--delete', 'issue-7');

  // A batched CI build often reports a commit LATER than any single ticket's
  // own merge — simulated here as another commit on top, bumping the
  // version, standing in for whatever the external pipeline does on its own.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.3.0' }, null, 2));
  g('add', '.'); g('commit', '-qm', 'release 1.3.0');
  const batchSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  g('push', '-q', 'origin', 'main');

  const withReleased = resolveRepoConfig(parseRepoConfig(`version: 1
hooks:
  test: exit 0
  build: exit 0
  merged: exit 0
  released: echo ${batchSha}
release:
  mode: external
  tag: false
  changelog: false
  verify: { timeoutSeconds: 5, intervalSeconds: 1 }
`, '.crew.yaml'), undefined, dir);

  const out = await runRelease({
    cwd: dir, repo: withReleased, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.externalClosures?.[0]?.closure.mergedAt, squashSha);
  assert.equal(out.externalClosures?.[0]?.confirmed, true);
  assert.equal(out.externalClosures?.[0]?.version, '1.3.0');
});

test('external mode leaves a landed ticket unconfirmed when the released commit does not carry it', async () => {
  const bare = bareRemote();
  const { dir, repo, g } = projectWithRemote(`version: 1
hooks:
  test: exit 0
  build: exit 0
  merged: exit 0
release:
  mode: external
  versioning: none
  tag: false
  changelog: false
`, bare);

  g('push', '-q', 'origin', 'issue-7');
  g('merge', '--squash', 'issue-7'); g('commit', '-qm', 'built it (ISSUE-7) (#3)');
  const squashSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  g('push', '-q', 'origin', 'main');
  g('push', '-q', 'origin', '--delete', 'issue-7');

  // A genuinely unrelated history — an orphan branch, so it shares no commit
  // with main and is not an ancestor of the ticket's merge or vice versa.
  g('checkout', '-q', '--orphan', 'other');
  writeFileSync(join(dir, 'other.txt'), 'x'); g('add', '.'); g('commit', '-qm', 'unrelated');
  const unrelatedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  g('checkout', '-q', 'main');

  const withReleased = resolveRepoConfig(parseRepoConfig(`version: 1
hooks:
  test: exit 0
  build: exit 0
  merged: exit 0
  released: echo ${unrelatedSha}
release:
  mode: external
  versioning: none
  tag: false
  changelog: false
  verify: { timeoutSeconds: 5, intervalSeconds: 1 }
`, '.crew.yaml'), undefined, dir);

  const out = await runRelease({
    cwd: dir, repo: withReleased, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.externalClosures?.[0]?.closure.mergedAt, squashSha);
  assert.equal(out.externalClosures?.[0]?.confirmed, false);
  assert.equal(out.externalClosures?.[0]?.version, undefined);
});

test('external mode with no hooks.released leaves confirmation untouched', async () => {
  const { dir, repo } = project(`version: 1
hooks:
  test: exit 0
  build: exit 0
  merged: exit 0
release:
  mode: external
  versioning: none
  tag: false
  changelog: false
`);

  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.externalClosures?.[0]?.closure.state, 'merged');
  assert.equal(out.externalClosures?.[0]?.confirmed, undefined);
});

test('a dirty tree refuses before anything is attempted', async () => {
  const { dir, repo } = project(LOCAL);
  writeFileSync(join(dir, 'scratch.txt'), 'x');
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.match(out.stopped!, /working tree has 1 change/);
  assert.equal(out.merged.length, 0);
});

test('the bump hook owns the version, and what it prints is used', async () => {
  const { dir, repo } = project(`version: 1
hooks:
  test: exit 0
  build: exit 0
  deploy: exit 0
  bump: |
    echo "2026.08.24"
release:
  tag: "release-{version}"
`);
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.version, '2026.08.24');   // a calendar version, not semver arithmetic
  assert.equal(out.tag, 'release-2026.08.24');
});

test('versioning: none ships without touching a version', async () => {
  const { dir, repo } = project(`version: 1
hooks: { test: "exit 0", build: "exit 0", deploy: "exit 0" }
release: { versioning: none, tag: false, changelog: false }
`);
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.merged.length, 1);
  assert.equal(out.version, undefined);
  assert.equal(out.deployed, true);
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '1.2.3');
});

test('nothing verified and nothing unreleased means nothing happens', async () => {
  const { dir, repo } = project(LOCAL);
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [], emit: emitter(), dryRun: false,
  });
  assert.equal(out.stopped, 'nothing to release');
});

test('a Bump: line on the branch survives the squash that discards it', async () => {
  // Regression: the bump was read from the merged history, where the crew's
  // own squash subject had already replaced the branch's Bump: line — so a
  // branch asking for minor silently shipped as patch.
  const { dir, repo } = project(LOCAL);
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.version, '1.3.0');
  assert.doesNotMatch(
    execFileSync('git', ['log', '--format=%B', '-2'], { cwd: dir, encoding: 'utf8' }),
    /Bump:/,
    'the squash message should not carry Bump: forward — which is why it must be read earlier',
  );
});

test('a major request is honoured as minor and reported, never silently dropped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-rel-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.2.3' }));
  g('add', '.'); g('commit', '-qm', 'base'); g('tag', '-a', 'v1.2.3', '-m', 'r');
  g('checkout', '-qb', 'issue-8');
  writeFileSync(join(dir, 'f.txt'), 'x'); g('add', '.');
  g('commit', '-qm', 'big change\n\nChangelog: Rewrote everything\nBump: major');
  g('checkout', '-q', 'main');
  const repo = resolveRepoConfig(parseRepoConfig(LOCAL + 'release: { changelog: false }\n', '.crew.yaml'), undefined, dir);
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-8')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.version, '1.3.0');   // minor, not 2.0.0
  assert.ok(lines.some((l) => /asked for a MAJOR bump.*operator's call/.test(l)));
});

/** The bits of State the release phase touches. */
function memory() {
  let failed: string | null = null;
  let blocked = 0;
  return {
    calls: { get failed() { return failed; }, get blocked() { return blocked; } },
    deployFailedSha: () => failed,
    noteDeployFailed: (sha: string) => { failed = sha; },
    clearDeployFailed: () => { failed = null; },
    blockedCount: () => blocked,
    noteBlocked: () => ++blocked,
    clearBlocked: () => { blocked = 0; },
  };
}

test('a failed deploy is remembered, and not retried on the next cycle', async () => {
  const { dir, repo } = project(LOCAL.replace('deploy: exit 0', 'deploy: exit 3'));
  const state = memory();
  const first = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false, state,
  });
  assert.equal(first.stopped, 'deploy failed');
  assert.ok(state.calls.failed, 'the failing commit should be recorded');

  // next cycle, same commit: it must not hammer the target again
  const second = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [], emit: emitter(), dryRun: false, state,
  });
  assert.equal(second.stopped, 'previous deploy failed on this commit');
  assert.ok(lines.some((l) => /not retrying until a new commit lands/.test(l)));
});

test('`crew deploy` forces past a remembered failure', async () => {
  const { dir, repo } = project(LOCAL);
  const state = memory();
  state.noteDeployFailed(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim());
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')],
    emit: emitter(), dryRun: false, state, force: true,
  });
  assert.notEqual(out.stopped, 'previous deploy failed on this commit');
});

test('a successful deploy clears the memory', async () => {
  const { dir, repo } = project(LOCAL);
  const state = memory();
  state.noteDeployFailed('some-older-commit');
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false, state,
  });
  assert.equal(out.deployed, true);
  assert.equal(state.calls.failed, null);
});

test('a persistent refusal gets LOUD rather than staying a warning', async () => {
  // ISSUE-174: refusing is correct, refusing silently is what let eight
  // commits sit unreleased behind a single untracked file.
  const { dir, repo } = project(LOCAL);
  writeFileSync(join(dir, 'scratch.txt'), 'x');   // dirty tree
  const state = memory();
  await runRelease({ cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [], emit: emitter(), dryRun: false, state });
  assert.equal(state.calls.blocked, 1);
  assert.ok(!lines.some((l) => /ERROR/.test(l)), 'one blocked cycle is normal');

  await runRelease({ cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [], emit: emitter(), dryRun: false, state });
  assert.equal(state.calls.blocked, 2);
  assert.ok(lines.some((l) => /ERROR.*blocked 2 cycles running/.test(l)));
});

test('a blocked release carries its cycle count and reason as data, from the first cycle', async () => {
  // ISSUE-399: `crew watch` folds `data` off the event stream rather than
  // parsing the rendered message, so the structured payload — not just the
  // LOUD text — has to be there on the very first (still-a-warning) cycle,
  // not only once it escalates to an error at two.
  const { dir, repo } = project(LOCAL);
  writeFileSync(join(dir, 'scratch.txt'), 'x');
  const state = memory();
  const eventDir = mkdtempSync(join(tmpdir(), 'crew-rel-events-'));
  const eventFile = join(eventDir, 'events.jsonl');
  const readEvents = () =>
    readFileSync(eventFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

  await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [], dryRun: false, state,
    emit: new Emitter({ route: 'c', eventFile, console: () => {} }),
  });
  const first = readEvents().find((e) => e.level === 'warn' && /refusing to release/.test(e.message));
  assert.equal(first?.data?.cycles, 1);
  assert.equal(typeof first?.data?.reason, 'string');

  await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [], dryRun: false, state,
    emit: new Emitter({ route: 'c', eventFile, console: () => {} }),
  });
  const second = readEvents().find((e) => e.level === 'error' && /refusing to release/.test(e.message));
  assert.equal(second?.data?.cycles, 2);
  assert.equal(typeof second?.data?.reason, 'string');
});

test('a clean release resets the blocked counter', async () => {
  const { dir, repo } = project(LOCAL);
  const state = memory();
  state.noteBlocked();
  await runRelease({ cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false, state });
  assert.equal(state.calls.blocked, 0);
});

// Both of these are regressions from a real stalled release: `git merge
// --squash` never writes MERGE_HEAD, so the old cleanup (`git merge --abort`)
// threw from inside the catch block, replaced the actual error, and crashed
// the cycle before the release phase could do anything at all.

test('a verified branch already contained in main merges as a no-op', async () => {
  const { dir, repo, g } = project(LOCAL);
  // ISSUE-8's change reaches main by another route — the exact shape of
  // ISSUE-292, whose fix arrived incidentally with ISSUE-309.
  g('checkout', '-qb', 'issue-8');
  writeFileSync(join(dir, 'dup.txt'), 'same'); g('add', '.');
  g('commit', '-qm', 'fixed it\n\nChangelog: Fixed the thing');
  g('checkout', '-q', 'main');
  writeFileSync(join(dir, 'dup.txt'), 'same'); g('add', '.');
  g('commit', '-qm', 'someone else fixed it first');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-8')],
    emit: emitter(), dryRun: false, skipTests: true,
  });

  // Merged, because the work IS on main — the ticket must go on to be stamped
  // and closed rather than sitting at `verified` forever.
  assert.equal(out.merged.length, 1);
  assert.equal(out.merged[0]!.sha, undefined);   // no commit was written for it
  assert.ok(lines.some((l) => /issue-8 is already contained/.test(l)));
  // ...and no empty commit was manufactured to represent it. HEAD does move —
  // the release's own version-bump commit lands on top — so what matters is
  // that nothing new claims to close ISSUE-8.
  const log = execFileSync('git', ['log', '--oneline', `${head}..HEAD`], { cwd: dir, encoding: 'utf8' });
  assert.doesNotMatch(log, /ISSUE-8|issue-8/);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim(), '');
});

test('a verified branch merged onto main out-of-band, then brought current by merging main back in, still merges as a no-op', async () => {
  // ISSUE-397: found QA-verifying ISSUE-346, where the branch's content
  // landed on main through a manual squash-merge outside the normal release
  // flow, and a later merge-conflict bounce brought the branch current by
  // merging main INTO it (rather than rebasing) — leaving the branch's tree
  // byte-identical to main's tip, so `git merge --squash` stages nothing.
  // Distinct from the sibling test above (independently-identical commits on
  // each side): here the branch's own history actually contains main's tip,
  // via a real merge commit.
  const { dir, repo, g } = project(LOCAL);
  g('checkout', '-qb', 'issue-346');
  writeFileSync(join(dir, 'feature2.txt'), 'x'); g('add', '.');
  g('commit', '-qm', 'built it\n\nChangelog: Widgets can now be starred\nBump: minor');

  // Someone squash-merges the branch onto main by hand, outside the release
  // phase — exactly what happened to ISSUE-346.
  g('checkout', '-q', 'main');
  g('merge', '--squash', 'issue-346');
  g('commit', '-qm', 'manually landed issue-346');

  // A later merge-conflict bounce brings the branch current by merging main
  // back in, rather than rebasing — the branch's tree is now identical to
  // main's.
  g('checkout', '-q', 'issue-346');
  g('merge', '-q', '-m', 'merge main back in', 'main');
  assert.equal(
    execFileSync('git', ['diff', 'main', 'issue-346'], { cwd: dir, encoding: 'utf8' }).trim(),
    '',
    'branch tree must be byte-identical to main before exercising the release',
  );

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  g('checkout', '-q', 'main');

  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-346')],
    emit: emitter(), dryRun: false, skipTests: true,
  });

  // Merged, because the work IS on main — the ticket must go on to be
  // stamped rather than sitting at `verified` forever, and its Changelog/Bump
  // trailers are still honoured even though the squash staged nothing.
  assert.equal(out.merged.length, 1);
  assert.ok(lines.some((l) => /issue-346 is already contained/.test(l)));
  const log = execFileSync('git', ['log', '--oneline', `${head}..HEAD`], { cwd: dir, encoding: 'utf8' });
  assert.doesNotMatch(log, /Closes ISSUE-346/);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim(), '');
});

test('a verified ticket with no branch and no commit on the base is carried out as unbuildable', async () => {
  // ISSUE-379: nobody ever built ISSUE-345, and nothing named its key on
  // main either — the `never-built` shape the release cannot place.
  const { dir, repo } = project(LOCAL);

  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-345')],
    emit: emitter(), dryRun: false, skipTests: true,
  });

  assert.equal(out.merged.length, 0);
  assert.equal(out.unbuildable?.length, 1);
  assert.equal(out.unbuildable![0]!.ticket.issue_id, 'ISSUE-345');
  assert.ok(lines.some((l) => /nothing to merge/.test(l)));
});

test('a verified ticket already merged under a commit that names it is NOT unbuildable', async () => {
  // The `already-merged` sibling: it resolves itself once a release stamps
  // it, and must not be reported the same way as a genuinely stranded one.
  const { dir, repo, g } = project(LOCAL);
  g('commit', '--allow-empty', '-qm', 'landed by hand, mentions ISSUE-345 in the body');

  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-345')],
    emit: emitter(), dryRun: false, skipTests: true,
  });

  assert.equal(out.unbuildable?.length ?? 0, 0);
  assert.ok(lines.some((l) => /already merged/.test(l)));
});

test('a conflicting branch is reported and rewound, not thrown', async () => {
  const { dir, repo, g } = project(LOCAL);
  g('checkout', '-qb', 'issue-9');
  writeFileSync(join(dir, 'contested.txt'), 'theirs'); g('add', '.');
  g('commit', '-qm', 'theirs');
  g('checkout', '-q', 'main');
  writeFileSync(join(dir, 'contested.txt'), 'ours'); g('add', '.');
  g('commit', '-qm', 'ours');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-9')],
    emit: emitter(), dryRun: false, skipTests: true,
  });

  assert.equal(out.merged.length, 0);
  assert.ok(lines.some((l) => /could not merge issue-9/.test(l)));
  // The checkout is left as it was found: no conflict markers staged, nothing
  // half-applied for the next candidate to build on. (HEAD itself still moves
  // — there were unreleased commits, so the release bumps regardless.)
  const log = execFileSync('git', ['log', '--oneline', `${head}..HEAD`], { cwd: dir, encoding: 'utf8' });
  assert.doesNotMatch(log, /ISSUE-9|issue-9/);
  assert.equal(readFileSync(join(dir, 'contested.txt'), 'utf8'), 'ours');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim(), '');
});

test('a git failure reported on stdout still names its cause', async () => {
  const { dir } = project(LOCAL);
  // `git commit` with an empty index writes its complaint to stdout, not
  // stderr — reading only stderr left the release phase saying "Command
  // failed" with nothing to act on.
  assert.throws(
    () => git(dir, ['commit', '-m', 'nothing here']),
    /nothing to commit/,
  );
});

test('a cycle of nothing but no-op merges cuts no version at all', () => {
  // ISSUE-342. A no-op merge counted as "1 merged" and drove the full
  // sequence — bump, changelog, build, deploy, tag — producing a release
  // whose entire diff was its own version bump. Twice.
  return (async () => {
    const { dir, repo, g } = project(LOCAL);
    g('checkout', '-qb', 'issue-8');
    writeFileSync(join(dir, 'dup.txt'), 'same'); g('add', '.'); g('commit', '-qm', 'fixed it');
    g('checkout', '-q', 'main');
    // The change reaches main by another route, and main is already released.
    writeFileSync(join(dir, 'dup.txt'), 'same'); g('add', '.'); g('commit', '-qm', 'someone else did it');
    g('tag', '-a', 'v1.3.0', '-m', 'Release v1.3.0');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

    const out = await runRelease({
      cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-8')],
      emit: emitter(), dryRun: false, skipTests: true,
    });

    // Merged and live — so the ticket must still be stamped...
    assert.equal(out.merged.length, 1);
    assert.equal(out.alreadyLive, true);
    assert.equal(out.version, '1.3.0');       // the release that actually carried it
    // ...but nothing was cut: no commit, no bump, no new tag.
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(), head);
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '1.2.3');
    assert.equal(out.deployed, false);
    assert.ok(lines.some((l) => /already contained in main/.test(l)));
  })();
});

test('a real merge alongside a no-op still releases normally', () => {
  // The over-correction to avoid: one branch that genuinely changes something
  // must still ship, and the no-op riding along with it must still be stamped.
  return (async () => {
    const { dir, repo, g } = project(LOCAL);      // project() leaves issue-7 with a real change
    g('checkout', '-qb', 'issue-8');
    writeFileSync(join(dir, 'dup.txt'), 'same'); g('add', '.'); g('commit', '-qm', 'fixed it');
    g('checkout', '-q', 'main');
    writeFileSync(join(dir, 'dup.txt'), 'same'); g('add', '.'); g('commit', '-qm', 'someone else did it');

    const out = await runRelease({
      cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7'), T('ISSUE-8')],
      emit: emitter(), dryRun: false, skipTests: true,
    });

    assert.equal(out.merged.length, 2);
    assert.ok(!out.alreadyLive, 'a real change was merged — this is a normal release');
    assert.equal(out.deployed, true);
    assert.notEqual(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '1.2.3');
  })();
});

test('an untagged repo with nothing merged does not run the gate every cycle', () => {
  // `upToDate` is `lastReleased === head`, so a repo that has never been
  // tagged reports "not up to date" forever. That is indistinguishable from
  // genuinely-unshipped work, and the release proceeded on it: an untagged
  // repo with `versioning: none` ran its whole test suite and build on every
  // cycle — every two minutes — merging nothing and stamping nothing.
  return (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-untagged-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
    writeFileSync(join(dir, 'a'), '1'); g('add', '.'); g('commit', '-qm', 'base');
    // No tag anywhere, which is the permanent state of `versioning: none`.
    const repo = resolveRepoConfig(parseRepoConfig([
      'version: 1',
      'hooks:', '  test: exit 1', '  build: exit 1',   // running either is the bug
      'release:', '  mode: integrate', '  versioning: none', '  changelog: false',
    ].join('\n'), '.crew.yaml'), undefined, dir);

    const out = await runRelease({
      cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [], emit: emitter(), dryRun: false,
    });
    assert.equal(out.stopped, 'nothing merged and no release marker');
    assert.ok(!out.integrated);
    // The gate would have failed loudly if it ran — so a clean stop proves it did not.
    assert.ok(lines.some((l) => /no release tag to compare against/.test(l)));
  })();
});

test('...but an untagged repo DOES release once something merges', () => {
  // The "releases forward from here" behaviour has to survive the guard: a
  // brand-new repo's first verified merge is a real release.
  return (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-untagged2-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
    writeFileSync(join(dir, 'a'), '1'); g('add', '.'); g('commit', '-qm', 'base');
    g('checkout', '-qb', 'issue-7');
    writeFileSync(join(dir, 'f'), 'x'); g('add', '.'); g('commit', '-qm', 'built it');
    g('checkout', '-q', 'main');
    const repo = resolveRepoConfig(parseRepoConfig([
      'version: 1',
      'hooks:', '  test: exit 0', '  build: exit 0',
      'release:', '  mode: integrate', '  versioning: none', '  changelog: false',
    ].join('\n'), '.crew.yaml'), undefined, dir);

    const out = await runRelease({
      cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
    });
    assert.equal(out.merged.length, 1);
    assert.equal(out.integrated, true);
  })();
});

test('ci_manual pushes the release tag to the remote before confirming', () => {
  return (async () => {
    const bare = bareRemote();
    const { dir, repo } = projectWithRemote(`version: 1
hooks:
  test: exit 0
  build: exit 0
  released: git --git-dir="${bare}" for-each-ref --sort=-creatordate --format='%(*objectname)' refs/tags | head -1
release:
  mode: ci_manual
  ci: { provider: github }
  verify: { timeoutSeconds: 5, intervalSeconds: 1 }
`, bare);
    const out = await runRelease({
      cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
    });
    assert.equal(out.tag, 'v1.3.0');
    // proves the push reached the remote, not just the local repo
    assert.match(
      execFileSync('git', ['--git-dir', bare, 'tag', '--list'], { encoding: 'utf8' }),
      /v1\.3\.0/,
    );
    assert.equal(out.confirmed, true);
    assert.ok(lines.some((l) => /pushed tag v1\.3\.0 to origin/.test(l)));
  })();
});

const CI_VERSION = (bare: string, file: string) => `version: 1
hooks:
  test: exit 0
  build: exit 0
  released: cat ${file} 2>/dev/null || true
release:
  mode: ci_auto
  ci: { provider: github }
  verify: { match: version, timeoutSeconds: 1, intervalSeconds: 1 }
`;

test('verify.match: version confirms against the bumped version, not the HEAD sha', () => {
  return (async () => {
    const bare = bareRemote();
    const file = join(mkdtempSync(join(tmpdir(), 'crew-live-')), 'live');
    writeFileSync(file, '1.3.0\n');
    const { dir, repo } = projectWithRemote(CI_VERSION(bare, file), bare);
    const out = await runRelease({
      cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
    });
    assert.equal(out.version, '1.3.0');
    assert.equal(out.confirmed, true);
  })();
});

test('verify.match: version stays unconfirmed while the registry reports the old version', () => {
  return (async () => {
    const bare = bareRemote();
    const file = join(mkdtempSync(join(tmpdir(), 'crew-live-')), 'live');
    writeFileSync(file, '1.2.3\n');
    const { dir, repo } = projectWithRemote(CI_VERSION(bare, file), bare);
    const out = await runRelease({
      cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
    });
    assert.equal(out.confirmed, false);
  })();
});

test('a ci_* release whose confirm timed out is re-confirmed on a later cycle, then stamped', () => {
  return (async () => {
    const bare = bareRemote();
    const file = join(mkdtempSync(join(tmpdir(), 'crew-live-')), 'live');
    writeFileSync(file, '1.2.3\n');
    const { dir, repo } = projectWithRemote(CI_VERSION(bare, file), bare);
    const tickets = [T('ISSUE-7')];
    const first = await runRelease({ cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets, emit: emitter(), dryRun: false });
    assert.equal(first.confirmed, false);

    // Still not live: nothing is stamped, and the cycle says so.
    const waiting = await runRelease({ cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets, emit: emitter(), dryRun: false });
    assert.ok(!waiting.confirmed && !waiting.alreadyLive);

    // CI finishes. The next cycle has nothing new to merge, yet confirms and hands back the range to stamp.
    writeFileSync(file, '1.3.0\n');
    const later = await runRelease({ cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets, emit: emitter(), dryRun: false });
    assert.ok(later.confirmed || later.alreadyLive, `expected a stampable outcome, got ${JSON.stringify(later.stopped)}`);
    assert.equal(later.version, '1.3.0');
    assert.equal(later.tag, undefined, 'it must not cut another release');
  })();
});

test('re-confirm does not poll when no verified ticket was in the last release', () => {
  return (async () => {
    const bare = bareRemote();
    const file = join(mkdtempSync(join(tmpdir(), 'crew-live-')), 'live');
    writeFileSync(file, '1.3.0\n');
    const { dir, repo } = projectWithRemote(CI_VERSION(bare, file), bare);
    await runRelease({ cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false });
    const idle = await runRelease({ cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [], emit: emitter(), dryRun: false });
    assert.equal(idle.stopped, 'nothing to release');
    assert.equal(idle.confirmed, undefined);
  })();
});

test('local and integrate modes never push a tag, even with a remote configured', () => {
  return (async () => {
    const bare = bareRemote();
    const { dir, repo } = projectWithRemote(LOCAL, bare);
    const out = await runRelease({
      cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
    });
    assert.equal(out.tag, 'v1.3.0');
    assert.equal(execFileSync('git', ['--git-dir', bare, 'tag', '--list'], { encoding: 'utf8' }).trim(), '');
    assert.ok(!lines.some((l) => /pushed tag/.test(l)));
  })();
});

test('a real local-mode release pushes the base branch to the remote (ISSUE-635)', () => {
  return (async () => {
    const bare = bareRemote();
    const { dir, repo } = projectWithRemote(LOCAL, bare);
    const out = await runRelease({
      cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
    });
    assert.equal(out.version, '1.3.0');
    // The bare remote's own `main` must carry the merge and version-bump
    // commits — not just this ship's local checkout, which is what left
    // `origin/main` stuck behind every release before this.
    assert.match(
      execFileSync('git', ['--git-dir', bare, 'log', '--format=%B', 'main', '-1'], { encoding: 'utf8' }),
      /Release v1\.3\.0/,
    );
    assert.ok(lines.some((l) => /pushed main to origin/.test(l)));
  })();
});

test('a dry run reports the base branch push it would make, without touching the remote', () => {
  return (async () => {
    const bare = bareRemote();
    const { dir, repo } = projectWithRemote(LOCAL, bare);
    const before = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
    await runRelease({
      cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: true,
    });
    assert.ok(lines.some((l) => /would push main to origin/.test(l)));
    assert.equal(
      execFileSync('git', ['--git-dir', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), before,
    );
  })();
});

test('a repo with no remote configured is never asked to push the base branch', async () => {
  const { dir, repo } = project(LOCAL);
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.version, '1.3.0');
  assert.ok(!lines.some((l) => /push main/.test(l)));
});

test('a failed base branch push stops the release, even though the deploy already ran', () => {
  return (async () => {
    const { dir, repo } = projectWithRemote(LOCAL, bareRemote());
    // Point origin somewhere that doesn't exist rather than removing it —
    // `remoteConfigured` only asks whether a remote URL is set, so removing
    // it entirely would make the push skip as "no remote" (a different,
    // already-covered case) instead of actually failing.
    execFileSync('git', ['remote', 'set-url', 'origin', join(dir, 'no-such-remote')], { cwd: dir, stdio: 'pipe' });
    const out = await runRelease({
      cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
    });
    assert.equal(out.stopped, 'base branch push failed');
    assert.equal(out.deployed, true);   // the local deploy hook already ran and succeeded
    assert.ok(lines.some((l) => /failed to push main/.test(l)));
  })();
});

/** `git worktree list` entries (the primary checkout included), and any `crew/release-*` branches. */
const releaseLeftovers = (dir: string) => ({
  worktrees: execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' })
    .split('\n').filter((l) => l.startsWith('worktree ')).length,
  branches: execFileSync('git', ['branch', '--list', 'crew/release-*'], { cwd: dir, encoding: 'utf8' }).trim(),
});

test('a real release is cut in a temporary checkout and leaves nothing behind; the primary base only catches up (CREW-1383)', async () => {
  const bare = bareRemote();
  const { dir, repo } = projectWithRemote(LOCAL, bare);
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.version, '1.3.0');
  assert.deepEqual(releaseLeftovers(dir), { worktrees: 1, branches: '' });
  // The primary checkout's base is level with the remote it pushed to: it was
  // fast-forwarded, not released onto.
  assert.equal(
    execFileSync('git', ['rev-parse', 'main'], { cwd: dir, encoding: 'utf8' }).trim(),
    execFileSync('git', ['--git-dir', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(),
  );
});

test('a rejected base push leaves no release branch, no tag, and the primary base untouched (CREW-1383)', async () => {
  const bare = bareRemote();
  const { dir, repo } = projectWithRemote(LOCAL, bare);
  // A remote that refuses every push, so the release has to be thrown away.
  writeFileSync(join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho refused >&2\nexit 1\n', { mode: 0o755 });
  const primaryBefore = execFileSync('git', ['rev-parse', 'main'], { cwd: dir, encoding: 'utf8' }).trim();
  const remoteBefore = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.stopped, 'base branch push failed');
  assert.equal(out.tag, undefined);
  assert.equal(execFileSync('git', ['rev-parse', 'main'], { cwd: dir, encoding: 'utf8' }).trim(), primaryBefore);
  assert.equal(execFileSync('git', ['--git-dir', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), remoteBefore);
  assert.ok(!execFileSync('git', ['tag', '--list'], { cwd: dir, encoding: 'utf8' }).includes('v1.3.0'));
  assert.deepEqual(releaseLeftovers(dir), { worktrees: 1, branches: '' });
});

test('after a release the primary checkout\'s own build is re-run, so its dist/ is not stale (CREW-1383)', async () => {
  const bare = bareRemote();
  const { dir, repo } = projectWithRemote(`version: 1
hooks:
  test: exit 0
  build: mkdir -p dist && echo built > dist/marker
  deploy: exit 0
`, bare);
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.version, '1.3.0');
  assert.ok(existsSync(join(dir, 'dist', 'marker')));
});

test('a failed rebuild of the primary checkout is a warning, not a failed release (CREW-1383)', async () => {
  const bare = bareRemote();
  const once = join(mkdtempSync(join(tmpdir(), 'crew-rel-once-')), 'ran');
  const { dir, repo } = projectWithRemote(`version: 1
hooks:
  test: exit 0
  build: if [ -f ${once} ]; then exit 3; fi; touch ${once}
  deploy: exit 0
`, bare);
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.version, '1.3.0');
  assert.equal(out.stopped, undefined);
  assert.ok(lines.some((l) => /rebuilding the primary checkout after the release failed/.test(l)));
});

test('origin moving mid-release discards the release before the deploy: nothing deployed, no tag, primary untouched (CREW-1383)', async () => {
  const bare = bareRemote();
  const { dir, repo } = projectWithRemote(`version: 1
hooks:
  test: exit 0
  build: exit 0
  deploy: touch DEPLOYED
`, bare);
  // Another ship pushes while this one's build hook runs.
  const other = mkdtempSync(join(tmpdir(), 'crew-rel-other-'));
  execFileSync('git', ['clone', '-q', bare, other], { stdio: 'pipe' });
  const script = join(mkdtempSync(join(tmpdir(), 'crew-rel-hook-')), 'build.sh');
  writeFileSync(script, `#!/bin/sh
cd ${other} && git config user.email o@o && git config user.name O && echo x > other-ship.txt && git add . && git commit -qm other && git push -q origin main
`, { mode: 0o755 });
  repo.hooks.build = script;
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.stopped, 'base branch moved during release');
  assert.equal(out.deployed, false);
  assert.equal(existsSync(join(dir, 'DEPLOYED')), false);
  // The primary only caught up to the other ship's push; nothing of ours is on it.
  assert.equal(
    execFileSync('git', ['rev-parse', 'main'], { cwd: dir, encoding: 'utf8' }).trim(),
    execFileSync('git', ['--git-dir', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(),
  );
  assert.ok(!execFileSync('git', ['log', '--format=%s', 'main'], { cwd: dir, encoding: 'utf8' }).includes('Release v1.3.0'));
  assert.deepEqual(releaseLeftovers(dir), { worktrees: 1, branches: '' });
  assert.ok(!execFileSync('git', ['tag', '--list'], { cwd: dir, encoding: 'utf8' }).includes('v1.3.0'));
});

test('a release checkout stranded by a crash is cleaned up at the start of the next release (CREW-1383)', async () => {
  const bare = bareRemote();
  const { dir, repo, g } = projectWithRemote(LOCAL, bare);
  const stray = join(mkdtempSync(join(tmpdir(), 'crew-release-')), 'checkout');
  g('worktree', 'add', '-q', '-b', 'crew/release-123', stray, 'origin/main');
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.version, '1.3.0');
  assert.deepEqual(releaseLeftovers(dir), { worktrees: 1, branches: '' });
  assert.ok(lines.some((l) => /crew\/release-123/.test(l)));
});

test('a hand commit on local main is a hard stop that names the commit (CREW-1383)', async () => {
  const bare = bareRemote();
  const { dir, repo, g } = projectWithRemote(LOCAL, bare);
  writeFileSync(join(dir, 'hand.txt'), 'x'); g('add', '.'); g('commit', '-qm', 'hand edit on main');
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.match(out.stopped ?? '', /hand edit on main/);
  assert.deepEqual(releaseLeftovers(dir), { worktrees: 1, branches: '' });
});

test('a failed tag push stops the release rather than waiting on a release that was never triggered', () => {
  return (async () => {
    const { dir, repo } = projectWithRemote(`version: 1
hooks:
  test: exit 0
  build: exit 0
  released: echo nope
release:
  mode: ci_manual
  ci: { provider: github }
  verify: { timeoutSeconds: 5, intervalSeconds: 1 }
`, bareRemote());
    // Remove the remote so the push has nowhere to go.
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: dir, stdio: 'pipe' });
    const out = await runRelease({
      cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
    });
    assert.equal(out.stopped, 'tag push failed');
    assert.equal(out.confirmed, undefined);        // confirm() was never reached
    assert.ok(lines.some((l) => /failed to push tag/.test(l)));
  })();
});

test('a dry run reports the tag push it would make, without touching the remote', () => {
  return (async () => {
    const bare = bareRemote();
    const { dir, repo } = projectWithRemote(`version: 1
hooks:
  test: exit 0
  build: exit 0
  released: echo nope
release:
  mode: ci_auto
  ci: { provider: github }
`, bare);
    const out = await runRelease({
      cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: true,
    });
    assert.ok(lines.some((l) => /would push tag v1\.3\.0 to origin/.test(l)));
    assert.equal(execFileSync('git', ['--git-dir', bare, 'tag', '--list'], { encoding: 'utf8' }).trim(), '');
  })();
});

/* ── Drift: what the remote has, and what another ship has already done ── */

test('the base is fast-forwarded to the remote before anything is decided', async () => {
  const bare = bareRemote();
  const { dir, repo } = projectWithRemote(LOCAL, bare);

  // Another ship pushes to the shared base while this one is not looking.
  const other = mkdtempSync(join(tmpdir(), 'crew-rel-other-'));
  const o = (...a: string[]) => execFileSync('git', a, { cwd: other, stdio: 'pipe' });
  execFileSync('git', ['clone', '-q', bare, other], { stdio: 'pipe' });
  o('config', 'user.email', 't@t'); o('config', 'user.name', 'T');
  writeFileSync(join(other, 'from-elsewhere.txt'), 'x');
  o('add', '.'); o('commit', '-qm', 'another ship shipped this');
  o('push', '-q', 'origin', 'main');

  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')],
    emit: emitter(), dryRun: false,
  });

  assert.ok(existsSync(join(dir, 'from-elsewhere.txt')), 'the other ship\'s commit must be here');
  assert.equal(out.merged.length, 1, 'and the release still ships its own work');
  assert.ok(lines.some((l) => /fast-forwarded main/.test(l)));
});

test('a base that has diverged from the remote refuses to release', async () => {
  const bare = bareRemote();
  const { dir, repo, g } = projectWithRemote(LOCAL, bare);

  // Another ship pushes...
  const other = mkdtempSync(join(tmpdir(), 'crew-rel-other2-'));
  const o = (...a: string[]) => execFileSync('git', a, { cwd: other, stdio: 'pipe' });
  execFileSync('git', ['clone', '-q', bare, other], { stdio: 'pipe' });
  o('config', 'user.email', 't@t'); o('config', 'user.name', 'T');
  writeFileSync(join(other, 'theirs.txt'), 'x');
  o('add', '.'); o('commit', '-qm', 'theirs'); o('push', '-q', 'origin', 'main');

  // ...and this ship has a local commit of its own, so neither contains the other.
  writeFileSync(join(dir, 'ours.txt'), 'x');
  g('add', '.'); g('commit', '-qm', 'ours');

  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')],
    emit: emitter(), dryRun: false,
  });

  assert.match(out.stopped ?? '', /diverged/);
  assert.equal(out.merged.length, 0, 'nothing may merge onto a base two ships disagree about');
  assert.ok(lines.some((l) => /refusing to release/.test(l)));
});

test('a base with a local commit the remote lacks refuses to release (CREW-1379)', async () => {
  const bare = bareRemote();
  const { dir, repo, g } = projectWithRemote(LOCAL, bare);
  writeFileSync(join(dir, 'ours.txt'), 'x');
  g('add', '.'); g('commit', '-qm', 'ours');

  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')],
    emit: emitter(), dryRun: false,
  });

  assert.match(out.stopped ?? '', /1 ahead of origin\/main/);
  assert.equal(out.merged.length, 0);
});

test('a "refusing to release" message names which route/repo it is about, when told one', async () => {
  // A route with several repos produces one of these per repo per cycle —
  // with no scope, they were indistinguishable from one another (a person
  // watching the log had no way to tell which repo needed attention).
  const bare = bareRemote();
  const { dir, repo, g } = projectWithRemote(LOCAL, bare);
  const other = mkdtempSync(join(tmpdir(), 'crew-rel-other3-'));
  const o = (...a: string[]) => execFileSync('git', a, { cwd: other, stdio: 'pipe' });
  execFileSync('git', ['clone', '-q', bare, other], { stdio: 'pipe' });
  o('config', 'user.email', 't@t'); o('config', 'user.name', 'T');
  writeFileSync(join(other, 'theirs.txt'), 'x');
  o('add', '.'); o('commit', '-qm', 'theirs'); o('push', '-q', 'origin', 'main');
  writeFileSync(join(dir, 'ours.txt'), 'x');
  g('add', '.'); g('commit', '-qm', 'ours');

  await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')],
    emit: emitter(), dryRun: false, scope: 'paradium/issues/raven',
  });

  assert.ok(lines.some((l) => /paradium\/issues\/raven: refusing to release/.test(l)));
});

test('a repo with no remote at all releases exactly as before', async () => {
  const { dir, repo } = project(LOCAL);          // no origin configured
  const e = emitter();
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')],
    emit: e, dryRun: false,
  });
  assert.equal(out.merged.length, 1);
  assert.equal(out.deployed, true);
  // No remote at all is the documented, fault-free case (release.ts: "three
  // of the repos on this ship are exactly that") — warning every cycle about
  // a fetch nobody expected to succeed would train an operator to ignore the
  // warning, which is worse than not having one for a REAL fetch failure.
  assert.ok(!lines.some((l) => l.includes('could not fetch')), 'no warning for a repo synced some other way');
});

test('a remote that IS configured but genuinely unreachable still warns', async () => {
  const { dir, g, repo } = project(LOCAL);
  g('remote', 'add', 'origin', join(tmpdir(), 'crew-rel-nonexistent-remote-path'));
  const e = emitter();
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')],
    emit: e, dryRun: false,
  });
  assert.equal(out.merged.length, 1);   // still releases from what it already has
  assert.ok(lines.some((l) => l.includes('could not fetch')), 'a real fetch failure is still worth a warning');
});

test('a conflicting branch is reported rather than silently skipped', async () => {
  const { dir, repo, g } = project(LOCAL);
  // Make issue-7 and main disagree about the same file — the ISSUE-346 shape.
  g('checkout', '-q', 'issue-7');
  writeFileSync(join(dir, 'contested.txt'), 'the branch version\n');
  g('add', '.'); g('commit', '-qm', 'branch takes it');
  g('checkout', '-q', 'main');
  writeFileSync(join(dir, 'contested.txt'), 'the base version\n');
  g('add', '.'); g('commit', '-qm', 'base takes it');

  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')],
    emit: emitter(), dryRun: false,
  });

  assert.equal(out.merged.length, 0);
  assert.equal(out.conflicts?.length, 1);
  assert.equal(out.conflicts![0]!.candidate.ticket.issue_id, 'ISSUE-7');
  assert.deepEqual(out.conflicts![0]!.paths, ['contested.txt'], 'the caller needs to know WHAT disagreed');
  // and the failed merge left nothing behind
  assert.equal(git(dir, ['status', '--porcelain']), '');
});

// summarizeOutcome — the per-repo row behind the fan-out release summary
// (ISSUE-583). Pure function, no repo fixture needed: a minimal decision
// stub is enough since only `stopped`/`deployed`/`integrated`/`version`/
// `tag`/`merged` ever feed the summary.
const decisionStub = {
  block: null, merges: [], head: 'HEAD', lastTag: null, lastReleased: null,
  unreleasedCommits: 0, upToDate: false, unseeded: false,
};
const outcome = (over: Partial<ReleaseOutcome> = {}): ReleaseOutcome =>
  ({ merged: [], deployed: false, decision: decisionStub, ...over }) as ReleaseOutcome;

test('summarizeOutcome: a failed test gate reports tests FAILED, whether or not a hook is configured', () => {
  const s = summarizeOutcome(outcome({ stopped: 'tests failed' }), 'r/x', true);
  assert.equal(s.tests, 'fail');
  assert.equal(s.outcome, 'nothing');
});

test('summarizeOutcome: nothing-to-release paths never ran tests, even with a test hook configured', () => {
  for (const stopped of [
    'nothing to release', 'nothing merged and no release marker', 'already contained in the base branch',
  ] as const) {
    const s = summarizeOutcome(outcome({ stopped }), 'r/x', true);
    assert.equal(s.tests, 'skipped', stopped);
    assert.equal(s.outcome, 'nothing', stopped);
  }
});

test('summarizeOutcome: build/deploy/tag-push failures still credit a passing test gate', () => {
  for (const [stopped, want] of [
    ['build failed', 'build-failed'],
    ['deploy failed', 'deploy-failed'],
    ['tag push failed', 'tag-push-failed'],
  ] as const) {
    const s = summarizeOutcome(outcome({ stopped }), 'r/x', true);
    assert.equal(s.tests, 'pass', stopped);
    assert.equal(s.outcome, want, stopped);
  }
});

test('summarizeOutcome: no test hook at all reports tests skipped, not a false pass', () => {
  const s = summarizeOutcome(outcome({ stopped: 'build failed' }), 'r/x', false);
  assert.equal(s.tests, 'skipped');
});

test('summarizeOutcome: a real deploy reports deployed with its version in the detail', () => {
  const s = summarizeOutcome(outcome({ deployed: true, version: '1.4.0' }), 'r/x', true);
  assert.equal(s.tests, 'pass');
  assert.equal(s.outcome, 'deployed');
  assert.match(s.detail, /1\.4\.0/);
});

test('summarizeOutcome: release.mode integrate reports integrated, never deployed', () => {
  const s = summarizeOutcome(outcome({ integrated: true, version: '2.0.0' }), 'r/x', true);
  assert.equal(s.outcome, 'integrated');
});

test('summarizeOutcome: a CI push with no local deploy hook reports merged, with the tag named', () => {
  const s = summarizeOutcome(
    outcome({ confirmed: true, merged: [{}] as never, version: '1.0.1', tag: 'v1.0.1' }), 'r/x', true,
  );
  assert.equal(s.outcome, 'merged');
  assert.match(s.detail, /1 merged/);
  assert.match(s.detail, /v1\.0\.1/);
});

// ---------------------------------------------------------------------------
// emitReleaseSummary — the roll-up itself, and which route it is labelled with
// ---------------------------------------------------------------------------

test('emitReleaseSummary: rows are labelled with their own route, not the top-level emitter\'s (CREW-994)', () => {
  // A fleet-wide run stamps the top-level Emitter with routes[0]. The roll-up
  // was the one release call site CREW-979 left on that emitter, so a summary
  // entirely about `issues/issues` was labelled `paradium/issues`.
  const events: { route: string; message: string; level: string }[] = [];
  const top = new Emitter({ route: 'paradium/issues', console: () => {}, cycleId: 'C' });
  const seen = (e: Emitter) => {
    const emit = e.emit.bind(e);
    e.emit = (m, x) => { const ev = emit(m, x); events.push(ev); return ev; };
    return e;
  };
  const forRoute = top.forRoute.bind(top);
  top.forRoute = (r) => seen(forRoute(r));
  seen(top);

  const row = (route: string, name: string, over: Partial<ReturnType<typeof summarizeOutcome>> = {}) => ({
    ...summarizeOutcome(outcome({ stopped: 'nothing to release' }), `${route}/${name}`, false), route, ...over,
  });
  emitReleaseSummary(top, [
    row('issues/issues', 'synthesis'),
    row('issues/issues', 'crew', { tests: 'fail' }),
    row('other/board', 'site'),
  ]);

  assert.ok(events.length > 0);
  assert.ok(events.every((e) => e.route !== 'paradium/issues'), 'nothing is attributed to routes[0]');
  for (const e of events.filter((e) => e.message.startsWith('  '))) {
    assert.ok(e.message.trimStart().startsWith(`${e.route}/`), `${e.message} is labelled ${e.route}`);
  }
  assert.deepEqual(
    events.filter((e) => /^release summary/.test(e.message)).map((e) => [e.route, e.message]),
    [['issues/issues', 'release summary — 2 repo(s):'], ['other/board', 'release summary — 1 repo(s):']],
  );
  assert.equal(events.find((e) => /issues\/crew/.test(e.message))?.level, 'warn');
});

test('emitReleaseSummary: a single-repo release prints no roll-up', () => {
  const e = emitter();
  emitReleaseSummary(e, [{ ...summarizeOutcome(outcome({ deployed: true, version: '1.0.0' }), 'r/x', true), route: 'r' }]);
  assert.deepEqual(lines, []);
});

test('a hook exiting 127 raises hook_missing for that scope/hook, and a later clean run clears it (CREW-1373)', async () => {
  const raised: string[] = [];
  const cleared: string[] = [];
  const attention = {
    raise: (i: { key: string }) => { raised.push(i.key); },
    clear: (k: string) => { cleared.push(k); },
  };
  const bad = project(LOCAL.replace('hooks:\n', 'hooks:\n  setup: exit 127\n'));
  await runRelease({
    cwd: bad.dir, repo: bad.repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')],
    emit: emitter(), dryRun: false, scope: 'issues/crew', attention,
  });
  assert.deepEqual(raised, ['hook_missing:issues/crew/setup']);

  const ok = project(LOCAL.replace('hooks:\n', 'hooks:\n  setup: exit 0\n'));
  await runRelease({
    cwd: ok.dir, repo: ok.repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')],
    emit: emitter(), dryRun: false, scope: 'issues/crew', attention,
  });
  assert.ok(cleared.includes('hook_missing:issues/crew/setup'));
});

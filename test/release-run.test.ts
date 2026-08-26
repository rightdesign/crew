import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRelease } from '../src/release-run.ts';
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

test('a failed deploy leaves no tag — the next cycle must not think it shipped', async () => {
  const { dir, repo } = project(LOCAL.replace('deploy: exit 0', 'deploy: exit 3'));
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false,
  });
  assert.equal(out.stopped, 'deploy failed');
  assert.equal(out.tag, undefined);
  assert.doesNotMatch(execFileSync('git', ['tag', '--list'], { cwd: dir, encoding: 'utf8' }), /v1\.3\.0/);
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

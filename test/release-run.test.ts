import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRelease } from '../src/release-run.ts';
import { parseRepoConfig, resolveRepoConfig } from '../src/repo-config.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import { Emitter } from '../src/events.ts';
import type { Ticket } from '../src/tracker.ts';

const T = (issue_id: string, over: Partial<Ticket> = {}): Ticket =>
  ({ id: issue_id, issue_id, status: 'verified', updated_at: '2026-08-23T00:00:00Z', ...over }) as Ticket;

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
const emitter = () => { lines.length = 0; return new Emitter({ connection: 'c', console: (l) => lines.push(l), cycleId: 'C' }); };

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

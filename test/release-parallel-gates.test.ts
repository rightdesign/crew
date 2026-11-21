import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRelease } from '../src/release-run.ts';
import { parseRepoConfig, resolveRepoConfig } from '../src/repo-config.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import { Emitter } from '../src/events.ts';
import type { Ticket } from '../src/tracker.ts';

// CREW-3865: `release.parallelGates` runs the build gate beside the test gate.

const T = (issue_id: string): Ticket =>
  ({ id: issue_id, issue_id, status: 'verified', updated_at: '2026-08-23T00:00:00Z' }) as Ticket;

function project(crewYaml: string) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-par-'));
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
  return { dir, repo };
}

const lines: string[] = [];
const emitter = () => { lines.length = 0; return new Emitter({ route: 'c', console: (l) => lines.push(l), cycleId: 'C' }); };

const SEES = `grep -o '"version": "[^"]*"' package.json`;
const yaml = (opts: { parallel: boolean; test: string; build: string }) => `version: 1
release:
${opts.parallel ? '  parallelGates: true\n' : ''}hooks:
  test: |
    echo T-start; ${SEES} | sed 's/^/T sees /'
    ${opts.test}
    echo T-end
  build: |
    echo B-start; ${SEES} | sed 's/^/B sees /'
    ${opts.build}
    echo B-end
  deploy: exit 0
`;
const SLOW = 'sleep 1';
const FAIL_WITH_FEATURE = 'if [ -f feature.txt ]; then exit 1; fi';
const at = (re: RegExp, from = 0) => lines.findIndex((l, i) => i >= from && re.test(l));
const lastAt = (re: RegExp) => lines.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
const run = (dir: string, repo: ReturnType<typeof project>['repo']) =>
  runRelease({ cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: emitter(), dryRun: false });
const gitOut = (dir: string, ...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });

test('key off: the test gate, then the bump, then the build gate', async () => {
  const { dir, repo } = project(yaml({ parallel: false, test: SLOW, build: 'true' }));
  const out = await run(dir, repo);
  assert.equal(out.deployed, true);
  assert.ok(at(/T-end/) >= 0 && at(/B-start/) > at(/T-end/), 'build starts after the test gate ends');
  assert.ok(at(/T sees "version": "1\.2\.3"/) >= 0, 'the test gate sees the old version');
  assert.ok(at(/B sees "version": "1\.3\.0"/) > at(/T-end/), 'the build gate sees the bumped version');
});

test('key on, both gates pass: they overlap, both see the bumped version, release completes', async () => {
  const { dir, repo } = project(yaml({ parallel: true, test: SLOW, build: 'true' }));
  const out = await run(dir, repo);
  assert.equal(out.deployed, true);
  assert.equal(out.version, '1.3.0');
  assert.ok(at(/B-start/) >= 0 && at(/B-start/) < lastAt(/T-end/), 'the build starts before the test ends');
  assert.ok(at(/T sees "version": "1\.3\.0"/) >= 0 && at(/B sees "version": "1\.3\.0"/) >= 0);
  assert.match(gitOut(dir, 'tag', '--list'), /v1\.3\.0/);
  assert.match(gitOut(dir, 'log', '--format=%s'), /^Release v?1\.3\.0$/m);
});

test('key on, test fails and build passes: nothing ships, version commit dropped, test isolated', async () => {
  const { dir, repo } = project(yaml({ parallel: true, test: FAIL_WITH_FEATURE, build: 'true' }));
  const out = await run(dir, repo);
  assert.notEqual(out.deployed, true);
  assert.equal(out.buildCulprits?.[0]?.hook, 'test');
  assert.ok(lines.some((l) => /test failed with only .* merged and passes without it/.test(l)));
  assert.doesNotMatch(gitOut(dir, 'log', '--format=%s', '--all'), /^Release /m);
  assert.doesNotMatch(gitOut(dir, 'tag', '--list'), /v1\.3\.0/);
});

test('key on, build fails and test passes: nothing ships, version commit dropped, build isolated', async () => {
  const { dir, repo } = project(yaml({ parallel: true, test: SLOW, build: FAIL_WITH_FEATURE }));
  const out = await run(dir, repo);
  assert.notEqual(out.deployed, true);
  assert.equal(out.buildCulprits?.[0]?.hook, 'build');
  assert.ok(lines.some((l) => /build failed with only .* merged and passes without it/.test(l)));
  assert.doesNotMatch(gitOut(dir, 'log', '--format=%s', '--all'), /^Release /m);
  assert.doesNotMatch(gitOut(dir, 'tag', '--list'), /v1\.3\.0/);
});

test('key on, both fail: one failure, naming the test gate', async () => {
  const { dir, repo } = project(yaml({ parallel: true, test: 'exit 1', build: 'exit 1' }));
  const out = await run(dir, repo);
  assert.equal(out.stopped, 'tests failed');
  assert.equal(out.hookFailure?.hook, 'test');
  assert.equal(lines.filter((l) => /not deploying/.test(l)).length, 1);
  assert.ok(!lines.some((l) => /build failed — not deploying/.test(l)));
  assert.doesNotMatch(gitOut(dir, 'log', '--format=%s'), /^Release /m);
});

for (const gate of ['test', 'build'] as const) {
  test(`key on, the ${gate} gate exits 86: it is not rerun, isolation still runs (CREW-3869)`, async () => {
    const fail86 = 'if [ -f feature.txt ]; then exit 86; fi';
    const { dir, repo } = project(yaml({
      parallel: true, test: gate === 'test' ? fail86 : SLOW, build: gate === 'build' ? fail86 : 'true',
    }));
    const out = await run(dir, repo);
    assert.notEqual(out.deployed, true);
    assert.ok(lines.some((l) => new RegExp(`${gate} gate reported a failure that a rerun cannot fix`).test(l)));
    assert.ok(!lines.some((l) => new RegExp(`${gate} gate failed — rerunning once`).test(l)));
    assert.equal(out.buildCulprits?.[0]?.hook, gate);
    assert.doesNotMatch(gitOut(dir, 'log', '--format=%s', '--all'), /^Release /m);
  });
}

test('release.parallelGates must be a boolean', () => {
  assert.throws(() => parseRepoConfig('version: 1\nhooks:\n  deploy: exit 0\nrelease:\n  parallelGates: sometimes\n', '.crew.yaml'), /parallelGates/);
});

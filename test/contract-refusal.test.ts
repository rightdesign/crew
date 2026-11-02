import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { contractFixers } from '../src/contract-refusal.ts';
import { runRelease } from '../src/release-run.ts';
import { loadRepoConfigTolerant, parseRepoConfig, resolveRepoConfig } from '../src/repo-config.ts';
import { passengerCheckoutSyncSpecs } from '../src/passenger-containers.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import { Emitter } from '../src/events.ts';
import type { Ticket } from '../src/tracker.ts';
import type { CrewConfig, Route } from '../src/config.ts';

const REFUSED = ['version: 1', 'release:', '  mode: integrate', '  versionFiles: [VERSION]'].join('\n');
const FIXED = ['version: 1', 'hooks:', '  test: exit 0', 'release:', '  mode: integrate', '  versioning: none', '  changelog: false'].join('\n');

const T = (id: string) => ({ issue_id: id, status: 'verified', title: id, id }) as unknown as Ticket;
const lines: string[] = [];
const emitter = () => { lines.length = 0; return new Emitter({ json: false, write: (l: string) => lines.push(l) } as never); };

/** A repo whose base carries a refused .crew.yaml and whose `issue-1` branch carries `branchYaml`. */
function repoWith(branchYaml: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-refused-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  writeFileSync(join(dir, 'VERSION'), '0.1.0\n'); writeFileSync(join(dir, '.crew.yaml'), REFUSED);
  g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'issue-1');
  if (branchYaml !== null) writeFileSync(join(dir, '.crew.yaml'), branchYaml);
  else writeFileSync(join(dir, 'other'), 'x');
  g('add', '.'); g('commit', '-qm', 'work\n\nChangelog: ISSUE-1 work');
  g('checkout', '-q', 'main');
  return { dir, g };
}

test('contractFixers names a verified branch that replaces the contract with one that loads', () => {
  const { dir } = repoWith(FIXED);
  const got = contractFixers(dir, 'main', [T('ISSUE-1')], () => 'issue-1');
  assert.deepEqual(got.map((f) => [f.issueId, f.file]), [['ISSUE-1', '.crew.yaml']]);
});

test('contractFixers ignores a branch that leaves the contract alone or still breaks it', () => {
  const untouched = repoWith(null);
  assert.deepEqual(contractFixers(untouched.dir, 'main', [T('ISSUE-1')], () => 'issue-1'), []);
  const stillBad = repoWith(REFUSED + '\n# still\n');
  assert.deepEqual(contractFixers(stillBad.dir, 'main', [T('ISSUE-1')], () => 'issue-1'), []);
});

test('a refused base contract releases when the merge replaces it (CREW-2928)', async () => {
  const { dir } = repoWith(FIXED);
  const out = await runRelease({
    cwd: dir, repo: resolveRepoConfig(null, undefined, dir), contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-1')],
    emit: emitter(), dryRun: false, contractRefusal: 'refused',
    reloadRepo: (d) => resolveRepoConfig(parseRepoConfig(readFileSync(join(d, '.crew.yaml'), 'utf8'), join(d, '.crew.yaml')), undefined, d),
  });
  assert.equal(out.merged.length, 1);
  assert.equal(out.integrated, true);
});

test('a refused base contract still refuses when the merged one is invalid too', async () => {
  const { dir } = repoWith(REFUSED + '\n# still\n');
  await assert.rejects(runRelease({
    cwd: dir, repo: resolveRepoConfig(null, undefined, dir), contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-1')],
    emit: emitter(), dryRun: false, contractRefusal: 'x/.crew.yaml: refused',
    reloadRepo: (d) => resolveRepoConfig(parseRepoConfig(readFileSync(join(d, '.crew.yaml'), 'utf8'), join(d, '.crew.yaml')), undefined, d),
  }), /refused/);
});

test('loadRepoConfigTolerant reports a refused contract and reads as none', () => {
  const { dir } = repoWith(null);
  const seen: string[] = [];
  assert.equal(loadRepoConfigTolerant(dir, (e) => seen.push(e.message)), null);
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /\.crew\.yaml/);
});

test('one refused contract leaves the other repositories\' passenger specs (CREW-2928)', () => {
  const bad = repoWith(null).dir;
  const good = mkdtempSync(join(tmpdir(), 'crew-good-'));
  mkdirSync(good, { recursive: true });
  const route = {
    route: 'w/a', enabled: true, dir: good, repos: { bad, good }, repoOverrides: {}, reposBasePath: '/tmp/repos-base',
    hostPassengers: true, baseUrl: 'https://example.test', apiKey: 'k', hooks: {}, labels: {}, release: {},
    resolved: { workspaceId: 'ws-1', models: { issues: 'i', comments: 'c', crew: 'm' }, seats: {}, operator: 'op', holds: [] },
  } as unknown as Route;
  const cfg = { ship: { stateDir: '/tmp/state' }, routes: [route], crewHome: '/tmp/crew' } as unknown as CrewConfig;
  const refused: string[] = [];
  const specs = passengerCheckoutSyncSpecs(cfg, undefined, (repo) => refused.push(repo));
  assert.deepEqual(specs.map((s) => s.name), ['good']);
  assert.deepEqual(refused, ['bad']);
});

test('settleRepos skips a repository whose contract is refused and keeps its siblings (CREW-2928)', async () => {
  const { settleRepos } = await import('../src/doctor-checks.ts');
  const bad = repoWith(null).dir;
  const { loadRepoConfig } = await import('../src/repo-config.ts');
  const r = await settleRepos([{ n: 'bad', d: bad }, { n: 'ok', d: tmpdir() }], (t) => t.n, async (t) => { loadRepoConfig(t.d); return t.n; });
  assert.deepEqual(r.settled, ['ok']);
  assert.equal(r.errors[0]!.repo, 'bad');
});

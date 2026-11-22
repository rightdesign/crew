import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  settlePipeline, sweepPipeline, watchProduction, qaReports, commitFromHealth, sameCommit,
  type PipelineContext, type PipelineRelease, type Probe,
} from '../src/pipeline-release.ts';
import { missingStatusProblem } from '../src/pipeline-sweep.ts';
import type { CiProvider, CiRun } from '../src/ci-provider.ts';
import { runRelease } from '../src/release-run.ts';
import { parseRepoConfig, resolveRepoConfig, validateEffective, RepoConfigError } from '../src/repo-config.ts';
import { DEFAULT_CONTRACT, RELEASED_TO_QA_DEFAULT, closedStatuses, resolveContract, withReleasedToQaResolved } from '../src/contract.ts';
import { Emitter } from '../src/events.ts';
import type { ShipAttentionItem } from '../src/ship-attention.ts';
import type { Ticket } from '../src/tracker.ts';

const SHA = 'a'.repeat(40);
const T = (issue_id: string, over: Partial<Ticket> = {}): Ticket =>
  ({ id: issue_id, issue_id, status: 'verified', updated_at: '2026-08-23T00:00:00Z', ...over }) as Ticket;

const SETTINGS = {
  qa: [{ role: 'web', url: 'https://qa-web.test' }, { role: 'worker', url: 'https://qa-worker.test' }],
  production: [{ role: 'web', url: 'https://prod.test' }],
  pipeline: 'acme/widgets', qaTimeoutSeconds: 30, qaIntervalSeconds: 10, startTimeoutSeconds: 600,
};

const run = (state: CiRun['state'], over: Partial<CiRun> = {}): CiRun =>
  ({ id: '1', name: 'acme/widgets #1', url: 'https://ci.test/1', state, ref: 'base', ...over });
const provider = (runs: CiRun[] | { why: string }): CiProvider => ({
  name: 'stub',
  runs: async () => 'why' in runs ? { ok: false, why: runs.why } : { ok: true, runs },
  failure: async (_q, r) => ({ run: r, job: 'Deploy QA', step: 'push' }),
});

/** QA and production stubs: answers by URL, every call recorded. */
function world(answers: Record<string, { status: number; body: string }>) {
  const asked: string[] = [];
  const probe: Probe = async (url) => { asked.push(url); return answers[url] ?? null; };
  return { probe, asked };
}
const health = (commit: string) => ({ status: 200, body: JSON.stringify({ status: 'ok', commit }) });
const QA_UP = (sha: string) => ({
  'https://qa-web.test/api/ready': { status: 200, body: '{}' }, 'https://qa-web.test/api/health-check': health(sha),
  'https://qa-worker.test/api/ready': { status: 200, body: '{}' }, 'https://qa-worker.test/api/health-check': health(sha),
});

const lines: string[] = [];
function ctx(over: Partial<PipelineContext> & { raised?: ShipAttentionItem[]; clock?: { t: number } } = {}): PipelineContext {
  lines.length = 0;
  const clock = over.clock ?? { t: Date.parse('2026-11-22T12:00:00Z') };
  return {
    scope: 'crew/widgets', settings: SETTINGS, provider: provider([]),
    query: { host: 'github.com', remote: 'acme/widgets', base: 'main' },
    contract: DEFAULT_CONTRACT,
    emit: new Emitter({ route: 'c', console: (l) => lines.push(l), cycleId: 'C' }),
    attention: { raise: (i) => { over.raised?.push(i); }, clear: () => {} },
    isAncestor: () => true, commitDate: () => '2026-11-22T11:55:00Z',
    now: () => clock.t, sleep: async (ms) => { clock.t += ms; },
    ...over,
  };
}
const REL: PipelineRelease = { sha: SHA, tag: 'v1.3.0', version: '1.3.0' };

// ---- settling a run -------------------------------------------------------

test('a passed run with QA reporting the commit moves the carried tickets to released-to-QA', async () => {
  const w = world(QA_UP(SHA.slice(0, 12)));
  const marked: Array<[string[], string | undefined]> = [];
  const out = await settlePipeline(ctx({ provider: provider([run('passed')]), probe: w.probe }), REL, [T('A-1'), T('A-2')],
    async (ts, r) => { marked.push([ts.map((t) => t.issue_id), r.version]); });
  assert.equal(out.kind, 'released-to-qa');
  assert.deepEqual(marked, [[['A-1', 'A-2'], '1.3.0']]);
  assert.ok(w.asked.includes('https://qa-worker.test/api/ready'), 'every role is asked, not only the first');
});

test('a failed run leaves the tickets and reports the pipeline link', async () => {
  const raised: ShipAttentionItem[] = [];
  const w = world(QA_UP(SHA));
  let marked = 0;
  const out = await settlePipeline(ctx({ provider: provider([run('failed', { url: 'https://ci.test/9' })]), probe: w.probe, raised }), REL, [T('A-1')], async () => { marked++; });
  assert.equal(out.kind, 'failed');
  assert.equal(marked, 0);
  assert.equal(w.asked.length, 0, 'QA is not asked about a run that failed');
  assert.match(lines.join('\n'), /run failed: .*Deploy QA.*https:\/\/ci\.test\/9/);
  assert.equal(raised[0]!.kind, 'ci_run_failed');
  assert.equal(raised[0]!.ci?.url, 'https://ci.test/9');
});

test('a run still going is in flight, and nothing is marked', async () => {
  let marked = 0;
  const out = await settlePipeline(ctx({ provider: provider([run('pending')]) }), REL, [T('A-1')], async () => { marked++; });
  assert.equal(out.kind, 'in-flight');
  assert.equal(marked, 0);
});

test('a status that cannot be read holds the next release too, and says why', async () => {
  const out = await settlePipeline(ctx({ provider: provider({ why: 'no readable credential for buildkite.com' }) }), REL, [T('A-1')], async () => {});
  assert.equal(out.kind, 'in-flight');
  assert.match(out.kind === 'in-flight' ? out.why : '', /no readable credential/);
});

test('no run yet is in flight until the start bound passes, then it is reported', async () => {
  const early = await settlePipeline(ctx({ provider: provider([]) }), REL, [T('A-1')], async () => {});
  assert.equal(early.kind, 'in-flight');
  const raised: ShipAttentionItem[] = [];
  const late = await settlePipeline(ctx({ provider: provider([]), commitDate: () => '2026-11-22T09:00:00Z', raised }), REL, [T('A-1')], async () => {});
  assert.equal(late.kind, 'failed');
  assert.match(raised[0]!.message, /no stub run appeared/);
});

test('QA reporting another commit within the bound fails the release and leaves the tickets', async () => {
  const w = world(QA_UP('b'.repeat(40)));
  const clock = { t: Date.parse('2026-11-22T12:00:00Z') };
  let marked = 0;
  const out = await settlePipeline(ctx({ provider: provider([run('passed')]), probe: w.probe, clock }), REL, [T('A-1')], async () => { marked++; });
  assert.equal(out.kind, 'failed');
  assert.equal(marked, 0);
  assert.match(out.kind === 'failed' ? out.why : '', /did not report aaaaaaaa within 30s: web .* reports bbbbbbbb/);
  assert.ok(clock.t > Date.parse('2026-11-22T12:00:00Z'), 'it waited out the window by sleeping, not spinning');
});

test('QA that is not ready, or one role down, is not a release', async () => {
  const answers = QA_UP(SHA);
  delete (answers as Record<string, unknown>)['https://qa-worker.test/api/health-check'];
  const r = await qaReports(ctx({ probe: world(answers).probe }), SHA);
  assert.ok(!r.ok && /worker \(https:\/\/qa-worker\.test\) is unreachable/.test(r.why));
  const notReady = await qaReports(ctx({ probe: world({ ...QA_UP(SHA), 'https://qa-web.test/api/ready': { status: 503, body: '' } }).probe }), SHA);
  assert.ok(!notReady.ok && /web .* is not ready/.test(notReady.why));
});

test('nothing carried means nothing to follow, and the provider is not asked', async () => {
  let asked = 0;
  const p: CiProvider = { name: 'stub', runs: async () => { asked++; return { ok: true, runs: [] }; }, failure: async (_q, r) => ({ run: r }) };
  assert.deepEqual(await settlePipeline(ctx({ provider: p }), REL, [], async () => {}), { kind: 'idle' });
  assert.equal(asked, 0);
});

test('commit ids: health bodies and prefix matching', () => {
  assert.equal(commitFromHealth('{"status":"ok","commit":"ABCDEF1234"}'), 'abcdef1234');
  assert.equal(commitFromHealth('{"commit":"unknown"}'), null);
  assert.equal(commitFromHealth('<html>'), null);
  assert.equal(sameCommit('abcdef1', 'abcdef1234567'), true);
  assert.equal(sameCommit('abc', 'abcdef1234567'), false);
});

// ---- the sweep ------------------------------------------------------------

test('a sweep follows only the verified tickets the release commit contains', async () => {
  const marked: string[] = [];
  const sweep = await sweepPipeline(
    ctx({ provider: provider([run('passed')]), probe: world({ ...QA_UP(SHA), 'https://prod.test/api/health-check': health('c'.repeat(40)) }).probe,
      isAncestor: (a) => a === 'in-release' }),
    REL, [T('A-1', { commit_sha: 'in-release' }), T('A-2', { commit_sha: 'later' }), T('A-3')],
    { markReleasedToQa: async (ts) => { marked.push(...ts.map((t) => t.issue_id)); },
      lastSeen: () => null, noteSeen: () => {}, releasedToQa: async () => [], recentlyDeployed: async () => [], markDeployed: async () => {} });
  assert.equal(sweep.state.kind, 'released-to-qa');
  assert.deepEqual(marked, ['A-1']);
});

test('with no release yet there is nothing to settle, and production is still read', async () => {
  const w = world({ 'https://prod.test/api/health-check': health('c'.repeat(40)) });
  const sweep = await sweepPipeline(ctx({ probe: w.probe }), null, [T('A-1', { commit_sha: 'x' })],
    { markReleasedToQa: async () => { assert.fail('nothing to mark'); }, lastSeen: () => null, noteSeen: () => {},
      releasedToQa: async () => [], recentlyDeployed: async () => [], markDeployed: async () => {} });
  assert.equal(sweep.state.kind, 'idle');
  assert.equal(sweep.production.reading.kind, 'commit');
});

// ---- watching production ----------------------------------------------------

function prodOps(queued: Ticket[], deployedRecent: Ticket[] = [], seen: { sha: string | null } = { sha: null }) {
  const deployed: string[] = [];
  return {
    deployed, seen,
    ops: {
      lastSeen: () => seen.sha, noteSeen: (s: string) => { seen.sha = s; },
      releasedToQa: async () => queued, recentlyDeployed: async () => deployedRecent,
      markDeployed: async (ts: Ticket[]) => { deployed.push(...ts.map((t) => t.issue_id)); },
    },
  };
}
const PROD = 'd'.repeat(40);

test('a production commit that contains a ticket deploys it; the others are left alone', async () => {
  const p = prodOps([T('A-1', { commit_sha: 'in', status: 'released_to_qa' }), T('A-2', { commit_sha: 'out', status: 'released_to_qa' })]);
  const res = await watchProduction(ctx({ probe: world({ 'https://prod.test/api/health-check': health(PROD) }).probe, isAncestor: (a) => a === 'in' }), p.ops);
  assert.deepEqual(p.deployed, ['A-1']);
  assert.deepEqual(res.waiting.map((t) => t.issue_id), ['A-2']);
});

test('one production release closes every ticket it contains', async () => {
  const p = prodOps(['A-1', 'A-2', 'A-3'].map((id) => T(id, { commit_sha: id, status: 'released_to_qa' })));
  await watchProduction(ctx({ probe: world({ 'https://prod.test/api/health-check': health(PROD) }).probe }), p.ops);
  assert.deepEqual(p.deployed, ['A-1', 'A-2', 'A-3']);
});

test('a rollback closes nothing, and a deployed ticket production no longer contains is flagged, not reopened', async () => {
  const raised: ShipAttentionItem[] = [];
  const p = prodOps(
    [T('A-5', { commit_sha: 'newer', status: 'released_to_qa' })],
    [T('A-4', { commit_sha: 'newer', status: 'closed_deployed' }), T('A-3', { commit_sha: 'older', status: 'closed_deployed' })],
    { sha: 'e'.repeat(40) },
  );
  const res = await watchProduction(ctx({ raised, probe: world({ 'https://prod.test/api/health-check': health(PROD) }).probe, isAncestor: (a) => a === 'older' }), p.ops);
  assert.deepEqual(p.deployed, []);
  assert.deepEqual(res.flagged.map((t) => t.issue_id), ['A-4']);
  assert.match(raised[0]!.message, /does not contain the work of A-4/);
  assert.equal(p.seen.sha, PROD);
  // The same commit on the next look is not reported again.
  raised.length = 0;
  await watchProduction(ctx({ raised, probe: world({ 'https://prod.test/api/health-check': health(PROD) }).probe, isAncestor: (a) => a === 'older' }), p.ops);
  assert.equal(raised.length, 0);
});

test('production unreadable, or roles disagreeing mid-rollout, changes nothing', async () => {
  const p = prodOps([T('A-1', { commit_sha: 'x', status: 'released_to_qa' })]);
  const down = await watchProduction(ctx({ probe: world({}).probe }), p.ops);
  assert.equal(down.reading.kind, 'unreadable');
  const two = { ...SETTINGS, production: [{ role: 'web', url: 'https://p1.test' }, { role: 'worker', url: 'https://p2.test' }] };
  const mixed = await watchProduction(ctx({ settings: two, probe: world({
    'https://p1.test/api/health-check': health('1'.repeat(40)), 'https://p2.test/api/health-check': health('2'.repeat(40)) }).probe }), p.ops);
  assert.equal(mixed.reading.kind, 'mixed');
  assert.deepEqual(p.deployed, []);
});

// ---- the missing status ------------------------------------------------------

test('a tracker without the released-to-QA status stops the release with a message naming it', async () => {
  const msg = await missingStatusProblem({ contract: DEFAULT_CONTRACT, statusOptionExists: async () => false });
  assert.match(msg ?? '', /no "released_to_qa" status/);
  assert.equal(await missingStatusProblem({ contract: DEFAULT_CONTRACT, statusOptionExists: async () => true }), null);
  assert.equal(await missingStatusProblem({ contract: DEFAULT_CONTRACT, statusOptionExists: async () => undefined }), null, 'unreadable is not missing');
});

test('released-to-QA is finished for a blocker and still not closed', () => {
  assert.equal(DEFAULT_CONTRACT.statuses.releasedToQa, RELEASED_TO_QA_DEFAULT);
  const c = withReleasedToQaResolved(resolveContract(null));
  assert.ok(c.statuses.resolved.includes(RELEASED_TO_QA_DEFAULT));
  assert.ok(!closedStatuses(c).includes(RELEASED_TO_QA_DEFAULT));
  assert.ok(!c.statuses.open.includes(RELEASED_TO_QA_DEFAULT), 'no lane polls it');
  // A workspace that lists its own resolved statuses still gets it.
  assert.ok(withReleasedToQaResolved(resolveContract({ statuses: { ...DEFAULT_CONTRACT.statuses, resolved: ['closed_deployed'] } })).statuses.resolved.includes(RELEASED_TO_QA_DEFAULT));
});

// ---- configuration -----------------------------------------------------------

const PIPELINE_YAML = `version: 1
hooks:
  test: exit 0
  build: exit 0
release:
  mode: pipeline
  ci: { provider: buildkite }
  pipeline:
    qa: https://qa.example.test/
    production: { web: https://app.example.test, worker: https://worker.example.test }
    pipeline: acme/widgets
`;

test('release.pipeline parses: a bare address is the role app, a map is per role', () => {
  const c = parseRepoConfig(PIPELINE_YAML, '.crew.yaml');
  assert.equal(c.release.mode, 'pipeline');
  assert.deepEqual(c.release.pipeline?.qa, [{ role: 'app', url: 'https://qa.example.test' }]);
  assert.deepEqual(c.release.pipeline?.production.map((r) => r.role), ['web', 'worker']);
  assert.equal(c.release.pipeline?.qaTimeoutSeconds, 600);
  assert.deepEqual(validateEffective(resolveRepoConfig(c, undefined, '/x')).filter((p) => /pipeline|released hook|CI provider/.test(p)), []);
});

test('pipeline mode refuses what contradicts it', () => {
  assert.throws(() => parseRepoConfig(PIPELINE_YAML.replace('  pipeline:\n', '  nope:\n'), 'f'), RepoConfigError);
  assert.throws(() => parseRepoConfig(PIPELINE_YAML.replace('    pipeline: acme/widgets\n', ''), 'f'), /release\.pipeline\.pipeline must name/);
  assert.throws(() => parseRepoConfig(PIPELINE_YAML.replace('qa: https://qa.example.test/', 'qa: qa.example.test'), 'f'), /http\(s\) address/);
  assert.throws(() => parseRepoConfig(PIPELINE_YAML + '  \nhooks_: 1\n', 'f'));
  assert.throws(() => parseRepoConfig(PIPELINE_YAML.replace('hooks:\n', 'hooks:\n  deploy: ./ship.sh\n'), 'f'), /never runs a deploy script/);
  assert.throws(() => parseRepoConfig(PIPELINE_YAML.replace('mode: pipeline', 'mode: ci_auto').replace('hooks:\n', 'hooks:\n  released: echo\n'), 'f'), /only applies to release\.mode "pipeline"/);
  assert.throws(() => parseRepoConfig('version: 1\nhooks:\n  test: t\nrelease:\n  mode: pipeline\n  ci: { provider: buildkite }\n', 'f'), /needs release\.pipeline/);
});

// ---- the release step ---------------------------------------------------------

function bareRemote() {
  const bare = mkdtempSync(join(tmpdir(), 'crew-pipe-bare-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare, stdio: 'pipe' });
  return bare;
}
function project(yaml: string, bare: string) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-pipe-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.2.3' }, null, 2));
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.3 — 2026-01-01\n\n- Older\n');
  g('add', '.'); g('commit', '-qm', 'base'); g('tag', '-a', 'v1.2.3', '-m', 'Release v1.2.3');
  g('checkout', '-qb', 'issue-7');
  writeFileSync(join(dir, 'feature.txt'), 'x'); g('add', '.');
  g('commit', '-qm', 'built it\n\nChangelog: Records can now be starred\nBump: minor');
  g('checkout', '-q', 'main');
  g('remote', 'add', 'origin', bare); g('push', '-q', 'origin', 'main');
  return { dir, g, repo: resolveRepoConfig(parseRepoConfig(yaml, '.crew.yaml'), undefined, dir) };
}
const remoteTags = (bare: string) => execFileSync('git', ['--git-dir', bare, 'tag', '--list'], { encoding: 'utf8' });
const remoteHead = (bare: string) => execFileSync('git', ['--git-dir', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();

test('a pipeline release pushes the release commit and runs no deploy; the tickets are not stamped deployed', async () => {
  const bare = bareRemote();
  const { dir, repo } = project(PIPELINE_YAML, bare);
  const before = remoteHead(bare);
  const pushed: string[] = [];
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: new Emitter({ route: 'c', console: () => {}, cycleId: 'C' }), dryRun: false,
    onBasePushed: async (m) => { pushed.push(...m.map((x) => x.ticket.issue_id)); },
  });
  assert.equal(out.version, '1.3.0');
  assert.equal(out.deployed, false);
  assert.ok(!out.integrated);
  assert.equal(out.confirmed, undefined);
  assert.notEqual(remoteHead(bare), before, 'the release commit reached the remote');
  assert.match(remoteTags(bare), /v1\.3\.0/);
  assert.deepEqual(pushed, ['ISSUE-7'], 'merge shas are recorded so the pipeline sweep can tell what a run carries');
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '1.3.0');
});

test('while a run is in flight no release is pushed, and the verified ticket waits', async () => {
  const bare = bareRemote();
  const { dir, repo } = project(PIPELINE_YAML, bare);
  const before = remoteHead(bare);
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: new Emitter({ route: 'c', console: () => {}, cycleId: 'C' }), dryRun: false,
    pipelineInFlight: { why: 'acme/widgets #412 is running', url: 'https://ci.test/412' },
  });
  assert.equal(out.stopped, 'pipeline run in flight');
  assert.deepEqual(out.merged, []);
  assert.equal(remoteHead(bare), before);
  assert.doesNotMatch(remoteTags(bare), /v1\.3\.0/);
});

test('a route without the mode ignores a pipeline hold entirely', async () => {
  const bare = bareRemote();
  const { dir, repo } = project(`version: 1
hooks:
  test: exit 0
  build: exit 0
  deploy: exit 0
`, bare);
  const out = await runRelease({
    cwd: dir, repo, contract: DEFAULT_CONTRACT, tickets: [T('ISSUE-7')], emit: new Emitter({ route: 'c', console: () => {}, cycleId: 'C' }), dryRun: false,
    pipelineInFlight: { why: 'x' },
  });
  assert.equal(out.deployed, true);
});

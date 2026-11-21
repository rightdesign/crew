import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRelease, batchCapActive, trimBatch, BATCH_CAPPED_EVENT, BATCH_CAP_CLEARED_EVENT } from '../src/release-run.ts';
import { parseRepoConfig, resolveRepoConfig } from '../src/repo-config.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import { Emitter } from '../src/events.ts';
import { describeRelease } from '../src/notify.ts';
import type { MergeCandidate, ReleaseDecision } from '../src/release.ts';
import type { RunnerEvent, Ticket } from '../src/tracker.ts';

// CREW-3872: a failing batch over the isolation limit shrinks instead of giving up, the next batch is
// capped until a release ships, and isolation bisects instead of building every branch alone.

const T = (n: number): Ticket =>
  ({ id: `ISSUE-${n}`, issue_id: `ISSUE-${n}`, status: 'verified', updated_at: '2026-08-23T00:00:00Z' }) as Ticket;
const lines: string[] = [];
const emitter = () => new Emitter({ route: 'c', console: (l: string) => { lines.push(l); }, cycleId: 'C' });

/** main plus verified branches issue-1..n, each adding fN.txt; `fails` is the shell condition the build hook fails on. */
function repoWith(n: number, fails: string, maxCandidates = 4) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-cap-'));
  const count = join(mkdtempSync(join(tmpdir(), 'crew-cap-count-')), 'builds');
  writeFileSync(count, '');
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }));
  g('add', '.'); g('commit', '-qm', 'base'); g('tag', '-a', 'v1.0.0', '-m', 'r');
  for (let i = 1; i <= n; i++) {
    g('checkout', '-qb', `issue-${i}`);
    writeFileSync(join(dir, `f${i}.txt`), 'ok');
    g('add', '.'); g('commit', '-qm', `built ${i}\n\nChangelog: ISSUE-${i} did a thing\nBump: patch`);
    g('checkout', '-q', 'main');
  }
  const yaml = `version: 1\nhooks:\n  test: exit 0\n  build: |\n    echo x >> ${count}\n    ${fails}\n  deploy: exit 0\nrelease:\n  isolateFailures: { maxCandidates: ${maxCandidates} }\n`;
  const repo = resolveRepoConfig(parseRepoConfig(yaml, '.crew.yaml'), undefined, dir);
  return { dir, repo, count, tickets: Array.from({ length: n }, (_, i) => T(i + 1)) };
}
const builds = (r: { count: string }): number => readFileSync(r.count, 'utf8').split('\n').filter(Boolean).length;
const go = (r: ReturnType<typeof repoWith>, extra: { batchCapped?: boolean } = {}) =>
  runRelease({ cwd: r.dir, repo: r.repo, contract: DEFAULT_CONTRACT, tickets: r.tickets, emit: emitter(), dryRun: false, ...extra });
const ids = (ts: Array<{ issue_id: string }> | undefined) => ts?.map((t) => t.issue_id);

test('a failing batch of 10 shrinks to the oldest 4; the culprit among them is isolated and the other three ship', async () => {
  const r = repoWith(10, 'test -f f2.txt && echo "something broke" && exit 1 || exit 0');
  const out = await go(r);
  assert.deepEqual(out.buildCulprits?.map((c) => c.ticket.issue_id), ['ISSUE-2']);
  assert.equal(out.deployed, true);
  assert.deepEqual(ids(out.merged.map((m) => m.ticket))?.sort(), ['ISSUE-1', 'ISSUE-3', 'ISSUE-4']);
  assert.deepEqual(ids(out.batchDeferral?.deferred), ['ISSUE-5', 'ISSUE-6', 'ISSUE-7', 'ISSUE-8', 'ISSUE-9', 'ISSUE-10']);
  assert.equal(out.batchDeferral?.reason, 'shrunk');
  assert.ok(!existsSync(join(r.dir, 'f5.txt')));
});

test('a failing batch of 10 whose culprit is not among the oldest 4 ships those four', async () => {
  const r = repoWith(10, 'test -f f9.txt && echo "something broke" && exit 1 || exit 0');
  const out = await go(r);
  assert.equal(out.buildCulprits, undefined);
  assert.equal(out.deployed, true);
  assert.deepEqual(ids(out.merged.map((m) => m.ticket))?.sort(), ['ISSUE-1', 'ISSUE-2', 'ISSUE-3', 'ISSUE-4']);
  assert.equal(out.batchDeferral?.deferred.length, 6);
  assert.equal(out.unisolatedFailure, undefined);
});

test('the event stream names how many branches were deferred and why', async () => {
  lines.length = 0;
  const r = repoWith(6, 'test -f f2.txt && echo "something broke" && exit 1 || exit 0', 3);
  await go(r);
  const said = lines.join('\n');
  assert.match(said, /3 verified branches left for a later cycle: the gate failed on a batch over release\.isolateFailures\.maxCandidates \(3\)/);
});

test('a capped batch takes at most maxCandidates branches and says so', async () => {
  lines.length = 0;
  const r = repoWith(10, 'exit 0');
  const out = await go(r, { batchCapped: true });
  assert.equal(out.deployed, true);
  assert.equal(out.merged.length, 4);
  assert.equal(out.batchDeferral?.reason, 'capped');
  assert.equal(out.batchDeferral?.deferred.length, 6);
  assert.match(lines.join('\n'), /6 verified branches left for a later cycle: the last release failed its gate and was not isolated, so a batch is capped at 4/);
});

test('without the cap the whole batch ships', async () => {
  const r = repoWith(10, 'exit 0');
  const out = await go(r);
  assert.equal(out.merged.length, 10);
  assert.equal(out.batchDeferral, undefined);
});

test('a failure nobody could isolate marks the next batch for the cap, and the alert says what was tried', async () => {
  // fails only with f1, f2 and f3 together: no branch alone and no pair
  const r = repoWith(3, 'test ! -f f1.txt -o ! -f f2.txt -o ! -f f3.txt');
  const out = await go(r);
  assert.equal(out.deployed, false);
  assert.equal(out.unisolatedFailure, true);
  const news = describeRelease(out, 'c');
  assert.equal(news?.level, 'fail');
  assert.match(news!.detail!, /Isolation found no culprit/);
});

test('a release that isolated its culprit does not mark the cap', async () => {
  const r = repoWith(3, 'test -f f2.txt && echo "something broke" && exit 1 || exit 0');
  const out = await go(r);
  assert.equal(out.deployed, true);
  assert.equal(out.unisolatedFailure, undefined);
});

const ev = (type: string, scope: string, at: string): RunnerEvent =>
  ({ record_id: 'r', event_type: type, occurred_at: at, metadata: { scope } });

test('the cap persists across cycles from the board, is per repo, and clears when a later release lifts it', () => {
  const capped = ev(BATCH_CAPPED_EVENT, 'a/x', '2026-11-20T23:00:00Z');
  assert.equal(batchCapActive([], 'a/x'), false);
  assert.equal(batchCapActive([capped], 'a/x'), true);
  assert.equal(batchCapActive([capped], 'a/y'), false);
  const cleared = ev(BATCH_CAP_CLEARED_EVENT, 'a/x', '2026-11-21T00:00:00Z');
  assert.equal(batchCapActive([cleared, capped], 'a/x'), false);
  // capped again after the clear
  assert.equal(batchCapActive([cleared, capped, ev(BATCH_CAPPED_EVENT, 'a/x', '2026-11-21T01:00:00Z')], 'a/x'), true);
});

test('trimBatch keeps the oldest and leaves entries that merge nothing alone', () => {
  const c = (n: number, merged = false): MergeCandidate =>
    ({ ticket: T(n), branch: `issue-${n}`, entries: [], usedFallback: false, bump: 'patch', majorRequested: false, ...(merged ? { mergedSha: 'abc' } : {}) });
  const d = { merges: [c(1, true), c(2), c(3), c(4), c(5)] } as ReleaseDecision;
  const { decision, left } = trimBatch(d, 2);
  assert.deepEqual(decision.merges.map((m) => m.ticket.issue_id), ['ISSUE-1', 'ISSUE-2', 'ISSUE-3']);
  assert.deepEqual(left.map((m) => m.ticket.issue_id), ['ISSUE-4', 'ISSUE-5']);
  assert.equal(trimBatch(d, 0).left.length, 0);
});

test('4 branches and one failing: bisection names the right branch in fewer gates than one per branch', async () => {
  const r = repoWith(4, 'test -f f3.txt && echo "something broke" && exit 1 || exit 0');
  const out = await go(r);
  assert.deepEqual(out.buildCulprits?.map((c) => [c.ticket.issue_id, c.how]), [['ISSUE-3', 'solo']]);
  assert.equal(out.deployed, true);
  // combined run + its rerun + the base alone + 3 to find the culprit + the release gate on the other three;
  // building each of the four alone would cost 4 for the search alone (9 in all).
  assert.ok(builds(r) <= 8, `used ${builds(r)} build runs`);
});

test('two branches that pass alone and fail together are found by the pair search, within the bound', async () => {
  const r = repoWith(4, 'test ! -f f2.txt -o ! -f f4.txt && exit 0 || { echo "something broke"; exit 1; }');
  const out = await go(r);
  assert.deepEqual(out.buildCulprits?.map((c) => [c.ticket.issue_id, c.how, c.sibling?.branch]), [['ISSUE-4', 'pair', 'issue-2']]);
  assert.equal(out.deployed, true);
  assert.deepEqual(ids(out.merged.map((m) => m.ticket))?.sort(), ['ISSUE-1', 'ISSUE-2', 'ISSUE-3']);
  // 3 for the combined run, its rerun and the base, then at most 2*ceil(log2 4)+2 = 6 to isolate, then the release gate
  assert.ok(builds(r) <= 3 + 6 + 1, `used ${builds(r)} build runs`);
});

test('two culprits in one batch are both found', async () => {
  const r = repoWith(5, 'test -f f2.txt -o -f f4.txt && echo "something broke" && exit 1 || exit 0', 8);
  const out = await go(r);
  assert.deepEqual(out.buildCulprits?.map((c) => c.ticket.issue_id).sort(), ['ISSUE-2', 'ISSUE-4']);
  assert.equal(out.deployed, true);
  assert.deepEqual(ids(out.merged.map((m) => m.ticket))?.sort(), ['ISSUE-1', 'ISSUE-3', 'ISSUE-5']);
});

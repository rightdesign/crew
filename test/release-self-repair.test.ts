import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRelease, pairOrder, selfRepairLine, ISOLATE_MAX_PAIRS } from '../src/release-run.ts';
import { parseRepoConfig, resolveRepoConfig, DEFAULT_ISOLATE_MAX_CANDIDATES } from '../src/repo-config.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import { Emitter } from '../src/events.ts';
import { describeRelease } from '../src/notify.ts';
import { planBuildFailureBounce, applyBuildFailureBounce } from '../src/build-failure.ts';
import type { Ticket } from '../src/tracker.ts';

// CREW-2777: the 2026-10-31 replay and its siblings, against real git branches.

const T = (issue_id: string): Ticket =>
  ({ id: issue_id, issue_id, status: 'verified', updated_at: '2026-08-23T00:00:00Z' }) as Ticket;
const emitter = () => new Emitter({ route: 'c', console: () => {}, cycleId: 'C' });

/** main plus verified branches issue-1..N, each adding fN.txt (or editing shared.txt when `shared`). */
function repoWith(n: number, build: string, shared = false, extra = '') {
  const dir = mkdtempSync(join(tmpdir(), 'crew-sr-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }));
  writeFileSync(join(dir, 'shared.txt'), 'base\n');
  g('add', '.'); g('commit', '-qm', 'base'); g('tag', '-a', 'v1.0.0', '-m', 'r');
  for (let i = 1; i <= n; i++) {
    g('checkout', '-qb', `issue-${i}`);
    writeFileSync(join(dir, shared ? 'shared.txt' : `f${i}.txt`), shared ? `edit ${i}\n` : 'ok');
    g('add', '.'); g('commit', '-qm', `built ${i}\n\nChangelog: ISSUE-${i} did a thing\nBump: patch`);
    g('checkout', '-q', 'main');
  }
  const yaml = `version: 1\nhooks:\n  test: exit 0\n  build: |\n    ${build}\n  deploy: exit 0\n${extra}`;
  const repo = resolveRepoConfig(parseRepoConfig(yaml, '.crew.yaml'), undefined, dir);
  const tickets = Array.from({ length: n }, (_, i) => T(`ISSUE-${i + 1}`));
  return { dir, repo, tickets };
}
const go = (r: ReturnType<typeof repoWith>) =>
  runRelease({ cwd: r.dir, repo: r.repo, contract: DEFAULT_CONTRACT, tickets: r.tickets, emit: emitter(), dryRun: false });

test('pairOrder walks pairs by the later branch, then the earlier, and stops at the bound', () => {
  assert.deepEqual(pairOrder(4, 99).pairs, [[0, 1], [0, 2], [1, 2], [0, 3], [1, 3], [2, 3]]);
  assert.equal(pairOrder(4, 99).truncated, false);
  const bounded = pairOrder(6);
  assert.equal(bounded.pairs.length, ISOLATE_MAX_PAIRS);
  assert.equal(bounded.truncated, true);
  assert.deepEqual(bounded.pairs.at(-1), [0, 4].length ? [3, 4] : [0, 0]);
  assert.equal(pairOrder(5).truncated, false);   // exactly 10 pairs fit
});

test('replay: two branches that pass alone and fail together — the later-verified is bounced, the other ships, no alert', async () => {
  const r = repoWith(3, 'test ! -f f2.txt -o ! -f f3.txt');
  const out = await go(r);
  assert.deepEqual(out.buildCulprits?.map((c) => [c.ticket.issue_id, c.how, c.sibling?.branch]), [['ISSUE-3', 'pair', 'issue-2']]);
  assert.equal(out.deployed, true);
  assert.deepEqual(out.merged.map((m) => m.ticket.issue_id).sort(), ['ISSUE-1', 'ISSUE-2']);
  assert.ok(existsSync(join(r.dir, 'f2.txt')) && !existsSync(join(r.dir, 'f3.txt')));
  assert.equal(out.isolation, undefined);
  assert.notEqual(describeRelease(out, 'c')?.level, 'fail');   // no alert
});

test('past the pair bound the search bisects by halves instead of giving up', async () => {
  const r = repoWith(6, 'test ! -f f1.txt -o ! -f f6.txt', false, 'release:\n  isolateFailures: { maxCandidates: 8 }\n');
  const out = await go(r);
  assert.deepEqual(out.buildCulprits?.map((c) => [c.ticket.issue_id, c.how]), [['ISSUE-6', 'pair']]);
  assert.equal(out.deployed, true);
  assert.equal(out.merged.length, 5);
});

test('a verified-branch conflict: the later-verified is handed back with the file list, the other ships, no alert', async () => {
  const r = repoWith(2, 'exit 0', true);
  const out = await go(r);
  assert.equal(out.deployed, true);
  assert.deepEqual(out.merged.map((m) => m.ticket.issue_id), ['ISSUE-1']);
  assert.deepEqual(out.conflicts?.map((c) => c.candidate.ticket.issue_id), ['ISSUE-2']);
  assert.ok(out.conflicts![0]!.paths.includes('shared.txt'));
  assert.notEqual(describeRelease(out, 'c')?.level, 'fail');   // no alert
});

test('when the base alone fails the gate an alert is filed saying isolation found no culprit', async () => {
  const r = repoWith(1, 'echo red; exit 1');
  const out = await go(r);
  assert.equal(out.stopped, 'build failed');
  assert.match(out.isolation ?? '', /fails on the base alone/);
  const news = describeRelease(out, 'c');
  assert.equal(news?.level, 'fail');
  assert.match(news!.detail!, /Isolation found no culprit/);
});

test('when every branch passes alone and no pair fails, the alert says what was tried', async () => {
  const r = repoWith(3, 'test ! -f f1.txt -o ! -f f2.txt -o ! -f f3.txt');
  const out = await go(r);
  assert.equal(out.buildCulprits, undefined);
  assert.match(out.isolation ?? '', /passes the build hook alone and no pair/);
  assert.match(describeRelease(out, 'c')!.detail!, /Isolation found no culprit/);
});

test('a bounce posts a release_culprit event beside the build_failed note', async () => {
  const types: string[] = [];
  const w = { updateTicket: async () => ({}), postEvent: async (_i: string, _b: string, _m: string, t?: string) => { types.push(t ?? ''); } };
  const b = planBuildFailureBounce('/nonexistent', { ticket: T('ISSUE-3'), branch: 'issue-3', hook: 'build', tail: 'x', how: 'pair', sibling: { key: 'ISSUE-2', branch: 'issue-2' } }, 'main', 'origin');
  await applyBuildFailureBounce(w, b, DEFAULT_CONTRACT, 'm', { emit: () => {}, warn: () => {} }, false);
  assert.deepEqual(types, ['build_failed', 'release_culprit']);
});

test('crew doctor states the isolation bound and the loop guard', () => {
  assert.match(selfRepairLine(undefined), new RegExp(`up to ${DEFAULT_ISOLATE_MAX_CANDIDATES} merged branches, ${ISOLATE_MAX_PAIRS} pairs`));
  assert.match(selfRepairLine(undefined), /handed back twice after a push escalates with an alert/);
  assert.match(selfRepairLine(0), /isolation is off/);
});

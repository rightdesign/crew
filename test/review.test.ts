import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRelease } from '../src/release-run.ts';
import { applyReview, parsePrRef, reviewProblems } from '../src/review.ts';
import { parseRepoConfig, resolveRepoConfig } from '../src/repo-config.ts';
import { DEFAULT_CONTRACT, type Contract } from '../src/contract.ts';
import { Emitter } from '../src/events.ts';
import type { Ticket } from '../src/tracker.ts';

const CONTRACT: Contract = {
  ...DEFAULT_CONTRACT,
  statuses: {
    ...DEFAULT_CONTRACT.statuses,
    reviewing: 'in_review',
    open: [...DEFAULT_CONTRACT.statuses.open, 'in_review'],
  },
};

const T = (over: Partial<Ticket> = {}): Ticket =>
  ({ id: 'rec-7', issue_id: 'ISSUE-7', title: 'Star records', status: 'verified', updated_at: '2026-10-06T00:00:00Z', ...over }) as Ticket;

const lines: string[] = [];
const emitter = () => { lines.length = 0; return new Emitter({ route: 'c', console: (l) => lines.push(l), cycleId: 'C' }); };

const YAML = (extra = '') => `version: 1
hooks:
  test: exit 0
  build: exit 0
  merged: exit 1
${extra}release:
  mode: external
  versioning: none
  tag: false
  changelog: false
branch:
  push: "crew/{key}"
`;

/** A repo with origin = a bare remote, and a built `issue-7` branch. */
function project(yaml: string) {
  const bare = mkdtempSync(join(tmpdir(), 'crew-review-bare-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare, stdio: 'pipe' });
  const dir = mkdtempSync(join(tmpdir(), 'crew-review-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  writeFileSync(join(dir, 'a.txt'), 'a'); g('add', '.'); g('commit', '-qm', 'base');
  g('remote', 'add', 'origin', bare); g('push', '-q', 'origin', 'main');
  g('checkout', '-qb', 'issue-7');
  writeFileSync(join(dir, 'f.txt'), 'x'); g('add', '.'); g('commit', '-qm', 'built it (ISSUE-7)');
  const built = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main');
  const repo = resolveRepoConfig(parseRepoConfig(yaml, '.crew.yaml'), undefined, dir);
  const remoteRefs = () => execFileSync('git', ['for-each-ref', '--format=%(refname:short)'], { cwd: bare, encoding: 'utf8' }).split('\n').filter(Boolean);
  return { dir, bare, g, repo, built, remoteRefs };
}

const run = (p: ReturnType<typeof project>, tickets: Ticket[], over: Record<string, unknown> = {}) =>
  runRelease({
    cwd: p.dir, repo: p.repo, contract: CONTRACT, tickets, emit: emitter(), dryRun: false,
    reviewColumns: { verifiedSha: true, prRef: true }, ...over,
  });

test('a verified ticket is pushed under branch.push and its PR hook runs with the ticket environment', async () => {
  const envFile = join(tmpdir(), `crew-review-env-${process.pid}`);
  const p = project(YAML(`  pr: |
    echo "$CREW_TICKET|$CREW_BRANCH|$CREW_BASE|$CREW_TITLE" > ${envFile}
    echo https://forge.example/pr/12
`));
  const out = await run(p, [T()]);
  assert.ok(p.remoteRefs().includes('crew/ISSUE-7'), 'pushed under the push template, not the local name');
  assert.ok(!p.remoteRefs().includes('issue-7'));
  assert.equal(out.review?.handoffs.length, 1);
  assert.equal(out.review?.handoffs[0]?.prRef, 'https://forge.example/pr/12');
  assert.equal(out.review?.handoffs[0]?.head, p.built);
  assert.equal(readFileSync(envFile, 'utf8').trim(), 'ISSUE-7|crew/ISSUE-7|main|ISSUE-7: Star records');
  assert.equal(out.merged.length, 0, 'the crew still merges nothing');
});

test('a failing PR hook still hands the branch off, recording the failure rather than a reference', async () => {
  const p = project(YAML('  pr: echo boom; exit 3\n'));
  const out = await run(p, [T()]);
  assert.ok(p.remoteRefs().includes('crew/ISSUE-7'));
  const h = out.review?.handoffs[0];
  assert.equal(h?.prRef, undefined);
  assert.equal(h?.prFailure?.code, 3);
  assert.match(h?.prFailure?.tail ?? '', /boom/);
});

test('a ticket that already carries a PR reference does not open a second pull request', async () => {
  const marker = join(tmpdir(), `crew-review-pr-${process.pid}`);
  const p = project(YAML(`  pr: touch ${marker}\n`));
  const out = await run(p, [T({ pr_ref: '#12' } as Partial<Ticket>)]);
  assert.equal(existsSync(marker), false);
  assert.equal(out.review?.handoffs[0]?.prRef, '#12');
});

test('without a reviewing status the repo behaves as before: nothing is pushed', async () => {
  const p = project(YAML());
  const out = await run(p, [T()], { contract: DEFAULT_CONTRACT });
  assert.equal(out.review, undefined);
  assert.deepEqual(p.remoteRefs().filter((r) => r !== 'main'), []);
});

test('a verified ticket whose branch moved past verified_sha goes back to QA instead of being pushed', async () => {
  const p = project(YAML());
  const out = await run(p, [T({ verified_sha: 'a'.repeat(40) } as Partial<Ticket>)]);
  assert.equal(out.review?.requeues.length, 1);
  assert.equal(out.review?.requeues[0]?.head, p.built);
  assert.equal(out.review?.handoffs.length, 0);
  assert.deepEqual(p.remoteRefs().filter((r) => r !== 'main'), []);
});

test('a verified ticket whose branch is exactly verified_sha is pushed', async () => {
  const p = project(YAML());
  const out = await run(p, [T({ verified_sha: p.built } as Partial<Ticket>)]);
  assert.equal(out.review?.handoffs.length, 1);
  assert.equal(out.review?.requeues.length, 0);
});

test('a reviewer pushing past verified_sha returns a reviewing ticket to QA', async () => {
  const p = project(YAML());
  await run(p, [T({ verified_sha: p.built } as Partial<Ticket>)]);
  // the reviewer's commit lands on the remote branch; the local one has not caught up
  const clone = mkdtempSync(join(tmpdir(), 'crew-review-clone-'));
  execFileSync('git', ['clone', '-q', '-b', 'crew/ISSUE-7', p.bare, clone], { stdio: 'pipe' });
  const cg = (...a: string[]) => execFileSync('git', a, { cwd: clone, stdio: 'pipe', encoding: 'utf8' }).trim();
  cg('config', 'user.email', 'r@r'); cg('config', 'user.name', 'R');
  writeFileSync(join(clone, 'review.txt'), 'nit'); cg('add', '.'); cg('commit', '-qm', 'address review');
  const theirs = cg('rev-parse', 'HEAD'); cg('push', '-q', 'origin', 'HEAD:crew/ISSUE-7');
  p.g('fetch', '-q', 'origin');

  const out = await run(p, [T({ status: 'in_review', verified_sha: p.built } as Partial<Ticket>)]);
  assert.equal(out.review?.requeues.length, 1);
  assert.equal(out.review?.requeues[0]?.head, theirs);
  assert.equal(out.review?.handoffs.length, 0);
});

test('a reviewing ticket whose branch still equals verified_sha is left alone', async () => {
  const p = project(YAML());
  await run(p, [T({ verified_sha: p.built } as Partial<Ticket>)]);
  const out = await run(p, [T({ status: 'in_review', verified_sha: p.built } as Partial<Ticket>)]);
  assert.equal(out.review, undefined);
});

test('a remote still BEHIND verified_sha is a push that has not happened, not a reviewer', async () => {
  const p = project(YAML());
  await run(p, [T({ verified_sha: p.built } as Partial<Ticket>)]);
  // QA bounced it, the builder added a commit, QA re-verified at the new head; nothing pushed yet
  p.g('checkout', '-q', 'issue-7');
  writeFileSync(join(p.dir, 'g.txt'), 'y'); p.g('add', '.'); p.g('commit', '-qm', 'fix after bounce (ISSUE-7)');
  const newer = p.g('rev-parse', 'HEAD'); p.g('checkout', '-q', 'main');
  const out = await run(p, [T({ verified_sha: newer } as Partial<Ticket>)]);
  assert.equal(out.review?.requeues.length, 0);
  assert.equal(out.review?.handoffs.length, 1);
});

test('without a verified_sha column there is no re-verification', async () => {
  const p = project(YAML());
  const out = await run(p, [T({ verified_sha: 'a'.repeat(40) } as Partial<Ticket>)], { reviewColumns: { verifiedSha: false, prRef: false } });
  assert.equal(out.review?.requeues.length, 0);
  assert.equal(out.review?.handoffs.length, 1);
});

test('hooks.merged receives the stored PR as CREW_PR and the pushed branch name', async () => {
  const envFile = join(tmpdir(), `crew-review-merged-${process.pid}`);
  const p = project(YAML().replace('merged: exit 1', `merged: echo "$CREW_PR|$CREW_BRANCH" > ${envFile}; exit 1`));
  await run(p, [T({ status: 'in_review', pr_ref: 'https://forge.example/pr/12' } as Partial<Ticket>)]);
  assert.equal(readFileSync(envFile, 'utf8').trim(), 'https://forge.example/pr/12|crew/ISSUE-7');
});

test('a dry run pushes nothing', async () => {
  const p = project(YAML());
  const out = await run(p, [T()], { dryRun: true });
  assert.deepEqual(p.remoteRefs().filter((r) => r !== 'main'), []);
  assert.equal(out.review, undefined);
  assert.ok(lines.some((l) => /would push issue-7 to origin\/crew\/ISSUE-7/.test(l)));
});

test('a push template naming no ticket is refused', () => {
  const bad = resolveRepoConfig(parseRepoConfig(YAML().replace('crew/{key}', 'crew/{slug}'), '.crew.yaml'), undefined, tmpdir());
  assert.equal(reviewProblems(bad, CONTRACT).length, 1);
  assert.deepEqual(reviewProblems(bad, DEFAULT_CONTRACT), []);
  const good = resolveRepoConfig(parseRepoConfig(YAML(), '.crew.yaml'), undefined, tmpdir());
  assert.deepEqual(reviewProblems(good, CONTRACT), []);
});

test('parsePrRef takes a lone line, else the last URL or number', () => {
  assert.equal(parsePrRef('https://x/pr/1\n'), 'https://x/pr/1');
  assert.equal(parsePrRef('Creating pull request...\nhttps://x/pr/2\n'), 'https://x/pr/2');
  assert.equal(parsePrRef('Creating pull request...\nwarning: something\n'), undefined);
});

test('applyReview moves a handed-off ticket to reviewing with its PR, and a moved branch back to fixed', async () => {
  const updates: { id: string; patch: Record<string, unknown>; at?: string }[] = [];
  const events: { id: string; body: string }[] = [];
  const tracker = {
    updateTicket: async (id: string, patch: Record<string, unknown>, at?: string) => { updates.push({ id, patch, at }); return {} as Ticket; },
    postEvent: async (id: string, body: string) => { events.push({ id, body }); },
  };
  await applyReview(tracker, CONTRACT, {
    handoffs: [{ ticket: T(), pushedAs: 'crew/ISSUE-7', head: 'b'.repeat(40), prRef: '#12' }],
    requeues: [{ ticket: T({ id: 'rec-8', issue_id: 'ISSUE-8' }), verified: 'a'.repeat(40), head: 'c'.repeat(40) }],
  }, 'origin', emitter(), 'seat-1', { verifiedSha: true, prRef: true }, false);
  assert.deepEqual(updates[0], { id: 'rec-7', patch: { status: 'in_review', pr_ref: '#12' }, at: '2026-10-06T00:00:00Z' });
  assert.deepEqual(updates[1]?.patch, { status: 'fixed' });
  assert.match(events[0]!.body, /Pull request: #12/);
  assert.match(events[1]!.body, /aaaaaaaa.*cccccccc/);
});

test('applyReview leaves pr_ref out when the table has no such column', async () => {
  const updates: Record<string, unknown>[] = [];
  const tracker = {
    updateTicket: async (_id: string, patch: Record<string, unknown>) => { updates.push(patch); return {} as Ticket; },
    postEvent: async () => {},
  };
  await applyReview(tracker, CONTRACT, {
    handoffs: [{ ticket: T(), pushedAs: 'crew/ISSUE-7', head: 'b'.repeat(40), prRef: '#12' }], requeues: [],
  }, 'origin', emitter(), 'seat-1', { verifiedSha: false, prRef: false }, false);
  assert.deepEqual(updates, [{ status: 'in_review' }]);
});

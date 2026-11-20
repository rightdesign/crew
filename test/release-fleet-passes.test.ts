import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFleetPasses, MAX_CONSECUTIVE_RELEASE_PASSES, type RepoReleaseSummary } from '../src/release-run.ts';

const sum = (outcome: RepoReleaseSummary['outcome']): RepoReleaseSummary => ({ scope: 's', tests: 'pass', outcome, detail: '' });

/** A fleet of repos `a`, `b` where `waitingFor` says how many verified tickets each has after each pass. */
function harness(opts: {
  outcomes: Record<string, RepoReleaseSummary['outcome']>;
  waiting: (key: string, pass: number) => number;
  refusedAfterPass?: number;
  cap?: number;
}) {
  const passes: Array<string[] | undefined> = [];
  const queries: string[] = [];
  const lines: string[] = [];
  const run = runFleetPasses<string>({
    pass: async (only) => {
      passes.push(only);
      return (only ?? Object.keys(opts.outcomes)).map((key) => ({ key, summary: sum(opts.outcomes[key]!) }));
    },
    waiting: async (key) => { queries.push(key); return opts.waiting(key, passes.length); },
    refused: () => opts.refusedAfterPass !== undefined && passes.length >= opts.refusedAfterPass,
    describe: (k) => `route/${k}`,
    emit: (l) => lines.push(l),
    cap: opts.cap,
  });
  return { run, passes, queries, lines };
}

test('repeats only the released repo that has tickets waiting, and logs it', async () => {
  const h = harness({ outcomes: { a: 'deployed', b: 'merged' }, waiting: (k, p) => (k === 'a' && p === 1 ? 4 : 0) });
  assert.equal(await h.run, 2);
  assert.deepEqual(h.passes, [undefined, ['a']]);
  assert.deepEqual(h.lines, ['release: repeating route/a — 4 verified tickets waiting']);
});

test('no repeat when nothing is waiting', async () => {
  const h = harness({ outcomes: { a: 'deployed' }, waiting: () => 0 });
  assert.equal(await h.run, 1);
  assert.equal(h.passes.length, 1);
  assert.deepEqual(h.lines, []);
});

test('no repeat and no board query for a repo that did not release', async () => {
  for (const outcome of ['nothing', 'build-failed', 'deploy-failed', 'tag-push-failed', 'skipped', 'error'] as const) {
    const h = harness({ outcomes: { a: outcome }, waiting: () => 3 });
    assert.equal(await h.run, 1, outcome);
    assert.deepEqual(h.queries, [], outcome);
  }
});

test('a pause set during the release prevents the repeat', async () => {
  const h = harness({ outcomes: { a: 'deployed' }, waiting: () => 2, refusedAfterPass: 1 });
  assert.equal(await h.run, 1);
  assert.deepEqual(h.queries, []);
});

test('the cap stops the repetition and is logged once', async () => {
  const h = harness({ outcomes: { a: 'deployed' }, waiting: () => 1, cap: 3 });
  assert.equal(await h.run, 3);
  assert.equal(h.lines.filter((l) => l.includes('3 consecutive passes')).length, 1);
  assert.equal(h.lines.filter((l) => l.includes('repeating')).length, 2);
});

test('default cap is a small constant', () => {
  assert.ok(MAX_CONSECUTIVE_RELEASE_PASSES >= 2 && MAX_CONSECUTIVE_RELEASE_PASSES <= 10);
});

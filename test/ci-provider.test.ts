import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ciProviderFor, ciRemoteOf, githubProvider, isQueryableCiProvider, logTail, type CiQuery } from '../src/ci-provider.ts';

const Q: CiQuery = { host: 'github.com', remote: 'acme/widgets', sha: 'abc1234def', tag: 'v1.3.0', base: 'main' };

/** Canned GitHub responses, shaped like the real API's. */
const RUNS = { workflow_runs: [
  { id: 11, name: 'Publish', html_url: 'https://github.com/acme/widgets/actions/runs/11', status: 'completed', conclusion: 'failure', head_branch: 'v1.3.0', event: 'push' },
  { id: 12, name: 'Docs', html_url: 'https://github.com/acme/widgets/actions/runs/12', status: 'completed', conclusion: 'success', head_branch: 'main', event: 'push' },
  { id: 13, name: 'Lint', html_url: 'https://github.com/acme/widgets/actions/runs/13', status: 'in_progress', conclusion: null, head_branch: 'main', event: 'push' },
  { id: 14, name: 'PR checks', status: 'completed', conclusion: 'failure', head_branch: 'feature', event: 'pull_request' },
  { id: 15, name: 'Cancelled', status: 'completed', conclusion: 'cancelled', head_branch: 'v1.3.0', event: 'push' },
] };
const JOBS = { jobs: [
  { id: 901, name: 'build', conclusion: 'success', steps: [] },
  { id: 902, name: 'test', conclusion: 'failure', steps: [{ name: 'Set up', conclusion: 'success' }, { name: 'Run tests', conclusion: 'failure' }] },
] };
const LOG = '2026-11-16T10:00:01.0000000Z ok 1\n2026-11-16T10:00:02.0000000Z not ok 2 - widgets render\n2026-11-16T10:00:03.0000000Z ##[error]Process completed with exit code 1.\n';

function fakeFetch(routes: Record<string, () => Response>, seen: Array<{ url: string; auth: string | null }> = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
    for (const [frag, make] of Object.entries(routes)) if (url.includes(frag)) return make();
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } });

test('runs: matches by commit and ref, skips pull-request runs, and classifies state', async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const p = githubProvider({ token: () => 'tkn', fetch: fakeFetch({ '/actions/runs?': () => json(RUNS) }, seen) });
  const got = await p.runs(Q);
  assert.ok(got.ok);
  assert.deepEqual(got.runs.map((r) => [r.id, r.state, r.ref]), [
    ['11', 'failed', 'tag'], ['12', 'passed', 'base'], ['13', 'pending', 'base'], ['15', 'other', 'tag'],
  ]);
  assert.match(seen[0]!.url, /^https:\/\/api\.github\.com\/repos\/acme\/widgets\/actions\/runs\?head_sha=abc1234def/);
  assert.equal(seen[0]!.auth, 'Bearer tkn');
});

test('failure: names the failing job and step and tails its log', async () => {
  const p = githubProvider({ token: () => 'tkn', fetch: fakeFetch({
    '/runs/11/jobs': () => json(JOBS), '/jobs/902/logs': () => new Response(LOG),
  }) });
  const f = await p.failure(Q, { id: '11', name: 'Publish', url: 'u', state: 'failed', ref: 'tag' });
  assert.equal(f.job, 'test');
  assert.equal(f.step, 'Run tests');
  assert.equal(f.logTail, 'ok 1\nnot ok 2 - widgets render\n##[error]Process completed with exit code 1.');
});

test('failure: a jobs request that fails still returns the run', async () => {
  const p = githubProvider({ token: () => 'tkn', fetch: fakeFetch({ '/jobs': () => new Response('x', { status: 500 }) }) });
  const run = { id: '11', name: 'Publish', url: 'u', state: 'failed' as const, ref: 'tag' as const };
  assert.deepEqual(await p.failure(Q, run), { run });
});

test('failing to ask is a reason, never a throw', async () => {
  const none = await githubProvider({ token: () => null, fetch: fakeFetch({}) }).runs(Q);
  assert.deepEqual(none, { ok: false, why: 'no readable forge credential for github.com' });
  const mk = async (res: () => Response): Promise<string> => {
    const r = await githubProvider({ token: () => 't', fetch: fakeFetch({ '/actions/runs': res }) }).runs(Q);
    return r.ok ? 'ok' : r.why;
  };
  assert.match(await mk(() => json({}, 403, { 'x-ratelimit-remaining': '0' })), /rate limiting/);
  assert.match(await mk(() => json({}, 403)), /cannot read acme\/widgets/);
  assert.match(await mk(() => json({}, 404)), /not visible/);
  assert.match(await mk(() => json({}, 502)), /HTTP 502/);
  const down = await githubProvider({ token: () => 't', fetch: (async () => { throw new Error('ENOTFOUND'); }) as typeof fetch }).runs(Q);
  assert.match(down.ok ? 'ok' : down.why, /unreachable: ENOTFOUND/);
});

test('a self-hosted host uses its /api/v3 root', async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  await githubProvider({ token: () => 't', fetch: fakeFetch({ '/actions/runs': () => json({ workflow_runs: [] }) }, seen) })
    .runs({ ...Q, host: 'git.example.com' });
  assert.match(seen[0]!.url, /^https:\/\/git\.example\.com\/api\/v3\/repos\/acme\/widgets\//);
});

test('only github has an implementation; buildkite, other and none are never queried', () => {
  const deps = { token: () => 't' };
  assert.equal(ciProviderFor('github', deps)?.name, 'github');
  for (const n of ['buildkite', 'other', 'none']) {
    assert.equal(ciProviderFor(n, deps), null);
    assert.equal(isQueryableCiProvider(n), false);
  }
});

test('ciRemoteOf reads https and scp-style remotes', () => {
  assert.deepEqual(ciRemoteOf('https://github.com/acme/widgets.git'), { host: 'github.com', remote: 'acme/widgets' });
  assert.deepEqual(ciRemoteOf('git@github.com:acme/widgets.git'), { host: 'github.com', remote: 'acme/widgets' });
  assert.equal(ciRemoteOf('/tmp/bare'), null);
  assert.equal(ciRemoteOf(null), null);
});

test('logTail keeps the last lines only', () => {
  assert.equal(logTail('a\nb\nc\nd\n', 2), 'c\nd');
});

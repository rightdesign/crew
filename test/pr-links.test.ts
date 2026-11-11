import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchWebUrl, pullWebUrl, type ForgesConfig } from '../src/forges.ts';
import {
  discoverPullRequests, linkDoctorLines, listPulls, prUrlFromRef, pushedBranchOf, selectPull, type DiscoveryTracker, type ForgePull,
} from '../src/pr-links.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import type { Route } from '../src/config.ts';
import type { RunnerEvent, Ticket } from '../src/tracker.ts';

test('branch and pull request URLs follow each forge\'s path shape', () => {
  assert.equal(branchWebUrl(undefined, 'o/r', 'crew/ISSUE-7'), 'https://github.com/o/r/tree/crew/ISSUE-7');
  assert.equal(branchWebUrl('github.com', 'o/r', 'a b/c#d'), 'https://github.com/o/r/tree/a%20b/c%23d');
  assert.equal(branchWebUrl('gitlab.com', 'g/sub/r', 'issue-7'), 'https://gitlab.com/g/sub/r/-/tree/issue-7');
  assert.equal(branchWebUrl('git.gitlab.example', 'g/r', 'x'), 'https://git.gitlab.example/g/r/-/tree/x');
  assert.equal(branchWebUrl('code.example.com', 'o/r', 'x'), 'https://code.example.com/o/r/tree/x');
  assert.equal(pullWebUrl('github.com', 'o/r', 12), 'https://github.com/o/r/pull/12');
  assert.equal(pullWebUrl('gitlab.com', 'g/r', '12'), 'https://gitlab.com/g/r/-/merge_requests/12');
});

test('no remote means no link rather than a guessed one', () => {
  assert.equal(branchWebUrl('github.com', '', 'x'), null);
  assert.equal(branchWebUrl('github.com', undefined, 'x'), null);
  assert.equal(pullWebUrl('github.com', null, 3), null);
});

test('what hooks.pr printed becomes a full URL', () => {
  assert.equal(prUrlFromRef('https://forge.example/pr/12', 'github.com', 'o/r'), 'https://forge.example/pr/12');
  assert.equal(prUrlFromRef('12', 'github.com', 'o/r'), 'https://github.com/o/r/pull/12');
  assert.equal(prUrlFromRef('#12', 'gitlab.com', 'g/r'), 'https://gitlab.com/g/r/-/merge_requests/12');
  assert.equal(prUrlFromRef('see the PR', 'github.com', 'o/r'), null);
  assert.equal(prUrlFromRef('12', 'github.com', undefined), null);
});

const pull = (n: number, createdAt: string, open = false): ForgePull => ({ url: `https://github.com/o/r/pull/${n}`, number: n, open, createdAt });

test('selection prefers the open pull request', () => {
  const got = selectPull([pull(1, '2026-01-01T00:00:00Z'), pull(2, '2026-11-02T00:00:00Z', true), pull(3, '2026-11-03T00:00:00Z')], '2026-11-01T00:00:00Z');
  assert.equal(got?.number, 2);
});

test('with none open, the newest one created after the first push wins', () => {
  const got = selectPull([pull(1, '2026-11-02T00:00:00Z'), pull(2, '2026-11-04T00:00:00Z')], '2026-11-01T00:00:00Z');
  assert.equal(got?.number, 2);
});

test('a branch name reused from an older merged pull request does not attach it', () => {
  assert.equal(selectPull([pull(1, '2026-01-01T00:00:00Z')], '2026-11-01T00:00:00Z'), null);
  assert.equal(selectPull([pull(1, '2026-11-02T00:00:00Z')], null), null);
  assert.equal(selectPull([], '2026-11-01T00:00:00Z'), null);
});

test('the pushed branch is read from the pushed event', () => {
  assert.equal(pushedBranchOf(`pushed ${'a'.repeat(40)} to origin/crew/ISSUE-7`), 'crew/ISSUE-7');
  assert.equal(pushedBranchOf('something else'), null);
});

const res = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });

test('listPulls reads GitHub and GitLab answers', async () => {
  let seen = '';
  const gh = await listPulls('github.com', 'o/r', 'crew/ISSUE-7', 't', async (url) => {
    seen = url;
    return res(200, [{ number: 4, html_url: 'https://github.com/o/r/pull/4', state: 'open', created_at: '2026-11-02T00:00:00Z' }]);
  });
  assert.match(seen, /^https:\/\/api\.github\.com\/repos\/o\/r\/pulls\?head=o%3Acrew%2FISSUE-7/);
  assert.deepEqual(gh, [{ url: 'https://github.com/o/r/pull/4', number: 4, open: true, createdAt: '2026-11-02T00:00:00Z' }]);
  const gl = await listPulls('gitlab.com', 'g/r', 'x', 't', async (url, init) => {
    seen = url;
    assert.equal(init.headers['PRIVATE-TOKEN'], 't');
    return res(200, [{ iid: 9, web_url: 'https://gitlab.com/g/r/-/merge_requests/9', state: 'merged', created_at: '2026-11-02T00:00:00Z' }]);
  });
  assert.match(seen, /projects\/g%2Fr\/merge_requests\?source_branch=x/);
  assert.equal(gl[0]?.open, false);
  await assert.rejects(() => listPulls('github.com', 'o/r', 'x', 't', async () => res(403, {})), /403/);
});

// A Route reduced to what repo lookup reads; cast once here because the full type carries unrelated config.
const route = {
  route: 'w/p', dir: '/x', repos: {}, dirIsCloneBase: true, reposBasePath: '/b',
  resolved: { repoNames: { r1: 'crew' }, repoRemotes: { r1: 'o/r' } },
} as unknown as Route;

const forges: ForgesConfig = { 'github.com': { username: 'x', token: { source: 'env', var: 'FORGE_T' } } };
const TICKET = { id: 'rec-1', issue_id: 'ISSUE-7', repo_id: 'r1', status: 'in_progress' } as Ticket;
const PUSHED: RunnerEvent = { record_id: 'rec-1', event_type: 'pushed', message: `pushed ${'a'.repeat(40)} to origin/crew/ISSUE-7`, occurred_at: '2026-11-01T00:00:00Z' };

function harness(cols: { branchUrl: boolean; prUrl: boolean; prRef: boolean }) {
  const calls = { linkColumns: 0, events: 0, updates: [] as Array<Record<string, unknown>> };
  const tracker: DiscoveryTracker = {
    contract: DEFAULT_CONTRACT,
    async linkColumns() { calls.linkColumns++; return cols; },
    async events() { calls.events++; return [PUSHED]; },
    async updateTicket(_id, patch) { calls.updates.push(patch); return {}; },
  };
  const logs: string[] = [];
  const log = { emit: (m: string) => logs.push(m), warn: (m: string) => logs.push(`WARN ${m}`) };
  return { calls, tracker, logs, log };
}

test('a hand-opened pull request lands in pr_url and fills an empty pr_ref', async () => {
  const h = harness({ branchUrl: true, prUrl: true, prRef: true });
  const n = await discoverPullRequests({
    tracker: h.tracker, route, forges, stateDir: '/s', tickets: [TICKET], log: h.log, env: { FORGE_T: 'tok' }, warnedHosts: new Set(),
    fetcher: async () => res(200, [{ number: 5, html_url: 'https://github.com/o/r/pull/5', state: 'open', created_at: '2026-11-02T00:00:00Z' }]),
  });
  assert.equal(n, 1);
  assert.deepEqual(h.calls.updates, [{ pr_url: 'https://github.com/o/r/pull/5', pr_ref: 'https://github.com/o/r/pull/5' }]);
});

test('an existing pr_ref is kept and a ticket with pr_url set is not looked up again', async () => {
  const h = harness({ branchUrl: false, prUrl: true, prRef: true });
  let asked = 0;
  const fetcher = async () => { asked++; return res(200, [{ number: 5, html_url: 'https://github.com/o/r/pull/5', state: 'open', created_at: '2026-11-02T00:00:00Z' }]); };
  const base = { tracker: h.tracker, route, forges, stateDir: '/s', log: h.log, env: { FORGE_T: 'tok' }, warnedHosts: new Set<string>(), fetcher };
  await discoverPullRequests({ ...base, tickets: [{ ...TICKET, pr_ref: '#9' } as Ticket] });
  assert.deepEqual(h.calls.updates, [{ pr_url: 'https://github.com/o/r/pull/5' }]);
  await discoverPullRequests({ ...base, tickets: [{ ...TICKET, pr_url: 'https://x/1' } as Ticket] });
  assert.equal(asked, 1);
});

test('a table without pr_url behaves as before: no event read, no forge call, no write', async () => {
  const h = harness({ branchUrl: true, prUrl: false, prRef: true });
  let asked = 0;
  const n = await discoverPullRequests({
    tracker: h.tracker, route, forges, stateDir: '/s', tickets: [TICKET], log: h.log, env: { FORGE_T: 'tok' },
    fetcher: async () => { asked++; return res(200, []); },
  });
  assert.equal(n, 0);
  assert.equal(asked, 0);
  assert.equal(h.calls.events, 0);
  assert.equal(h.calls.updates.length, 0);
  assert.deepEqual(h.logs, []);
});

test('a forge with no stored token is skipped without a failure or a forge call', async () => {
  const h = harness({ branchUrl: true, prUrl: true, prRef: true });
  let asked = 0;
  const n = await discoverPullRequests({
    tracker: h.tracker, route, forges: undefined, stateDir: '/s', tickets: [TICKET], log: h.log,
    fetcher: async () => { asked++; return res(200, []); },
  });
  assert.equal(n, 0);
  assert.equal(asked, 0);
  assert.deepEqual(h.logs, []);
});

test('a forge error or rate limit skips quietly and warns once per host', async () => {
  const h = harness({ branchUrl: true, prUrl: true, prRef: true });
  const warned = new Set<string>();
  const input = {
    tracker: h.tracker, route, forges, stateDir: '/s', tickets: [TICKET], log: h.log, env: { FORGE_T: 'tok' }, warnedHosts: warned,
    fetcher: async () => res(429, {}),
  };
  assert.equal(await discoverPullRequests(input), 0);
  assert.equal(await discoverPullRequests(input), 0);
  assert.equal(h.logs.filter((l) => l.startsWith('WARN')).length, 1);
  assert.equal(h.calls.updates.length, 0);
});

test('doctor reports the columns and names a repo whose forge has no token', () => {
  const lines = linkDoctorLines({ branchUrl: true, prUrl: true }, [{ name: 'crew', host: undefined }], undefined, '/s', {});
  assert.match(lines.join('\n'), /branch_url present/);
  assert.match(lines.join('\n'), /discovery unavailable for crew: no forge token stored for github\.com/);
  const absent = linkDoctorLines({ branchUrl: false, prUrl: false }, [{ name: 'crew', host: undefined }], undefined, '/s', {});
  assert.match(absent.join('\n'), /branch_url absent/);
  assert.doesNotMatch(absent.join('\n'), /discovery unavailable/);
  assert.equal(linkDoctorLines({ branchUrl: true, prUrl: true }, [{ name: 'crew', host: 'github.com' }], forges, '/s', { FORGE_T: 'tok' }).length, 2);
});

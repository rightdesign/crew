import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import { parseRepoConfig, resolveRepoConfig } from '../src/repo-config.ts';
import { enforceHandoff, type HandoffWriter } from '../src/handoff-guard.ts';
import {
  settleReviews, parseReviewUrl, parseReviewState, reviewUrlFrom, reviewOpenedBody, REVIEW_CHANGES_MARKER,
} from '../src/external-review.ts';
import type { Comment, Ticket } from '../src/tracker.ts';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'review-'));
  const dir = join(root, 'repo');
  const bare = join(root, 'origin.git');
  sh(root, 'init', '-q', '-b', 'main', dir);
  sh(dir, 'config', 'user.email', 't@example.com');
  sh(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'a');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-qm', 'base');
  sh(root, 'init', '-q', '--bare', bare);
  sh(dir, 'remote', 'add', 'origin', bare);
  sh(dir, 'push', '-q', 'origin', 'main');
  const wt = join(root, 'repo-crew-9');
  sh(dir, 'worktree', 'add', '-q', wt, '-b', 'crew-9');
  writeFileSync(join(wt, 'b.txt'), 'b');
  sh(wt, 'add', '.');
  sh(wt, 'commit', '-qm', 'work');
  sh(wt, 'push', '-q', '--set-upstream', 'origin', 'crew-9');
  return { dir, wt };
}

const external = (dir: string, hooks: string) => resolveRepoConfig(parseRepoConfig(
  `version: 1\nhooks:\n  test: t\n  build: b\n${hooks}release:\n  mode: external\n`, 'f'), undefined, dir);

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'row-9', issue_id: 'ISSUE-9', issue_tag: 'CREW-9', project_issue_prefix: 'CREW', title: 'Do the thing',
  status: 'fixed', assignee_id: null, updated_at: '2026-01-01T00:00:00Z', ...over,
});

function harness(t: Ticket, comments: Partial<Comment>[] = []) {
  const patches: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  const warns: string[] = [];
  const w: HandoffWriter = {
    ticket: async () => t,
    updateTicket: async (_id, p) => { patches.push(p); return {}; },
    postEvent: async (_id, body) => { notes.push(body); },
    comments: async () => comments as Comment[],
  };
  return { w, patches, notes, warns, log: { emit: () => {}, warn: (m: string) => { warns.push(m); } } };
}

const handoff = (f: ReturnType<typeof fixture>, h: ReturnType<typeof harness>, hooks: string) => enforceHandoff({
  writer: h.w, contract: DEFAULT_CONTRACT, ticketId: 'row-9', role: 'dev', dir: f.dir,
  cfg: external(f.dir, hooks), seatId: 'seat-dev', log: h.log,
});

test('external hand-off opens the PR, records its URL and parks the ticket in review, not at fixed', async () => {
  const f = fixture();
  const h = harness(ticket());
  const out = await handoff(f, h, '  pr: |\n    echo "opening $CREW_BRANCH against $CREW_BASE for $CREW_TICKET"\n    echo "https://forge.example/pr/7"\n');
  assert.deepEqual(out, { kind: 'in-review', sha: sh(f.wt, 'rev-parse', 'HEAD'), url: 'https://forge.example/pr/7' });
  assert.deepEqual(h.patches, [{ status: 'in_progress', needs_review: true, assignee_id: null }]);
  assert.equal(reviewUrlFrom(h.notes.map((body) => ({ body }))), 'https://forge.example/pr/7');
});

test('external hand-off hands the pr hook the ticket, branch, base and title', async () => {
  const f = fixture();
  const h = harness(ticket());
  await handoff(f, h, '  pr: echo "https://x.example/$CREW_TICKET/$CREW_BRANCH/$CREW_BASE/${CREW_TITLE// /_}"\n');
  assert.match(h.notes.join('\n'), /https:\/\/x\.example\/ISSUE-9\/crew-9\/main\/CREW-9:_Do_the_thing/);
});

test('a failing pr hook still parks the ticket in review and says why — QA never gets an unmerged branch', async () => {
  const f = fixture();
  const h = harness(ticket());
  const out = await handoff(f, h, '  pr: |\n    echo "gh: not logged in" >&2\n    exit 4\n');
  assert.equal(out.kind, 'in-review');
  assert.deepEqual(h.patches, [{ status: 'in_progress', needs_review: true, assignee_id: null }]);
  assert.match(h.notes.join('\n'), /could not be opened/);
  assert.match(h.notes.join('\n'), /not logged in/);
  assert.equal(reviewUrlFrom(h.notes.map((body) => ({ body }))), null);
});

test('a re-hand-off after changes were requested reuses the PR instead of opening another', async () => {
  const f = fixture();
  const h = harness(ticket(), [{ ticket_id: 'row-9', body: reviewOpenedBody('https://forge.example/pr/7', 'crew-9') }]);
  const out = await handoff(f, h, '  pr: echo "https://forge.example/pr/NEW"\n');
  assert.equal(out.kind === 'in-review' && out.url, 'https://forge.example/pr/7');
  assert.ok(!h.notes.some((n) => /pr\/NEW/.test(n)));
});

test('parsers: the URL is the last URL-looking line; state defaults to open', () => {
  assert.equal(parseReviewUrl('creating...\nhttps://a.example/1\n'), 'https://a.example/1');
  assert.equal(parseReviewUrl('nothing here'), null);
  assert.equal(parseReviewState('approved\n'), 'approved');
  assert.equal(parseReviewState('noise\nchanges_requested'), 'changes_requested');
  assert.equal(parseReviewState('REVIEW_REQUIRED'), 'open');
  assert.equal(parseReviewState(''), 'open');
});

function settle(f: ReturnType<typeof fixture>, hooks: string, tickets: Ticket[], comments: Partial<Comment>[] = []) {
  const patches: Array<[string, Record<string, unknown>]> = [];
  const notes: string[] = [];
  const tracker = {
    updateTicket: async (id: string, p: Record<string, unknown>) => { patches.push([id, p]); return ticket();  },
    postEvent: async (_id: string, body: string) => { notes.push(body); },
    comments: async () => comments as Comment[],
  };
  const run = () => settleReviews({
    tracker, contract: DEFAULT_CONTRACT, cfg: external(f.dir, hooks), tickets, cwd: f.dir, devSeatId: 'seat-dev',
    branchFor: () => 'crew-9', log: { emit: () => {}, warn: () => {} },
  });
  return { run, patches, notes };
}

const reviewing = (over: Partial<Ticket> = {}) => ticket({ status: 'in_progress', needs_review: true, ...over });

test('settle: a landed branch is promoted to fixed with the review gate cleared', async () => {
  const f = fixture();
  const s = settle(f, '  pr: p\n  merged: exit 0\n', [reviewing()]);
  const out = await s.run();
  assert.deepEqual(out, { promoted: ['ISSUE-9'], bounced: [] });
  assert.deepEqual(s.patches, [['row-9', { status: 'fixed', needs_review: false, assignee_id: null }]]);
});

test('settle: changes_requested returns the ticket to the dev seat', async () => {
  const f = fixture();
  const s = settle(f, '  pr: p\n  merged: exit 1\n  review: echo changes_requested\n', [reviewing()],
    [{ ticket_id: 'row-9', body: reviewOpenedBody('https://forge.example/pr/7', 'crew-9') }]);
  const out = await s.run();
  assert.deepEqual(out, { promoted: [], bounced: ['ISSUE-9'] });
  assert.deepEqual(s.patches, [['row-9', { status: 'in_progress', needs_review: false, assignee_id: 'seat-dev' }]]);
  assert.match(s.notes[0]!, new RegExp(REVIEW_CHANGES_MARKER));
  assert.match(s.notes[0]!, /pr\/7/);
});

test('settle: an open or approved review changes nothing; neither does a ticket not in review', async () => {
  const f = fixture();
  for (const word of ['open', 'approved']) {
    const s = settle(f, `  pr: p\n  merged: exit 1\n  review: echo ${word}\n`, [reviewing()]);
    assert.deepEqual(await s.run(), { promoted: [], bounced: [] });
    assert.deepEqual(s.patches, []);
  }
  const s = settle(f, '  pr: p\n  merged: exit 0\n', [ticket({ status: 'in_progress' }), ticket({ status: 'fixed', needs_review: true })]);
  assert.deepEqual(await s.run(), { promoted: [], bounced: [] });
});

test('settle: without a review hook only merged is watched, and the hook sees the PR URL', async () => {
  const f = fixture();
  const s = settle(f, '  pr: p\n  merged: exit 1\n', [reviewing()]);
  assert.deepEqual(await s.run(), { promoted: [], bounced: [] });
  const t = settle(f, '  pr: p\n  merged: exit 1\n  review: |\n    [ "$CREW_REVIEW_URL" = "https://forge.example/pr/7" ] && echo changes_requested\n', [reviewing()],
    [{ ticket_id: 'row-9', body: reviewOpenedBody('https://forge.example/pr/7', 'crew-9') }]);
  assert.deepEqual((await t.run()).bounced, ['ISSUE-9']);
});

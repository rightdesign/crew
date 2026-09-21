import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * ASYNC on purpose. The fake tracker runs in THIS process, so a synchronous
 * child would block the event loop and the server could never answer it —
 * the crew would hang waiting for a reply this process could not send.
 */
const run = promisify(execFile);
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FakeTracker, MODELS, SEATS, OPERATOR, crewRows, ticket } from './helpers/fake-tracker.ts';

import { CREW, CREW_ENV } from './helpers/crew-bin.ts';

/** A whole ship: config, state dir, a git checkout, pointed at the fake. */
function ship(tracker: FakeTracker, over: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'crew-it-'));
  const repo = join(home, 'project');
  mkdirSync(repo);
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  writeFileSync(join(repo, 'README.md'), 'x'); g('add', '.'); g('commit', '-qm', 'base');
  writeFileSync(join(home, '.env'), 'KEY=test-key\n');

  const cfg = `ship:
  name: Test Ship
  agent: { bin: /bin/echo }
  stateDir: state
  logFile: ${join(home, 'crew.log')}
routes:
  - route: test/proj
    enabled: true
    dir: ${repo}
    worktreePrefix: proj-issue-
    baseUrl: ${tracker.baseUrl}
    apiKeyFile: ${join(home, '.env')}
    apiKeyVar: KEY
${over.extra ?? ''}    resolved:
      workspaceId: ws-1
      models: { issues: ${MODELS.issues}, comments: ${MODELS.comments}, crew: ${MODELS.crew} }
      seats: { dev: ${SEATS.dev}, design: ${SEATS.design}, qa: ${SEATS.qa} }
      operator: ${OPERATOR}
${over.resolvedExtra ?? ''}`;
  const cfgPath = join(home, 'crew.yaml');
  writeFileSync(cfgPath, cfg);
  return {
    home, repo, cfgPath,
    run: async (...args: string[]) => {
      const { stdout, stderr } = await run(process.execPath, [CREW, ...args], {
        env: { ...process.env, ...CREW_ENV, CREW_CONFIG: cfgPath },
        timeout: 30_000,
      });
      return `${stdout}${stderr}`;
    },
  };
}

test('a real cycle PARKS a blocked ticket in the tracker, not just in the log', async () => {
  // The bug this exists for: planSweep was computed, logged, and never
  // applied. Every unit test passed; the tracker stayed wrong.
  const t = await new FakeTracker()
    .table(MODELS.crew, crewRows())
    .table(MODELS.comments, [])
    .table(MODELS.issues, [
      ticket({ id: 'i1', issue_id: 'ISSUE-1', status: 'accepted', blocked_by: ['i2'] }),
      ticket({ id: 'i2', issue_id: 'ISSUE-2', status: 'in_progress' }),
    ])
    .start();
  try {
    const s = ship(t);
    await s.run('poll', 'test/proj');
    assert.equal(t.row(MODELS.issues, 'i1')?.status, 'blocked', 'the blocked ticket must actually be parked');
    assert.ok(t.writes.some((w) => w.method === 'PATCH' && w.id === 'i1' && w.body.status === 'blocked'));
    // and it explains itself
    assert.ok(t.writes.some((w) => w.method === 'POST' && w.model === MODELS.comments
      && String(w.body.body).includes('Parked as **Blocked**') && w.body.kind === 'event'));
  } finally { await t.stop(); }
});

test('a real cycle RESTORES one whose blockers resolved', async () => {
  const t = await new FakeTracker()
    .table(MODELS.crew, crewRows())
    .table(MODELS.comments, [])
    .table(MODELS.issues, [
      ticket({ id: 'i1', issue_id: 'ISSUE-1', status: 'blocked', blocked_by: ['i2'] }),
      ticket({ id: 'i2', issue_id: 'ISSUE-2', status: 'verified' }),
    ])
    .start();
  try {
    await ship(t).run('poll', 'test/proj');
    assert.equal(t.row(MODELS.issues, 'i1')?.status, 'accepted');
  } finally { await t.stop(); }
});

test('a dry run writes NOTHING to the tracker', async () => {
  const t = await new FakeTracker()
    .table(MODELS.crew, crewRows())
    .table(MODELS.comments, [])
    .table(MODELS.issues, [
      ticket({ id: 'i1', issue_id: 'ISSUE-1', status: 'accepted', blocked_by: ['i2'] }),
      ticket({ id: 'i2', issue_id: 'ISSUE-2', status: 'in_progress' }),
    ])
    .start();
  try {
    const out = await ship(t).run('poll', 'test/proj', '--dry-run');
    assert.match(out + '', /[\s\S]*/);
    assert.equal(t.writes.length, 0, 'a dry run must not write');
    assert.equal(t.row(MODELS.issues, 'i1')?.status, 'accepted');
  } finally { await t.stop(); }
});

test('ISSUE-385: a ticket whose epic is in progress digests ahead of an identical one with no epic', async () => {
  const EPICS = 'm-epics';
  const t = await new FakeTracker()
    .table(MODELS.crew, crewRows())
    .table(MODELS.comments, [])
    .table(EPICS, [
      { id: 'e1', status: 'in_progress' },
      { id: 'e2', status: 'planned' },
    ])
    .table(MODELS.issues, [
      // Same severity, same priority, filed in numeric order — without the
      // epic tiebreaker ISSUE-1 would digest first (older wins ties).
      ticket({ id: 'i1', issue_id: 'ISSUE-1', status: 'accepted', severity: 's3' }),
      ticket({ id: 'i2', issue_id: 'ISSUE-2', status: 'accepted', severity: 's3', epic_id: 'e1' }),
    ])
    .start();
  try {
    const s = ship(t, { resolvedExtra: `      epicsModelId: ${EPICS}\n` });
    await s.run('poll', 'test/proj');
    const digest = readFileSync(join(s.home, 'state', 'digest-test-proj-dev.md'), 'utf8');
    const i1 = digest.indexOf('ISSUE-1');
    const i2 = digest.indexOf('ISSUE-2');
    assert.ok(i2 >= 0 && i1 >= 0 && i2 < i1, 'the in-progress-epic ticket must digest first');
  } finally { await t.stop(); }
});

test('the poll writes a digest and advances the watermark on disk', async () => {
  // Both were tested units that nothing called.
  const t = await new FakeTracker()
    .table(MODELS.crew, crewRows())
    .table(MODELS.comments, [{ id: 'c1', ticket_id: 'i1', team_member_id: OPERATOR, created_at: '2026-08-02T00:00:00.000Z' }])
    .table(MODELS.issues, [ticket({ id: 'i1', issue_id: 'ISSUE-1', status: 'accepted' })])
    .start();
  try {
    const s = ship(t);
    await s.run('poll', 'test/proj');
    const digest = join(s.home, 'state', 'digest-test-proj-dev.md');
    assert.ok(existsSync(digest), 'the digest must be written, or the agent refetches everything');
    assert.match(readFileSync(digest, 'utf8'), /ISSUE-1/);
    const wm = readFileSync(join(s.home, 'state', '.poll-watermark'), 'utf8').trim();
    assert.notEqual(wm, '1970-01-01T00:00:00.000Z', 'the watermark must advance, or every comment stays "new"');
  } finally { await t.stop(); }
});

test('a second run of the SAME role is skipped while the first holds it (ISSUE-381)', async () => {
  const t = await new FakeTracker()
    .table(MODELS.crew, crewRows()).table(MODELS.comments, [])
    .table(MODELS.issues, [ticket({ id: 'i1', issue_id: 'ISSUE-1', status: 'accepted' })])
    .start();
  try {
    const s = ship(t);
    mkdirSync(join(s.home, 'state'), { recursive: true });
    // The role this ticket resolves to (dev) is locked by a live pid — a
    // role-distinct lock, not the old single blanket 'crew' one.
    writeFileSync(join(s.home, 'state', '.crew-role-dev.lock'), `${process.pid}\n`);
    const out = await s.run('run', 'test/proj');
    assert.match(out, /dev skipped this cycle — dev is already running \(pid \d+\)/);
    // The rest of the cycle still runs — a locked role must not also block
    // the release phase, exactly as "no role to run" does not.
    assert.match(out, /nothing to release|nothing merged/);
  } finally { await t.stop(); }
});

test('two DIFFERENT roles may run at once, up to the configured limit (ISSUE-381)', async () => {
  const t = await new FakeTracker()
    .table(MODELS.crew, crewRows()).table(MODELS.comments, [])
    .table(MODELS.issues, [ticket({ id: 'i1', issue_id: 'ISSUE-1', status: 'accepted' })])
    .start();
  try {
    const s = ship(t);
    mkdirSync(join(s.home, 'state'), { recursive: true });
    // Every capacity slot is taken by some OTHER role's live session — the
    // ship is simply at capacity, distinct from a same-role collision.
    writeFileSync(join(s.home, 'state', '.crew-slot-1.lock'), `${process.pid}\n`);
    writeFileSync(join(s.home, 'state', '.crew-slot-2.lock'), `${process.pid}\n`);
    const out = await s.run('run', 'test/proj');
    assert.match(out, /dev skipped this cycle — at capacity — 2 agent\(s\) already running/);
  } finally { await t.stop(); }
});

test('a disabled route refuses to run but still reports', async () => {
  const t = await new FakeTracker()
    .table(MODELS.crew, crewRows()).table(MODELS.comments, [])
    .table(MODELS.issues, [ticket({ id: 'i1', issue_id: 'ISSUE-1', status: 'accepted' })])
    .start();
  try {
    const s = ship(t, {});
    const cfg = join(s.home, 'crew.yaml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('enabled: true', 'enabled: false'));
    const out = await s.run('run', 'test/proj');
    assert.match(out, /not enabled/);
    assert.ok(!t.writes.some((w) => w.method === 'PATCH'), 'a disabled route must not write');
  } finally { await t.stop(); }
});

test('a cycle with NO agent work still runs the release phase', async () => {
  // The bug this pins: `run` returned at "nothing to run this cycle" before
  // reaching the release, so verified branches sat unmerged indefinitely —
  // and a cycle with no agent work is exactly when they are most likely to be
  // waiting.
  const t = await new FakeTracker()
    .table(MODELS.crew, crewRows()).table(MODELS.comments, [])
    // verified, but no branch exists, so the merge phase has nothing to do —
    // what matters is that the release phase RAN and said so.
    .table(MODELS.issues, [ticket({ id: 'i1', issue_id: 'ISSUE-1', status: 'verified' })])
    .start();
  try {
    const out = await ship(t).run('run', 'test/proj');
    assert.match(out, /no role to run this cycle/);
    assert.match(out, /release:/, 'the release phase must still run');
  } finally { await t.stop(); }
});

test('a release held by another ship on the board is skipped, not merged twice (ISSUE-394)', async () => {
  // `relLock` in cli.ts only ever excluded two processes on ONE machine.
  // With a Locks table configured and its row already held (fresh, a
  // different holder), the release must skip before touching the repo at
  // all — proving the board-CAS check is actually wired into the CLI path,
  // not just correct in isolation (that half is board-lock.test.ts).
  const LOCKS = 'm-locks';
  const t = await new FakeTracker()
    .table(MODELS.crew, crewRows()).table(MODELS.comments, [])
    .table(MODELS.issues, [ticket({ id: 'i1', issue_id: 'ISSUE-1', status: 'verified' })])
    .table(LOCKS, [{ id: 'lock-1', scope: 'test/proj/project', holder: 'other-ship:999', updated_at: new Date().toISOString() }])
    .start();
  try {
    const out = await ship(t, { resolvedExtra: `      locksModelId: ${LOCKS}\n` }).run('run', 'test/proj');
    assert.match(out, /claimed by another ship|held by other-ship:999/);
    assert.ok(!t.writes.some((w) => w.model === MODELS.issues), 'a skipped release must not touch the ticket');
  } finally { await t.stop(); }
});

test('--role runs exactly that seat and does not release', async () => {
  const t = await new FakeTracker()
    .table(MODELS.crew, crewRows()).table(MODELS.comments, [])
    .table(MODELS.issues, [ticket({ id: 'i1', issue_id: 'ISSUE-1', status: 'accepted' })])
    .start();
  try {
    const out = await ship(t).run('run', 'test/proj', '--role', 'dev');
    assert.doesNotMatch(out, /release:/);
  } finally { await t.stop(); }
});

test('ISSUE-395: the winning ticket is claimed (in_progress + assignee) before the agent runs, not left to it', async () => {
  const t = await new FakeTracker()
    .table(MODELS.crew, crewRows()).table(MODELS.comments, [])
    .table(MODELS.issues, [ticket({ id: 'i1', issue_id: 'ISSUE-1', status: 'accepted' })])
    .start();
  try {
    await ship(t).run('run', 'test/proj', '--role', 'dev');
    const claim = t.writes.find((w) => w.model === MODELS.issues && w.id === 'i1');
    assert.ok(claim, 'the poll itself must claim the ticket, not just the (here, no-op) agent');
    assert.equal(claim?.body.status, 'in_progress');
    assert.equal(claim?.body.assignee_id, SEATS.dev);
  } finally { await t.stop(); }
});

test('ISSUE-395: a ticket already claimed elsewhere is skipped for the next-ranked one', async () => {
  const t = await new FakeTracker()
    .table(MODELS.crew, crewRows()).table(MODELS.comments, [])
    .table(MODELS.issues, [
      // i1 ranks first (more severe) but is stale by the time the claim's
      // conditional write lands — as if another ship claimed it a moment
      // after this ship's poll fetched it. i2 is the fallback.
      ticket({ id: 'i1', issue_id: 'ISSUE-1', status: 'accepted', severity: 's1' }),
      ticket({ id: 'i2', issue_id: 'ISSUE-2', status: 'accepted', severity: 's3' }),
    ])
    .start();
  try {
    // Another ship's write lands on i1 right after this ship's poll reads
    // the ticket list, and before its own claim's conditional write does.
    t.raceOnNextList(MODELS.issues, () => {
      const row = t.row(MODELS.issues, 'i1')!;
      row.updated_at = new Date(Date.parse(String(row.updated_at)) + 1).toISOString();
    });
    const out = await ship(t).run('run', 'test/proj', '--role', 'dev');
    assert.match(out, /claim contended for ISSUE-1/);
    const claim = t.writes.find((w) => w.model === MODELS.issues);
    assert.equal(claim?.id, 'i2', 'the contended ticket must not be the one actually claimed');
    assert.equal(claim?.body.status, 'in_progress');
  } finally { await t.stop(); }
});

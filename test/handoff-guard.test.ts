import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import { resolveRepoConfig } from '../src/repo-config.ts';
import {
  inspectHandoff, enforceHandoff, guardStrayHandoffs, pushedEventBody, HANDOFF_BOUNCED_MARKER, STRAY_HANDOFF_MARKER,
  type HandoffWriter, type HandoffLog,
} from '../src/handoff-guard.ts';
import type { Ticket } from '../src/tracker.ts';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A primary checkout with a worktree on `crew-9`, and (optionally) an origin. */
function fixture(withRemote = true) {
  const root = mkdtempSync(join(tmpdir(), 'handoff-'));
  const dir = join(root, 'repo');
  const bare = join(root, 'origin.git');
  sh(root, 'init', '-q', '-b', 'main', dir);
  sh(dir, 'config', 'user.email', 't@example.com');
  sh(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'a');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-qm', 'base');
  if (withRemote) {
    sh(root, 'init', '-q', '--bare', bare);
    sh(dir, 'remote', 'add', 'origin', bare);
    sh(dir, 'push', '-q', 'origin', 'main');
  }
  const wt = join(root, 'repo-crew-9');
  sh(dir, 'worktree', 'add', '-q', wt, '-b', 'crew-9');
  writeFileSync(join(wt, 'b.txt'), 'b');
  sh(wt, 'add', '.');
  sh(wt, 'commit', '-qm', 'work');
  return { dir, wt, bare };
}

const cfg = (dir: string) => resolveRepoConfig(null, undefined, dir);
const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'row-9', issue_id: 'ISSUE-9', issue_tag: 'CREW-9', project_issue_prefix: 'CREW',
  status: 'fixed', assignee_id: null, updated_at: '2026-01-01T00:00:00Z', ...over,
});

test('passes when origin has the branch at the worktree HEAD', () => {
  const { dir, wt } = fixture();
  sh(wt, 'push', '-q', '--set-upstream', 'origin', 'crew-9');
  const v = inspectHandoff(dir, cfg(dir), ticket(), 'dev');
  assert.equal(v.kind, 'pushed');
  if (v.kind === 'pushed') assert.equal(v.sha, sh(wt, 'rev-parse', 'HEAD'));
});

test('bounces a branch that was never pushed', () => {
  const { dir } = fixture();
  const v = inspectHandoff(dir, cfg(dir), ticket(), 'dev');
  assert.equal(v.kind, 'bounce');
  if (v.kind === 'bounce') { assert.equal(v.origin, null); assert.match(v.reason, /never pushed/); }
});

test('bounces when origin is at a different sha than the worktree HEAD', () => {
  const { dir, wt } = fixture();
  sh(wt, 'push', '-q', '--set-upstream', 'origin', 'crew-9');
  writeFileSync(join(wt, 'c.txt'), 'c');
  sh(wt, 'add', '.');
  sh(wt, 'commit', '-qm', 'more work, unpushed');
  const v = inspectHandoff(dir, cfg(dir), ticket(), 'dev');
  assert.equal(v.kind, 'bounce');
  if (v.kind === 'bounce') {
    assert.equal(v.local, sh(wt, 'rev-parse', 'HEAD'));
    assert.notEqual(v.origin, v.local);
  }
});

test('skips a repo with no remote', () => {
  const { dir } = fixture(false);
  assert.equal(inspectHandoff(dir, cfg(dir), ticket(), 'dev').kind, 'unverified');
});

test('an unreachable remote is unverified, not a bounce', () => {
  const { dir, bare } = fixture();
  sh(dir, 'remote', 'set-url', 'origin', join(bare, 'does-not-exist'));
  assert.equal(inspectHandoff(dir, cfg(dir), ticket(), 'dev').kind, 'unverified');
});

function harness(t: Ticket) {
  const patches: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  const warns: string[] = [];
  const w: HandoffWriter = {
    ticket: async () => t,
    updateTicket: async (_id, p) => { patches.push(p); return {}; },
    postEvent: async (_id, body) => { notes.push(body); },
  };
  const log: HandoffLog = { emit: () => {}, warn: (m) => { warns.push(m); } };
  return { w, patches, notes, warns, log };
}

const input = (f: ReturnType<typeof fixture>, h: ReturnType<typeof harness>) => ({
  writer: h.w, contract: DEFAULT_CONTRACT, ticketId: 'row-9', role: 'dev', dir: f.dir, cfg: cfg(f.dir),
  seatId: 'seat-dev', shipName: 'Studio', hold: { column: 'held_by_ship_id', shipId: 'ship-A' }, log: h.log,
});

test('enforce: a matching push posts the pushed event and leaves the ticket at fixed', async () => {
  const f = fixture();
  sh(f.wt, 'push', '-q', '--set-upstream', 'origin', 'crew-9');
  const h = harness(ticket());
  const out = await enforceHandoff(input(f, h));
  assert.equal(out.kind, 'pushed');
  assert.deepEqual(h.patches, []);
  assert.deepEqual(h.notes, [pushedEventBody(sh(f.wt, 'rev-parse', 'HEAD'), 'origin', 'crew-9')]);
  assert.match(h.notes[0]!, /^pushed [0-9a-f]{40} to origin\/crew-9$/);
});

test('enforce: an unpushed fixed ticket goes back to in_progress, held by this ship again, with an event', async () => {
  const f = fixture();
  const h = harness(ticket({ assignee_id: null, held_by_ship_id: null }));
  const out = await enforceHandoff(input(f, h));
  assert.equal(out.kind, 'bounced');
  assert.deepEqual(h.patches, [{ status: 'in_progress', assignee_id: 'seat-dev', held_by_ship_id: 'ship-A' }]);
  assert.ok(h.notes[0]!.includes(HANDOFF_BOUNCED_MARKER));
  assert.match(h.notes[0]!, /Studio/);
  assert.match(h.notes[0]!, /never pushed/);
  assert.match(h.notes[0]!, /brief authorizes this push/);
});

test('enforce: assignee and hold the session left in place are not overwritten', async () => {
  const f = fixture();
  const h = harness(ticket({ assignee_id: 'other', held_by_ship_id: 'ship-A' }));
  await enforceHandoff(input(f, h));
  assert.deepEqual(h.patches, [{ status: 'in_progress' }]);
});

test('enforce: a ticket held by another ship is not bounced by a stale run (CREW-1973)', async () => {
  const f = fixture();
  const h = harness(ticket({ held_by_ship_id: 'ship-B' }));
  assert.equal((await enforceHandoff(input(f, h))).kind, 'unverified');
  assert.deepEqual(h.patches, []);
  assert.deepEqual(h.notes, []);
  assert.equal(h.warns.length, 1);
});

test('enforce: a takeover by another ship during the run blocks the bounce (CREW-1973)', async () => {
  const f = fixture();
  const h = harness(ticket());
  h.w.events = async () => [{
    record_id: 'row-9', event_type: 'taken_over', occurred_at: '2026-01-01T01:00:00Z',
    message: 'Taken over from Mini (not seen recently) by Other; continuing from `abc1234` on origin.',
  }];
  const out = await enforceHandoff({ ...input(f, h), since: '2026-01-01T00:00:00Z' });
  assert.equal(out.kind, 'unverified');
  assert.deepEqual(h.patches, []);
  assert.deepEqual(h.notes, []);
});

test('enforce: a takeover before the run, or by this ship, still bounces an unpushed tip (CREW-1973)', async () => {
  const f = fixture();
  const h = harness(ticket());
  h.w.events = async () => [
    { record_id: 'row-9', event_type: 'taken_over', occurred_at: '2025-12-31T00:00:00Z', message: 'Taken over from X (not seen recently) by Other; no branch.' },
    { record_id: 'row-9', event_type: 'taken_over', occurred_at: '2026-01-01T01:00:00Z', message: 'Taken over from X (not seen recently) by Studio; no branch.' },
  ];
  const out = await enforceHandoff({ ...input(f, h), since: '2026-01-01T00:00:00Z' });
  assert.equal(out.kind, 'bounced');
});

test('enforce: a ship with no local branch never bounces another ship\'s hand-off (CREW-1973)', async () => {
  const f = fixture();
  sh(f.dir, 'worktree', 'remove', '--force', f.wt);
  sh(f.dir, 'branch', '-D', 'crew-9');
  const h = harness(ticket());
  assert.equal((await enforceHandoff(input(f, h))).kind, 'unverified');
  assert.deepEqual(h.patches, []);
  assert.deepEqual(h.notes, []);
  assert.equal(h.warns.length, 1);
});

test('enforce: a ticket not at fixed is not this guard\'s business', async () => {
  const f = fixture();
  const h = harness(ticket({ status: 'needs_info' }));
  assert.equal((await enforceHandoff(input(f, h))).kind, 'not-handed-off');
  assert.deepEqual(h.patches, []);
  assert.deepEqual(h.notes, []);
});

test('enforce: a ticket QA claimed before the guard ran still gets its pushed event (CREW-1729)', async () => {
  const f = fixture();
  sh(f.wt, 'push', '-q', '--set-upstream', 'origin', 'crew-9');
  const h = harness(ticket({ status: 'qa' }));
  const out = await enforceHandoff(input(f, h));
  assert.equal(out.kind, 'pushed');
  assert.deepEqual(h.patches, []);
  assert.deepEqual(h.notes, [pushedEventBody(sh(f.wt, 'rev-parse', 'HEAD'), 'origin', 'crew-9')]);
});

test('enforce: a claimed ticket with an unpushed branch is never bounced out of QA', async () => {
  const f = fixture();
  const h = harness(ticket({ status: 'verified' }));
  assert.equal((await enforceHandoff(input(f, h))).kind, 'failed');
  assert.deepEqual(h.patches, []);
  assert.deepEqual(h.notes, []);
});

test('enforce: a repo with no remote writes nothing', async () => {
  const f = fixture(false);
  const h = harness(ticket());
  assert.equal((await enforceHandoff(input(f, h))).kind, 'unverified');
  assert.deepEqual(h.patches, []);
  assert.deepEqual(h.notes, []);
});

const stray = (f: ReturnType<typeof fixture>, h: ReturnType<typeof harness>, t: Ticket, myShipId: string | null = 'ship-A') => ({
  writer: h.w, contract: DEFAULT_CONTRACT, candidates: [t], seatId: 'seat-dev', role: 'dev', myShipId, shipName: 'Studio',
  checkout: () => ({ dir: f.dir, cfg: cfg(f.dir) }), log: h.log,
});

test('stray: a fixed ticket held by another ship goes back to in_progress, hold and assignee untouched', async () => {
  const f = fixture();
  sh(f.wt, 'push', '-q', '--set-upstream', 'origin', 'crew-9');
  const h = harness(ticket());
  await guardStrayHandoffs(stray(f, h, ticket({ held_by_ship_id: 'ship-B' })));
  assert.deepEqual(h.patches, [{ status: 'in_progress' }]);
  assert.ok(h.notes[0]!.includes(STRAY_HANDOFF_MARKER));
  assert.ok(h.warns.some((w) => /did not claim it/.test(w)));
});

test('stray: an unheld fixed ticket with a pushed local branch gets its pushed event', async () => {
  const f = fixture();
  sh(f.wt, 'push', '-q', '--set-upstream', 'origin', 'crew-9');
  const h = harness(ticket());
  await guardStrayHandoffs(stray(f, h, ticket({ held_by_ship_id: null })));
  assert.deepEqual(h.patches, []);
  assert.deepEqual(h.notes, [pushedEventBody(sh(f.wt, 'rev-parse', 'HEAD'), 'origin', 'crew-9')]);
});

test('stray: an unheld fixed ticket whose branch is unpushed is bounced', async () => {
  const f = fixture();
  const h = harness(ticket());
  await guardStrayHandoffs(stray(f, h, ticket({ held_by_ship_id: null })));
  assert.deepEqual(h.patches, [{ status: 'in_progress', assignee_id: 'seat-dev' }]);
  assert.ok(h.notes[0]!.includes(HANDOFF_BOUNCED_MARKER));
});

test('stray: an unheld fixed ticket whose local branch is stale (origin ahead) is left alone', async () => {
  const f = fixture();
  sh(f.wt, 'push', '-q', '--set-upstream', 'origin', 'crew-9');
  const stale = sh(f.wt, 'rev-parse', 'HEAD');
  // Another ship builds on and pushes a newer tip; this checkout's branch stays at `stale`.
  writeFileSync(join(f.wt, 'c.txt'), 'c');
  sh(f.wt, 'add', '.');
  sh(f.wt, 'commit', '-qm', 'other ship');
  sh(f.wt, 'push', '-q', 'origin', 'crew-9');
  sh(f.wt, 'reset', '-q', '--hard', stale);
  const h = harness(ticket());
  await guardStrayHandoffs(stray(f, h, ticket({ held_by_ship_id: null })));
  assert.deepEqual(h.patches, []);
  assert.deepEqual(h.notes, []);
  assert.ok(h.warns.some((w) => /left alone/.test(w)));
});

test('stray: a local branch strictly ahead of origin is bounced', async () => {
  const f = fixture();
  sh(f.wt, 'push', '-q', '--set-upstream', 'origin', 'crew-9');
  writeFileSync(join(f.wt, 'd.txt'), 'd');
  sh(f.wt, 'add', '.');
  sh(f.wt, 'commit', '-qm', 'unpushed local');
  const h = harness(ticket());
  await guardStrayHandoffs(stray(f, h, ticket({ held_by_ship_id: null })));
  assert.equal(h.patches.length, 1);
});

test('stray: a qa run never inspects other hand-offs', async () => {
  const f = fixture();
  const h = harness(ticket());
  await guardStrayHandoffs({ ...stray(f, h, ticket({ held_by_ship_id: 'ship-B' })), role: 'qa' });
  assert.deepEqual(h.patches, []);
  assert.deepEqual(h.notes, []);
});

test('stray: a ticket held by this ship, or with no branch here, is not bounced', async () => {
  const f = fixture();
  const h = harness(ticket());
  await guardStrayHandoffs(stray(f, h, ticket({ held_by_ship_id: 'ship-A', issue_id: 'ISSUE-77', issue_tag: 'CREW-77' })));
  assert.deepEqual(h.patches, []);
  assert.deepEqual(h.notes, []);
  assert.ok(h.warns.length > 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import { resolveRepoConfig } from '../src/repo-config.ts';
import {
  inspectHandoff, enforceHandoff, pushedEventBody, HANDOFF_BOUNCED_MARKER,
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
  assert.match(h.notes[0]!, new RegExp(HANDOFF_BOUNCED_MARKER));
  assert.match(h.notes[0]!, /Studio/);
  assert.match(h.notes[0]!, /never pushed/);
});

test('enforce: assignee and hold the session left in place are not overwritten', async () => {
  const f = fixture();
  const h = harness(ticket({ assignee_id: 'other', held_by_ship_id: 'ship-B' }));
  await enforceHandoff(input(f, h));
  assert.deepEqual(h.patches, [{ status: 'in_progress' }]);
});

test('enforce: a ticket not at fixed is not this guard\'s business', async () => {
  const f = fixture();
  const h = harness(ticket({ status: 'needs_info' }));
  assert.equal((await enforceHandoff(input(f, h))).kind, 'not-handed-off');
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

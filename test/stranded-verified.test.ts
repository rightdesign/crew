import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import {
  planStrandedVerified, applyStrandedVerified, priorStrandedFlags, STRANDED_MARKER,
  type StrandedWriter, type StrandedLog,
} from '../src/stranded-verified.ts';
import type { Ticket, RunnerEvent } from '../src/tracker.ts';
import type { MergeCandidate } from '../src/release.ts';

const silent: StrandedLog = { emit: () => {}, warn: () => {} };

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'row-1', issue_id: 'ISSUE-345', status: 'verified',
  updated_at: '2026-01-01T00:00:00Z', ...over,
});

const candidate = (over: Partial<MergeCandidate> = {}): MergeCandidate => ({
  ticket: ticket(), branch: null, entries: [], usedFallback: false,
  bump: 'patch', majorRequested: false, skipReason: 'never-built', ...over,
});

function writer() {
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const notes: string[] = [];
  const w: StrandedWriter = {
    updateTicket: async (id, patch) => { patches.push({ id, patch }); return {}; },
    postEvent: async (_id, body) => { notes.push(body); },
  };
  return { w, patches, notes };
}

test('first sighting leaves a note and touches neither status nor assignee', async () => {
  const { w, patches, notes } = writer();
  const s = planStrandedVerified(candidate(), 'main', 'origin', []);
  assert.equal(s.priorFlags, 0);

  const out = await applyStrandedVerified(w, s, DEFAULT_CONTRACT, 'operator-1', 'seat', silent, false);

  assert.equal(out.kind, 'flagged');
  assert.deepEqual(patches, [], 'a first sighting must not wake anyone');
  assert.match(notes[0]!, /flagging before this repeats forever/);
  assert.match(notes[0]!, /ISSUE-345/);
  assert.match(notes[0]!, /searched all of it/);
});

test('still unplaceable after a prior flag escalates to a person', async () => {
  const { w, patches, notes } = writer();
  const already: RunnerEvent[] = [
    { record_id: 'row-1', event_type: 'stranded_flagged', message: `${STRANDED_MARKER}\nflagged earlier`, occurred_at: '2026-01-01T00:00:00Z' },
  ];
  const s = planStrandedVerified(candidate(), 'main', 'origin', already);
  assert.equal(s.priorFlags, 1);

  const out = await applyStrandedVerified(w, s, DEFAULT_CONTRACT, 'operator-1', 'seat', silent, false);

  assert.equal(out.kind, 'escalated');
  assert.equal(patches[0]!.patch.status, DEFAULT_CONTRACT.statuses.needsHuman);
  assert.equal(patches[0]!.patch.assignee_id, 'operator-1');
  assert.match(notes[0]!, /stopping rather than repeating/);
});

test('escalation omits assignee_id when no operator is configured', async () => {
  const { w, patches } = writer();
  const already: RunnerEvent[] = [
    { record_id: 'row-1', event_type: 'stranded_flagged', message: STRANDED_MARKER },
  ];
  const s = planStrandedVerified(candidate(), 'main', 'origin', already);

  await applyStrandedVerified(w, s, DEFAULT_CONTRACT, undefined, 'seat', silent, false);

  assert.equal('assignee_id' in patches[0]!.patch, false);
  assert.equal(patches[0]!.patch.status, DEFAULT_CONTRACT.statuses.needsHuman);
});

test('a dry run reports and writes nothing, either pass', async () => {
  const { w, patches, notes } = writer();
  const first = planStrandedVerified(candidate(), 'main', 'origin', []);
  await applyStrandedVerified(w, first, DEFAULT_CONTRACT, 'operator-1', 'seat', silent, true);
  assert.deepEqual(patches, []);
  assert.deepEqual(notes, []);

  const already: RunnerEvent[] = [{ record_id: 'row-1', event_type: 'stranded_flagged', message: STRANDED_MARKER }];
  const second = planStrandedVerified(candidate(), 'main', 'origin', already);
  await applyStrandedVerified(w, second, DEFAULT_CONTRACT, 'operator-1', 'seat', silent, true);
  assert.deepEqual(patches, []);
  assert.deepEqual(notes, []);
});

test('priorStrandedFlags counts only this ticket, and only stranded-flag events', () => {
  const t = ticket();
  const events: RunnerEvent[] = [
    { record_id: 'row-1', event_type: 'stranded_flagged', message: `${STRANDED_MARKER}\nx` },
    { record_id: 'row-2', event_type: 'stranded_flagged', message: `${STRANDED_MARKER}\ny` },
    { record_id: 'row-1', event_type: 'stranded_escalated', message: 'the escalation, not a flag' },
  ];
  assert.equal(priorStrandedFlags(t, events), 1);
});

test('a second flag inside the gap waits instead of escalating (CREW-1364)', async () => {
  const { w, patches } = writer();
  const t0 = Date.parse('2026-10-05T10:00:00Z');
  const comments: RunnerEvent[] = [{
    record_id: 'row-1', event_type: 'stranded_flagged', message: `${STRANDED_MARKER} flagged`, occurred_at: new Date(t0).toISOString(),
  }];
  const s = planStrandedVerified(candidate(), 'main', 'origin', comments);
  const soon = await applyStrandedVerified(w, s, DEFAULT_CONTRACT, 'operator-1', 'seat', silent, false, t0 + 3 * 60 * 1000);
  assert.equal(soon.kind, 'waiting');
  assert.equal(patches.length, 0);
  const later = await applyStrandedVerified(w, s, DEFAULT_CONTRACT, 'operator-1', 'seat', silent, false, t0 + 31 * 60 * 1000);
  assert.equal(later.kind, 'escalated');
});

// CREW-3384: a stranded note names a remote branch under another name that carries the key.
test('the stranded note lists a differently named remote branch and the expected name (CREW-3384)', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { resolveRepoConfig } = await import('../src/repo-config.ts');
  const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const root = mkdtempSync(join(tmpdir(), 'stranded-'));
  const dir = join(root, 'repo');
  sh(root, 'init', '-q', '-b', 'main', dir);
  sh(dir, 'config', 'user.email', 't@example.com');
  sh(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'a');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-qm', 'base');
  sh(root, 'init', '-q', '--bare', join(root, 'o.git'));
  sh(dir, 'remote', 'add', 'origin', join(root, 'o.git'));
  sh(dir, 'push', '-q', 'origin', 'main');
  sh(dir, 'checkout', '-q', '-b', 'repo-issue-345');
  writeFileSync(join(dir, 'b.txt'), 'b');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-qm', 'ISSUE-345 the work');
  sh(dir, 'push', '-q', 'origin', 'repo-issue-345');
  sh(dir, 'checkout', '-q', '-b', 'unrelated-345', 'main');
  writeFileSync(join(dir, 'c.txt'), 'c');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-qm', 'no key here');
  sh(dir, 'push', '-q', 'origin', 'unrelated-345');
  sh(dir, 'checkout', '-q', 'main');
  sh(dir, 'fetch', '-q', 'origin');

  const cfg = resolveRepoConfig(null, undefined, dir);
  const s = planStrandedVerified(candidate(), 'main', 'origin', [], { dir, cfg });
  assert.deepEqual(s.nearMisses, [{ branch: 'repo-issue-345', commits: 1 }]);
  const { flagComment, escalateComment } = await import('../src/stranded-verified.ts');
  for (const note of [flagComment(s), escalateComment(s)]) {
    assert.match(note, /`origin\/repo-issue-345`/);
    assert.match(note, /expected `issue-345`/);
  }
  assert.doesNotMatch(flagComment(planStrandedVerified(candidate(), 'main', 'origin', [])), /another name/);
});

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

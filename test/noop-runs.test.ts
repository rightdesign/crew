import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NOOP_DELAYS_MS, clearNoopRuns, noopBackedOff, noopRunsKey, readNoopRuns, recordNoopRun, settleNoopRun, type NoopTracker, type SettleNoopOptions,
} from '../src/noop-runs.ts';
import type { ShipAttentionItem } from '../src/ship-attention.ts';
import type { Comment, Ticket } from '../src/tracker.ts';

const dir = (): string => mkdtempSync(join(tmpdir(), 'noop-'));
const MIN = 60_000;

test('a no-op run is not restarted within five minutes, and the delays grow', () => {
  const d = dir();
  const t0 = 1_000_000;
  const first = recordNoopRun(d, 'rec', 3, t0);
  assert.equal(first.count, 1);
  assert.equal(first.nextAt, t0 + 5 * MIN);
  assert.equal(noopBackedOff(d, 'rec', t0 + 4 * MIN), true);
  assert.equal(noopBackedOff(d, 'rec', t0 + 5 * MIN), false);
  assert.equal(recordNoopRun(d, 'rec', 4, t0).nextAt, t0 + 15 * MIN);
  assert.equal(recordNoopRun(d, 'rec', 5, t0).nextAt, t0 + 60 * MIN);
  assert.equal(recordNoopRun(d, 'rec', 6, t0).nextAt, t0 + NOOP_DELAYS_MS.at(-1)!, 'the last delay repeats');
  assert.equal(noopBackedOff(d, 'other', t0), false);
});

test('the configured repeat count is when the ticket is bounced', () => {
  const d = dir();
  assert.equal(recordNoopRun(d, 'rec', 3).bounce, false);
  assert.equal(recordNoopRun(d, 'rec', 3).bounce, false);
  assert.equal(recordNoopRun(d, 'rec', 3).bounce, true);
  clearNoopRuns(d, 'rec');
  assert.deepEqual(readNoopRuns(d), {});
});

function setup(afterPatch: Partial<Ticket> = {}, tipAfter = 'o|', repeats = 2) {
  const stateDir = dir();
  const before = { id: 'rec', issue_id: 'CREW-9', issue_tag: 'CREW-9', status: 'in_progress', assignee_id: 'dev', updated_at: 'u0' } as unknown as Ticket;
  const writes: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  const raised: ShipAttentionItem[] = [];
  const cleared: string[] = [];
  const tracker: NoopTracker = {
    ticket: async () => ({ ...before, ...afterPatch }) as Ticket,
    comments: async () => [
      { id: 'c1', ticket_id: 'rec', team_member_id: 'dev', body: 'older', created_at: '2026-11-03T05:00:00Z' },
      { id: 'c2', ticket_id: 'rec', team_member_id: 'dev', body: 'no node on PATH, stopping', created_at: '2026-11-03T05:30:00Z' },
      { id: 'c3', ticket_id: 'other', team_member_id: 'dev', body: 'wrong ticket', created_at: '2026-11-03T05:31:00Z' },
    ] as Comment[],
    updateTicket: async (_id, patch) => { writes.push(patch); },
    postEvent: async (_id, body) => { events.push(body); },
    claimAffinity: async () => ({ column: 'held_by_ship_id', shipId: 's1' }),
  };
  const opts: SettleNoopOptions = {
    tracker, stateDir, role: 'dev', ticketId: 'rec', before, tipBefore: 'o|', tipAfter, runStart: '2026-11-03T05:29:00Z',
    memberId: 'dev', operatorId: 'op', columns: { status: 'status', assignee: 'assignee_id' },
    statuses: { building: 'in_progress', needsHuman: 'needs_info' }, repeats,
    raise: (i) => { raised.push(i); }, clear: (k) => { cleared.push(k); },
  };
  return { opts, writes, events, raised, cleared, stateDir };
}

test('a run that changed nothing raises an attention item carrying the agent\'s last comment', async () => {
  const s = setup();
  assert.equal(await settleNoopRun(s.opts), 'backoff');
  assert.equal(s.raised.length, 1);
  assert.equal(s.raised[0]!.key, noopRunsKey('CREW-9'));
  assert.match(s.raised[0]!.message, /CREW-9.*1 time.*no node on PATH, stopping/);
  assert.equal(noopBackedOff(s.stateDir, 'rec'), true);
  assert.deepEqual(s.writes, []);
});

test('after the configured repeats the ticket is bounced to the operator with the comment, and the hold released', async () => {
  const s = setup();
  assert.equal(await settleNoopRun(s.opts), 'backoff');
  assert.equal(await settleNoopRun(s.opts), 'bounced');
  assert.deepEqual(s.writes, [{ status: 'needs_info', assignee_id: 'op', held_by_ship_id: null }]);
  assert.match(s.events[0]!, /no node on PATH, stopping/);
  assert.deepEqual(readNoopRuns(s.stateDir), {});
  assert.ok(s.cleared.includes(noopRunsKey('CREW-9')));
});

test('a push, a hand-off or a reassignment clears the record', async () => {
  for (const [patch, tip] of [[{}, 'o2|'], [{ status: 'fixed' }, 'o|'], [{ assignee_id: null }, 'o|']] as Array<[Partial<Ticket>, string]>) {
    const s = setup(patch, tip);
    recordNoopRun(s.stateDir, 'rec', 9);
    assert.equal(await settleNoopRun(s.opts), 'progress');
    assert.deepEqual(readNoopRuns(s.stateDir), {});
    assert.deepEqual(s.raised, []);
  }
});

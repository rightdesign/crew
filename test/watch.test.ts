import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { foldCycle, foldCycles, renderHeader, renderHeaders, formatLine, matches, readFrom, localTime } from '../src/watch.ts';
import type { CrewEvent } from '../src/events.ts';

const E = (o: Partial<CrewEvent> & { step: CrewEvent['step']; message: string }): CrewEvent => ({
  at: '2026-08-24T01:15:45.000Z', cycle: 'C1', route: 'synthesis', level: 'info', ...o,
});

test('a ticket merely REPORTED on is not shown as the one being worked', () => {
  // Regression: the header claimed "ticket ISSUE-149" because a sweep notice
  // about a stranded ticket was the last event carrying one.
  const s = foldCycle([
    E({ step: 'poll', message: '56 open' }),
    E({ step: 'sweep', ticket: 'ISSUE-149', message: 'needs_info with all blockers resolved' }),
    E({ step: 'select', role: 'dev', message: "'dev' wins", data: { rank: 2020000299 } }),
  ])!;
  assert.equal(s.ticket, undefined);
  assert.equal(s.role, 'dev');
  assert.doesNotMatch(renderHeader(s), /ISSUE-149/);
});

test('a ticket actually being worked IS shown', () => {
  const s = foldCycle([
    E({ step: 'sweep', ticket: 'ISSUE-149', message: 'reported only' }),
    E({ step: 'agent', role: 'dev', ticket: 'ISSUE-299', message: 'picked up' }),
  ])!;
  assert.equal(s.ticket, 'ISSUE-299');
  assert.match(renderHeader(s), /ISSUE-299/);
  assert.doesNotMatch(renderHeader(s), /ISSUE-149/);
});

test('the header folds rank, pending roles and elapsed time', () => {
  const s = foldCycle([
    E({ step: 'select', role: 'dev', message: 'x', data: { rank: 42, pending: ['dev', 'design'] } }),
  ])!;
  const h = renderHeader(s, Date.parse('2026-08-24T01:15:52.000Z'));
  assert.match(h, /rank 42/);
  assert.match(h, /pending: dev design/);
  assert.match(h, /7s in select/);
});

test('only the latest cycle is folded', () => {
  const s = foldCycle([
    E({ cycle: 'OLD', step: 'agent', role: 'qa', ticket: 'ISSUE-1', message: 'old' }),
    E({ cycle: 'NEW', step: 'poll', message: 'new' }),
  ])!;
  assert.equal(s.cycle, 'NEW');
  assert.equal(s.ticket, undefined);   // not the previous cycle's
  assert.equal(s.role, undefined);
});

test('errors and warnings are counted and surfaced', () => {
  const s = foldCycle([
    E({ step: 'release', level: 'warn', message: 'w' }),
    E({ step: 'release', level: 'error', message: 'e' }),
  ])!;
  assert.equal(s.warnings, 1);
  assert.equal(s.errors, 1);
  assert.match(renderHeader(s), /1 error\(s\)/);
});

test('filters select by role, ticket and level', () => {
  const e = E({ step: 'agent', role: 'dev', ticket: 'ISSUE-1', message: 'x' });
  assert.ok(matches(e, {}));
  assert.ok(matches(e, { role: 'dev' }));
  assert.ok(!matches(e, { role: 'qa' }));
  assert.ok(!matches(e, { ticket: 'ISSUE-2' }));
  assert.ok(!matches(e, { level: 'warn' }));
  assert.ok(matches(E({ step: 'poll', level: 'error', message: 'x' }), { level: 'warn' }));
});

test('a partial final line is not parsed until it is complete', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-watch-'));
  const f = join(dir, 'events.jsonl');
  writeFileSync(f, `${JSON.stringify(E({ step: 'poll', message: 'one' }))}\n`);
  const first = readFrom(f, 0);
  assert.equal(first.events.length, 1);

  appendFileSync(f, '{"partial":');           // a torn write, mid-append
  const second = readFrom(f, first.offset);
  assert.equal(second.events.length, 0);
  assert.equal(second.offset, first.offset);  // and the offset does not advance

  appendFileSync(f, `"x","step":"poll","cycle":"C1","route":"c","level":"info","at":"t","message":"two"}\n`);
  const third = readFrom(f, second.offset);
  assert.equal(third.events.length, 1);
});

test('blocked and QA-held tickets fold into the header without a separate `crew status` lookup', () => {
  const s = foldCycle([
    E({ step: 'sweep', message: '2 ticket(s) parked as blocked', data: { blocked: ['ISSUE-1', 'ISSUE-2'] } }),
    E({ step: 'sweep', message: '1 ticket(s) held in QA', data: { qaHeld: ['ISSUE-9'] } }),
  ])!;
  assert.deepEqual(s.blockedTickets, ['ISSUE-1', 'ISSUE-2']);
  assert.deepEqual(s.qaHeldTickets, ['ISSUE-9']);
  const h = renderHeader(s);
  assert.match(h, /blocked: ISSUE-1 ISSUE-2/);
  assert.match(h, /qa holding: ISSUE-9/);
});

test('a release in progress is not shown as blocked', () => {
  const s = foldCycle([E({ step: 'release', message: 'merging' })])!;
  assert.equal(s.releaseBlockedCycles, undefined);
  assert.doesNotMatch(renderHeader(s), /BLOCKED/);
});

test('a blocked release names the cycle count and the reason, from its very first cycle', () => {
  const s = foldCycle([
    E({ step: 'release', level: 'warn', message: 'refusing to release', data: { cycles: 1, reason: 'dirty tree' } }),
  ])!;
  assert.equal(s.releaseBlockedCycles, 1);
  assert.equal(s.releaseBlockedReason, 'dirty tree');
  const h = renderHeader(s);
  assert.match(h, /release BLOCKED \(1 cycle\): dirty tree/);
});

test('a truncated file is re-read from the start rather than read as garbage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-watch-'));
  const f = join(dir, 'events.jsonl');
  writeFileSync(f, `${JSON.stringify(E({ step: 'poll', message: 'a' }))}\n`);
  const before = readFrom(f, 0);
  writeFileSync(f, `${JSON.stringify(E({ step: 'poll', message: 'fresh' }))}\n`);   // rotated
  const after = readFrom(f, before.offset + 5000);
  assert.equal(after.events[0]?.message, 'fresh');
});

test('a line is rendered with time, scope and ticket', () => {
  const e = E({ step: 'agent', role: 'dev', ticket: 'ISSUE-9', message: 'picked up' });
  const line = formatLine(e);
  // The time is the LOCAL rendering, so assert against that rather than a
  // fixed string — the previous version only passed in UTC.
  assert.match(line, new RegExp(localTime(e.at)));
  assert.match(line, /agent\[dev\]/);
  assert.match(line, /ISSUE-9/);
});

test('the view shows local time, though events are stamped in UTC', () => {
  // Asserted against the platform's own conversion rather than a fixed
  // string, so the test is correct in any timezone.
  const iso = '2026-08-24T01:15:45.000Z';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const expected = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  assert.equal(localTime(iso), expected);
  assert.match(formatLine(E({ step: 'poll', message: 'x' })), new RegExp(expected));
});

test('an unparseable timestamp is shown rather than swallowed', () => {
  assert.equal(localTime('not-a-date'), 'not-a-date'.slice(11, 19));
});

test('formatLine omits the route by default, and shows it when asked', () => {
  const e = E({ route: 'paradium/issues', step: 'poll', message: 'x' });
  assert.doesNotMatch(formatLine(e), /paradium\/issues/);
  assert.match(formatLine(e, true), /paradium\/issues/);
});

test('foldCycles gives each route its own cycle, so two routes running at once are both visible', () => {
  const states = foldCycles([
    E({ route: 'issues/issues', cycle: 'C1', step: 'agent', role: 'dev', ticket: 'ISSUE-1', message: 'a' }),
    E({ route: 'paradium/issues', cycle: 'C2', step: 'release', message: 'b' }),
  ]);
  assert.equal(states.length, 2);
  assert.deepEqual(states.map((s) => s.route).sort(), ['issues/issues', 'paradium/issues']);
  const synthesis = states.find((s) => s.route === 'issues/issues')!;
  assert.equal(synthesis.ticket, 'ISSUE-1');
});

test('foldCycles still only folds the LATEST cycle within each route', () => {
  const states = foldCycles([
    E({ route: 'issues/issues', cycle: 'OLD', step: 'agent', role: 'qa', ticket: 'ISSUE-1', message: 'old' }),
    E({ route: 'issues/issues', cycle: 'NEW', step: 'poll', message: 'new' }),
  ]);
  assert.equal(states.length, 1);
  assert.equal(states[0]!.cycle, 'NEW');
  assert.equal(states[0]!.ticket, undefined);
});

test('renderHeaders renders one block per route, and the "waiting" line when there is nothing yet', () => {
  assert.match(renderHeaders([]), /waiting for the crew to run/);
  const states = foldCycles([
    E({ route: 'issues/issues', cycle: 'C1', step: 'agent', role: 'dev', ticket: 'ISSUE-1', message: 'a' }),
    E({ route: 'paradium/issues', cycle: 'C2', step: 'release', message: 'b' }),
  ]);
  const h = renderHeaders(states);
  assert.match(h, /issues\/issues/);
  assert.match(h, /paradium\/issues/);
  assert.match(h, /ISSUE-1/);
});

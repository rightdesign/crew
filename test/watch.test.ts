import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { foldCycle, renderHeader, formatLine, matches, readFrom } from '../src/watch.ts';
import type { CrewEvent } from '../src/events.ts';

const E = (o: Partial<CrewEvent> & { step: CrewEvent['step']; message: string }): CrewEvent => ({
  at: '2026-08-24T01:15:45.000Z', cycle: 'C1', connection: 'synthesis', level: 'info', ...o,
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

  appendFileSync(f, `"x","step":"poll","cycle":"C1","connection":"c","level":"info","at":"t","message":"two"}\n`);
  const third = readFrom(f, second.offset);
  assert.equal(third.events.length, 1);
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
  const line = formatLine(E({ step: 'agent', role: 'dev', ticket: 'ISSUE-9', message: 'picked up' }));
  assert.match(line, /01:15:45/);
  assert.match(line, /agent\[dev\]/);
  assert.match(line, /ISSUE-9/);
});

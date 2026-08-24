import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Emitter, render, eventFileFor } from '../src/events.ts';

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-ev-'));
  const lines: string[] = [];
  let t = Date.parse('2026-08-23T12:00:00.000Z');
  const e = new Emitter({
    connection: 'synthesis',
    eventFile: eventFileFor(dir),
    logFile: join(dir, 'crew.log'),
    console: (l) => lines.push(l),
    now: () => new Date((t += 1000)),
    cycleId: 'C1',
  });
  return { dir, lines, e };
}

test('an event carries structure, and the log line is rendered from it', () => {
  const { e, lines } = rig();
  e.enter('select', 'dev');
  const ev = e.emit("'dev' wins this cycle", { data: { rank: 2020000299 } });
  assert.equal(ev.cycle, 'C1');
  assert.equal(ev.connection, 'synthesis');
  assert.equal(ev.step, 'select');
  assert.equal(ev.role, 'dev');
  assert.deepEqual(ev.data, { rank: 2020000299 });
  assert.equal(lines[0], render(ev));
  assert.match(lines[0]!, /select\[dev\]:.*wins this cycle/);
});

test('events round-trip as JSONL — what a view tails', () => {
  const { dir, e } = rig();
  e.enter('sweep');
  e.emit('parked ISSUE-293', { ticket: 'ISSUE-293' });
  e.emit('swept 1 ticket(s)');
  const lines = readFileSync(eventFileFor(dir), 'utf8').trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].ticket, 'ISSUE-293');
  assert.equal(lines[1].ticket, undefined);
});

test('the current step and role stick until changed', () => {
  const { e } = rig();
  e.enter('agent', 'qa');
  assert.equal(e.emit('a').role, 'qa');
  assert.equal(e.emit('b').step, 'agent');
  e.enter('release');
  const r = e.emit('c');
  assert.equal(r.step, 'release');
  assert.equal(r.role, undefined);   // a step with no role clears it
});

test('levels are carried and shown', () => {
  const { e, lines } = rig();
  e.warn('target not responding');
  e.error('deploy failed');
  assert.match(lines[0]!, /WARN: target not responding/);
  assert.match(lines[1]!, /ERROR: deploy failed/);
});

test('timed steps record duration and outcome', async () => {
  const { e, lines } = rig();
  const v = await e.timed('merge', 'merged 2 branch(es)', async () => 42);
  assert.equal(v, 42);
  assert.match(lines[0]!, /merge: merged 2 branch\(es\)/);
});

test('a failing step is emitted as an error and still throws', async () => {
  const { e, lines } = rig();
  await assert.rejects(() => e.timed('release', 'deploy', async () => { throw new Error('boom'); }));
  assert.match(lines[0]!, /ERROR: deploy — boom/);
});

test('an unwritable sink never takes the cycle down with it', () => {
  const lines: string[] = [];
  const e = new Emitter({
    connection: 'x',
    eventFile: '/proc/nonexistent/definitely/not/writable/events.jsonl',
    console: (l) => lines.push(l),
    cycleId: 'C1',
  });
  assert.doesNotThrow(() => e.emit('still running'));
  assert.equal(lines.length, 1);   // observability degraded, the run continues
});


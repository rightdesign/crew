import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter } from '../src/events.ts';
import { emitReleaseSummary, summarizeOutcome, type ReleaseOutcome } from '../src/release-run.ts';

// CREW-3285: a poll / run / release at a terminal shows the decision and the
// exceptions; the bookkeeping shows under --verbose. The event stream is the same.

/** The events one poll emits, in the shapes poll.ts uses (note() = bookkeeping). */
function pollCycle(e: Emitter, o: { needsPerson?: boolean; newUnroutable?: boolean } = {}): void {
  e.note('12 open ticket(s), 40 comment(s)');
  e.note('3 ticket(s) parked as blocked');
  e.note('1 ticket(s) held in QA');
  if (o.newUnroutable) e.emit('2 open ticket(s) have no repository and are not routable (1 new since last cycle)');
  else e.note('2 open ticket(s) have no repository and are not routable (0 new since last cycle)');
  if (o.needsPerson) e.emit('needs a person: needs_info — Pick a color', { ticket: 'ISSUE-9' });
  e.note('queue digest written for dev (900 bytes)');
  e.emit("roles with work: dev -> 'dev' wins this cycle; the rest stay pending for the next");
}

function run(opts: { verbose?: boolean; plain?: boolean }, cycle: (e: Emitter) => void, eventFile?: string) {
  const shown: string[] = [];
  const e = new Emitter({ route: 'r', console: (l) => shown.push(l), eventFile, cycleId: 'C', now: () => new Date('2026-11-12T00:00:00Z'), ...opts });
  cycle(e);
  return shown;
}

test('poll with work available prints one decision line in a terminal', () => {
  assert.deepEqual(run({ plain: true }, (e) => pollCycle(e)), [
    "roles with work: dev -> 'dev' wins this cycle; the rest stay pending for the next",
  ]);
});

test('poll with a ticket waiting on the operator prints it as a second line', () => {
  assert.deepEqual(run({ plain: true }, (e) => pollCycle(e, { needsPerson: true })), [
    'ISSUE-9: needs a person: needs_info — Pick a color',
    "roles with work: dev -> 'dev' wins this cycle; the rest stay pending for the next",
  ]);
});

test('a newly unroutable ticket is shown; an old one is bookkeeping', () => {
  const lines = run({ plain: true }, (e) => pollCycle(e, { newUnroutable: true }));
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /not routable \(1 new/);
});

test('poll --verbose prints every line, timestamped unless plain', () => {
  const plain = run({ plain: true, verbose: true }, (e) => pollCycle(e, { needsPerson: true }));
  assert.equal(plain.length, 7);
  const full = run({ plain: false, verbose: true }, (e) => pollCycle(e, { needsPerson: true }));
  assert.equal(full.length, 7);
  assert.match(full[0]!, /^2026-11-12T00:00:00\.000Z poll: 12 open ticket/);
});

test('a console that is not a terminal keeps the full log form without --verbose', () => {
  assert.equal(run({ plain: false }, (e) => pollCycle(e, { needsPerson: true })).length, 7);
});

test('the event stream holds the same events however the console is rendered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'term3285-'));
  const read = (f: string) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { message: string; level: string; step: string });
  const files = [{ plain: true }, { plain: true, verbose: true }, { plain: false }].map((o, i) => {
    const f = join(dir, `e${i}.jsonl`);
    run(o, (e) => pollCycle(e, { needsPerson: true }), f);
    return read(f).map((ev) => [ev.step, ev.level, ev.message]);
  });
  assert.equal(files[0]!.length, 7);
  assert.deepEqual(files[1], files[0]);
  assert.deepEqual(files[2], files[0]);
});

const outcome = (over: Partial<ReleaseOutcome>): ReleaseOutcome =>
  ({ merged: [], conflicts: [], unbuildable: [], deployed: false, ...over }) as ReleaseOutcome;

test('release across repos: one line for the release, one closing count', () => {
  const rows = [
    { ...summarizeOutcome(outcome({ deployed: true, version: '1.2.0', merged: [{}] as never }), 'r/app', true), route: 'r' },
    { ...summarizeOutcome(outcome({ stopped: 'nothing to release' }), 'r/docs', false), route: 'r' },
    { ...summarizeOutcome(outcome({ stopped: 'nothing to release' }), 'r/site', false), route: 'r' },
  ];
  const shown: string[] = [];
  emitReleaseSummary(new Emitter({ route: 'r', plain: true, console: (l) => shown.push(l) }), rows);
  assert.equal(shown.length, 2);
  assert.match(shown[0]!, /r\/app: tests passed, deployed — deployed 1\.2\.0/);
  assert.equal(shown[1], '2 of 3 repo(s) had nothing to release');

  const verbose: string[] = [];
  emitReleaseSummary(new Emitter({ route: 'r', plain: true, verbose: true, console: (l) => verbose.push(l) }), rows);
  assert.equal(verbose.length, 5, 'header + three rows + closing count');
});

test('a failed release row is shown, not folded into the count', () => {
  const rows = [
    { ...summarizeOutcome(outcome({ stopped: 'tests failed' }), 'r/app', true), route: 'r' },
    { ...summarizeOutcome(outcome({ stopped: 'nothing to release' }), 'r/docs', false), route: 'r' },
  ];
  const shown: string[] = [];
  emitReleaseSummary(new Emitter({ route: 'r', plain: true, console: (l) => shown.push(l) }), rows);
  assert.match(shown[0]!, /warning: +r\/app: tests FAILED/);
  assert.equal(shown.at(-1), '1 of 2 repo(s) had nothing to release');
});

test('replay shows a failed hook\'s output at a terminal, and only there, once', () => {
  const lines = ['boom', 'at x'];
  const at = (o: { plain?: boolean; verbose?: boolean }) => {
    const shown: string[] = [];
    new Emitter({ route: 'r', console: (l) => shown.push(l), ...o }).replay(lines);
    return shown;
  };
  assert.deepEqual(at({ plain: true }), lines);
  assert.deepEqual(at({ plain: true, verbose: true }), [], 'verbose already showed them');
  assert.deepEqual(at({ plain: false }), [], 'a log console has the events');
});

// CREW-3285 (QA bounce): `crew run` shows the decision, then one outcome line.
import { describeRunOutcome } from '../src/cli-output.ts';

const base = { role: 'dev', route: 'r', ticket: 'ISSUE-9', run: { code: 0 } };

test('run outcome: handed off, parked, bounced, failed with a next command', () => {
  assert.equal(describeRunOutcome({ ...base, handoff: { kind: 'pushed' } }), 'dev on ISSUE-9: handed off');
  assert.equal(describeRunOutcome({ ...base, handoff: { kind: 'unverified', why: 'ticket closed while it ran' } }), 'dev on ISSUE-9: parked, ticket closed while it ran');
  assert.match(describeRunOutcome({ ...base, handoff: { kind: 'bounced' } }), /bounced/);
  assert.match(describeRunOutcome({ ...base, handoff: { kind: 'failed', why: 'push rejected' } }), /push rejected — try: `crew status r`/);
  assert.match(describeRunOutcome({ ...base, run: { code: 2 }, handoff: null }), /run failed \(exit 2\) — try: /);
  assert.match(describeRunOutcome({ ...base, run: { code: 0, killed: { limitMinutes: 90 } }, handoff: null }), /90 min limit — try: /);
  assert.match(describeRunOutcome({ ...base, run: { code: 0, handoffPending: true }, handoff: null }), /pending/);
});

test('a run at a terminal prints the start decision and one outcome line; the stream is unchanged', () => {
  const cycle = (e: Emitter) => {
    e.emit("roles with work: dev -> 'dev' wins this cycle");
    e.note('starting agent run');
    e.note('agent run finished (exit 0)');
    e.echo(describeRunOutcome({ ...base, handoff: { kind: 'pushed' } }));
  };
  assert.deepEqual(run({ plain: true }, cycle), ["roles with work: dev -> 'dev' wins this cycle", 'dev on ISSUE-9: handed off']);
  assert.equal(run({ plain: true, verbose: true }, cycle).length, 4);
  assert.equal(run({ plain: false }, cycle).length, 3);
});

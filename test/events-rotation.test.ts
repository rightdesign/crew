import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Emitter, rotateEventsFile } from '../src/events.ts';
import { planEventsSweep } from '../src/stream-sweep.ts';

const DAY = 24 * 60 * 60 * 1000;
const rig = () => mkdtempSync(join(tmpdir(), 'crew-rotate-'));
const lines = (f: string) => readFileSync(f, 'utf8').split('\n').filter(Boolean);

test('appending past the threshold rotates by rename and loses no event (CREW-1509)', () => {
  const dir = rig();
  const file = join(dir, 'events.jsonl');
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 10, 12, 0, tick++));
  const e = new Emitter({ route: 'r', eventFile: file, rotateBytes: 2000, console: () => {}, now });
  const N = 60;
  for (let i = 0; i < N; i++) e.emit(`event ${i}`);
  const rotated = readdirSync(dir).filter((n) => /^events\..+\.jsonl$/.test(n));
  assert.ok(rotated.length >= 1, 'at least one rotated file');
  const all = [...rotated.sort().flatMap((n) => lines(join(dir, n))), ...lines(file)];
  assert.deepEqual(all.map((l) => JSON.parse(l).message), Array.from({ length: N }, (_, i) => `event ${i}`));
  assert.ok(!existsSync(`${file}.rotate.lock`), 'lock released');
});

test('a file under the threshold is left alone; a held lock blocks rotation', () => {
  const dir = rig();
  const file = join(dir, 'events.jsonl');
  writeFileSync(file, 'x'.repeat(100));
  assert.equal(rotateEventsFile(file, 1000), undefined);
  writeFileSync(`${file}.rotate.lock`, '');
  assert.equal(rotateEventsFile(file, 10), undefined);
});

test('rotated files older than the retention window are swept; newer and the live file stay', () => {
  const dir = rig();
  const old = join(dir, 'events.20260901T000000Z.jsonl');
  const fresh = join(dir, 'events.20261009T000000Z.jsonl');
  const live = join(dir, 'events.jsonl');
  for (const f of [old, fresh, live]) writeFileSync(f, '{}\n');
  const t = (Date.now() - 30 * DAY) / 1000;
  utimesSync(old, t, t);
  utimesSync(live, t, t);
  assert.deepEqual(planEventsSweep(dir, 7), [old]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastStreamEvent, lastRunsBySeat, outcomeOf } from '../src/run-snapshot.ts';

const dir = (): string => mkdtempSync(join(tmpdir(), 'crew-snap-'));
const text = (t: string): string => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const tool = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } });

test('lastStreamEvent returns the latest text turn, collapsed and cut', () => {
  const d = dir();
  const f = join(d, 'a.jsonl');
  writeFileSync(f, [text('first'), text('second\n  line'), tool, '{"type":"user"}', 'not json'].join('\n') + '\n');
  assert.equal(lastStreamEvent(f)?.text, 'second line');
  writeFileSync(f, text('x'.repeat(500)) + '\n');
  const e = lastStreamEvent(f)!;
  assert.equal(e.text.length, 280);
  assert.ok(e.text.endsWith('…'));
  assert.match(e.at, /^\d{4}-\d\d-\d\dT/);
});

test('lastStreamEvent is null for no text turn or a missing file', () => {
  const d = dir();
  writeFileSync(join(d, 'b.jsonl'), tool + '\n');
  assert.equal(lastStreamEvent(join(d, 'b.jsonl')), null);
  assert.equal(lastStreamEvent(join(d, 'none.jsonl')), null);
});

test('outcomeOf separates ok, failed and interrupted', () => {
  assert.deepEqual([{ exitCode: 0 }, { exitCode: null }, { exitCode: 1 }, { exitCode: 0, interrupted: 'daemon-exit' }].map(outcomeOf), ['ok', 'ok', 'failed', 'interrupted']);
});

test('lastRunsBySeat keeps the newest finished run per route and role, ignoring running ones', () => {
  const d = dir();
  mkdirSync(join(d, 'streams'));
  const put = (name: string, meta: object, mtime: number): void => {
    const s = join(d, 'streams', `${name}.jsonl`);
    writeFileSync(s, '');
    writeFileSync(`${s}.meta.json`, JSON.stringify(meta));
    utimesSync(`${s}.meta.json`, mtime, mtime);
  };
  put('old', { route: 'r', role: 'dev', ticket: 'CREW-1', exitCode: 0 }, 1_000);
  put('new', { route: 'r', role: 'dev', ticket: 'CREW-2', exitCode: 1 }, 2_000);
  put('live', { route: 'r', role: 'dev', ticket: 'CREW-3', running: true }, 3_000);
  put('qa', { route: 'r', role: 'qa', ticket: 'CREW-4', exitCode: 0 }, 1_500);
  const m = lastRunsBySeat(d);
  assert.equal(m.get('r/dev')?.ticket, 'CREW-2');
  assert.equal(m.get('r/dev')?.outcome, 'failed');
  assert.equal(m.get('r/qa')?.ticket, 'CREW-4');
  assert.equal(m.size, 2);
});

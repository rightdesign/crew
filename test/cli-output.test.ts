import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeOutcomes, withFix } from '../src/cli-output.ts';

const rows = [{ n: 'a', ok: true }, { n: 'b', ok: false }, { n: 'c', ok: true }];
const describe = (r: { n: string }) => `${r.n}: line`;

test('summarizeOutcomes collapses routine outcomes into one count', () => {
  assert.deepEqual(summarizeOutcomes(rows, describe, (r) => r.ok, 'skill', false), ['b: line', '2 skills already in sync']);
  assert.deepEqual(summarizeOutcomes(rows.slice(0, 1), describe, (r) => r.ok, 'skill', false), ['1 skill already in sync']);
});

test('summarizeOutcomes lists every outcome under verbose', () => {
  assert.deepEqual(summarizeOutcomes(rows, describe, (r) => r.ok, 'skill', true), ['a: line', 'b: line', 'c: line']);
});

test('withFix appends the next command', () => {
  assert.equal(withFix('crew agents sync: boom.', '`crew doctor`'), 'crew agents sync: boom — try: `crew doctor`');
});

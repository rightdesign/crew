import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeServable, explainRefusal } from '../src/mirror-contract.ts';

const linux = (p: string) => p === 'linux' || p === 'any';
const base = { satisfied: linux, unmirrored: new Set<string>(), tolerateUnmirrored: true };

test('a route whose only readable repositories require darwin is refused, each repository named', () => {
  assert.equal(judgeServable({ ...base, platforms: ['darwin', 'darwin'], unreadable: [] }), false);
  assert.equal(
    explainRefusal([{ name: 'a', platform: 'darwin' }, { name: 'b', platform: 'darwin' }], []),
    'a requires darwin, b requires darwin',
  );
});

test('a fresh ship with every mirror absent is servable when the daemon tolerates unmirrored repositories', () => {
  const o = { ...base, platforms: [], unreadable: ['a', 'b'], unmirrored: new Set(['a', 'b']) };
  assert.equal(judgeServable(o), true);
  assert.equal(judgeServable({ ...o, tolerateUnmirrored: false }), false);
});

test('an unreadable repository that has a mirror (a bad contract) is not forgiven', () => {
  assert.equal(judgeServable({ ...base, platforms: [], unreadable: ['a'], unmirrored: new Set() }), false);
});

test('the refusal never dangles when nothing could be resolved', () => {
  const got = explainRefusal([], [{ repo: 'a', detail: 'cannot change to /cache/x\nmore' }]);
  assert.equal(got, "no repository contract could be read, a's contract could not be read (cannot change to /cache/x)");
});

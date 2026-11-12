import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfLaunchVerdict, runSelfLaunchCheck, type ChildResult } from '../src/self-launch-check.ts';

const own = { version: '1.2.3', compiled: true };
const child = (over: Partial<ChildResult>): ChildResult => ({ code: 0, stdout: JSON.stringify({ version: '1.2.3', compiled: true }), stderr: '', timedOut: false, ...over });

test('a child with the same version and compiled flag passes (CREW-3279)', () => {
  assert.equal(selfLaunchVerdict(child({}), own).ok, true);
});

test('a version mismatch fails and names both versions', () => {
  const v = selfLaunchVerdict(child({ stdout: JSON.stringify({ version: '9.9.9', compiled: true }) }), own);
  assert.equal(v.ok, false);
  assert.match(v.message, /9\.9\.9.*1\.2\.3/);
});

test('a compiled mismatch fails', () => {
  assert.equal(selfLaunchVerdict(child({ stdout: JSON.stringify({ version: '1.2.3', compiled: false }) }), own).ok, false);
});

test('non-JSON output fails and echoes what the child printed', () => {
  const v = selfLaunchVerdict(child({ stdout: 'usage: crew ...' }), own);
  assert.equal(v.ok, false);
  assert.match(v.message, /usage: crew/);
});

test('a JSON value that is not an object fails', () => {
  assert.equal(selfLaunchVerdict(child({ stdout: '[1]' }), own).ok, false);
  assert.equal(selfLaunchVerdict(child({ stdout: 'null' }), own).ok, false);
});

test('a non-zero exit fails even with matching output', () => {
  const v = selfLaunchVerdict(child({ code: 3, stderr: 'boom' }), own);
  assert.equal(v.ok, false);
  assert.match(v.message, /exited 3[\s\S]*boom/);
});

test('a timeout fails', () => {
  const v = selfLaunchVerdict(child({ code: null, timedOut: true }), own);
  assert.equal(v.ok, false);
  assert.match(v.message, /in time/);
});

test('runSelfLaunchCheck starts the child through the given launch with --version --json', async () => {
  let seen: unknown[] = [];
  const v = await runSelfLaunchCheck(own, async (launch, args, ms) => { seen = [launch, args, ms]; return child({}); }, { command: '/bin/crew', args: [] }, 50);
  assert.equal(v.ok, true);
  assert.deepEqual(seen, [{ command: '/bin/crew', args: [] }, ['--version', '--json'], 50]);
});

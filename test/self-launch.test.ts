import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selfLaunch } from '../src/runtime-info.ts';

test('under an interpreter the launch is the interpreter, its flags and the script (CREW-3277)', () => {
  const l = selfLaunch({ compiled: false, execPath: '/usr/bin/node', execArgv: ['--experimental-strip-types'], argv1: '/opt/crew/bin/crew' });
  assert.deepEqual(l, { command: '/usr/bin/node', args: ['--experimental-strip-types', '/opt/crew/bin/crew'] });
});

test('a compiled binary re-launches as the binary alone, never with its virtual script path (CREW-3277)', () => {
  const l = selfLaunch({ compiled: true, execPath: '/Applications/Crew/crew', execArgv: [], argv1: '/$bunfs/root/crew' });
  assert.deepEqual(l, { command: '/Applications/Crew/crew', args: [] });
});

test('no source file builds a self-launch from process.argv[1] outside the helper (CREW-3277)', () => {
  const dir = join(import.meta.dirname, '..', 'src');
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && f !== 'runtime-info.ts')
    .filter((f) => /process\.argv\[1\]/.test(readFileSync(join(dir, f), 'utf8')));
  assert.deepEqual(offenders, [], 'use selfLaunch() from runtime-info.ts');
});

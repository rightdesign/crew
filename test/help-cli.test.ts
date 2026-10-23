import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { helpRequest } from '../src/argv.ts';
import { CREW, CREW_ENV } from './helpers/crew-bin.ts';

const run = (args: string[]) =>
  spawnSync(CREW, args, { encoding: 'utf8', env: { ...process.env, ...CREW_ENV } });

test('helpRequest only matches a leading --help, -h or help (CREW-2410)', () => {
  assert.equal(helpRequest(['--help']), true);
  assert.equal(helpRequest(['-h']), true);
  assert.equal(helpRequest(['help']), true);
  assert.equal(helpRequest(['poll', '--help']), false);
  assert.equal(helpRequest([]), false);
});

for (const arg of ['--help', '-h', 'help']) {
  test(`crew ${arg} prints usage to stdout and exits 0 (CREW-2410)`, () => {
    const r = run([arg]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /crew poll/);
    assert.equal(r.stderr, '');
  });
}

test('a bare crew prints usage to stderr and exits 2 (CREW-2410)', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /crew poll/);
  assert.equal(r.stdout, '');
});

test('an unknown flag or command names itself, then usage on stderr, exit 2 (CREW-2410)', () => {
  const cases: [string, string][] = [['--nope', 'unknown option "--nope"'], ['nonsense', 'unknown command "nonsense"']];
  for (const [arg, line] of cases) {
    const r = run([arg]);
    assert.equal(r.status, 2, arg);
    assert.equal(r.stdout, '', arg);
    assert.equal(r.stderr.split('\n')[0], `crew: ${line}`, arg);
    assert.match(r.stderr, /crew poll/, arg);
  }
});

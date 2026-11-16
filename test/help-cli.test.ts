import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { helpRequest, commandHelpRequest } from '../src/argv.ts';
import { CREW, CREW_ENV } from './helpers/crew-bin.ts';

// CI has no crew.yaml; point the config search at a file that does not exist so these
// tests behave the same on a machine that has one (CREW-2492).
const NO_CONFIG = join(mkdtempSync(join(tmpdir(), 'crew-noconfig-')), 'crew.yaml');
const run = (args: string[]) =>
  spawnSync(CREW, args, { encoding: 'utf8', env: { ...process.env, ...CREW_ENV, CREW_CONFIG: NO_CONFIG } });

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

test('KNOWN_COMMANDS lists every command the dispatch handles (CREW-2492)', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');
  const set = new Set([...src.match(/const KNOWN_COMMANDS = new Set\(\[([^\]]*)\]/)![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!));
  const dispatch = src.slice(src.indexOf('\nswitch (command)'));
  const cases = [...dispatch.matchAll(/^  case '([^']+)':/gm)].map((m) => m[1]!);
  assert.ok(cases.length > 20);
  for (const c of cases) assert.ok(set.has(c), `${c} missing from KNOWN_COMMANDS`);
});

test('commandHelpRequest finds a help flag after the command, not as a flag value (CREW-3446)', () => {
  assert.equal(commandHelpRequest(['poll', '--help']), true);
  assert.equal(commandHelpRequest(['worktree', '-h']), true);
  assert.equal(commandHelpRequest(['run', '--role', 'dev', '--help']), true);
  assert.equal(commandHelpRequest(['run', '--role', '--help']), false);
  assert.equal(commandHelpRequest(['poll']), false);
  assert.equal(commandHelpRequest(['run', '--', '--help']), false);
});

test('crew <command> --help and -h print usage, exit 0, and write no event (CREW-3446)', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');
  const set = [...src.match(/const KNOWN_COMMANDS = new Set\(\[([^\]]*)\]/)![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  const state = mkdtempSync(join(tmpdir(), 'crew-helpstate-'));
  for (const c of set) {
    for (const flag of ['--help', '-h']) {
      const r = spawnSync(CREW, [c, flag], { encoding: 'utf8', env: { ...process.env, ...CREW_ENV, CREW_CONFIG: NO_CONFIG, CREW_STATE_DIR: state } });
      assert.equal(r.status, 0, `${c} ${flag}`);
      assert.match(r.stdout, /crew poll/, `${c} ${flag}`);
      assert.equal(r.stderr, '', `${c} ${flag}`);
    }
  }
  assert.equal(existsSync(join(state, 'events.jsonl')), false);
});

test('a command with a missing argument and no help flag still fails (CREW-3446)', () => {
  const r = run(['worktree']);
  assert.notEqual(r.status, 0);
});

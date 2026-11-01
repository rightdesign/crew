// CREW-2908: `crew sandbox policy|build|images|cache` through the real CLI. They
// once lived in three `case 'sandbox'` clauses of one switch, so only `policy`
// was reachable and the rest printed its usage. No network, no tracker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREW, CREW_ENV } from './helpers/crew-bin.ts';

const dir = mkdtempSync(join(tmpdir(), 'crew-sandbox-dispatch-'));
const config = join(dir, 'crew.yaml');
writeFileSync(config, 'ship:\n  name: "Test Ship"\n  agent:\n    bin: "/usr/bin/true"\n    model: "m"\nroutes:\n  - route: ws/proj\n    enabled: false\n    area: "Proj"\n');

const run = (args: string[]) =>
  spawnSync(process.execPath, [CREW, 'sandbox', ...args], { env: { ...process.env, ...CREW_ENV, CREW_CONFIG: config }, encoding: 'utf8' });

// The combined usage block only the dispatcher's own fallthrough prints.
const USAGE = /crew sandbox build \[REPO\]/;

const REACHABLE: Array<[string, string[]]> = [
  ['policy', ['policy', '--route', 'ws/proj', '--role', 'dev', '--json']],
  ['build', ['build', '--json']],
  ['images', ['images', '--json']],
  ['cache', ['cache', '--json']],
];

for (const [name, args] of REACHABLE) {
  test(`crew sandbox ${name} reaches its own handler, not the usage block`, () => {
    const r = run(args);
    assert.doesNotMatch(r.stderr, USAGE, r.stderr);
    assert.doesNotMatch(r.stdout, USAGE);
  });
}

test('images lists no repositories as an empty JSON array', () => {
  const r = run(['images', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), []);
});

test('a missing or unknown subcommand prints one usage block naming all four, exit 2', () => {
  for (const args of [[], ['bogus']]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    for (const sub of ['policy', 'build', 'images', 'cache']) assert.match(r.stderr, new RegExp(`crew sandbox ${sub}`), `${args.join(' ')} ${sub}`);
  }
});

// `crew repos check` (CREW-2590) through the real CLI: no network, no tracker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREW, CREW_ENV } from './helpers/crew-bin.ts';

const VALID = 'version: 1\nhooks:\n  test: pnpm test\n  build: pnpm build\n  deploy: ./ship.sh\n';

function checkout(body?: string, file = '.crew.yaml'): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-check-'));
  if (body !== undefined) writeFileSync(join(dir, file), body);
  return dir;
}

/** A CREW_CONFIG that does not exist: the bare form must not need one. */
const NO_CONFIG = join(tmpdir(), 'crew-check-no-such-config.yaml');

function run(args: string[], config = NO_CONFIG) {
  const r = spawnSync(process.execPath, [CREW, 'repos', 'check', ...args], {
    env: { ...process.env, ...CREW_ENV, CREW_CONFIG: config }, encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('a valid file prints the effective block, both rendered samples and a syntax line per hook, exit 0', () => {
  const r = run([checkout(VALID)]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /release\.mode\s+local/);
  assert.match(r.stdout, /branch\.base\s+main/);
  assert.match(r.stdout, /with a project tag: branch tabl-123/);
  assert.match(r.stdout, /without a project tag: branch issue-123/);
  for (const h of ['test', 'build', 'deploy']) assert.match(r.stdout, new RegExp(`${h}: syntax ok`));
});

test('no spec file says so and exits 1', () => {
  const r = run([checkout()]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /no \.crew\.yaml/);
});

test('an unknown top-level key or hook name prints the loader error and exits 1', () => {
  for (const body of [`${VALID}colour: red\n`, `${VALID}  tset: x\n`]) {
    const r = run([checkout(body)]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /\.crew\.yaml/);
    assert.match(r.stdout, /colour|tset/);
  }
});

test('a hook with a shell syntax error names the hook and the shell message, exit 1', () => {
  const r = run([checkout('version: 1\nhooks:\n  test: pnpm test\n  build: "echo \'oops"\n  deploy: ./ship.sh\n')]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /build: syntax ERROR/);
  assert.match(r.stdout, /unexpected EOF|unexpected end of file/);
  assert.match(r.stdout, /test: syntax ok/);
});

test('--strict turns a readiness finding into exit 1; without it the finding prints and exit is 0', () => {
  // (`ci_auto` without a `released` hook is refused by the loader itself, so the finding comes from a missing build hook.)
  const dir = checkout('version: 1\nhooks:\n  test: pnpm test\n  deploy: ./ship.sh\n');
  const lax = run([dir]);
  assert.equal(lax.code, 0, lax.stderr);
  assert.match(lax.stdout, /release readiness: no build hook/);
  assert.equal(run([dir, '--strict']).code, 1);
});

test('--json round-trips and carries every section', () => {
  const r = run([checkout(VALID), '--json']);
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  for (const k of ['file', 'parsed', 'effective', 'readiness', 'hooks', 'shadowed']) assert.ok(k in j, k);
  assert.deepEqual(j.hooks.map((h: { name: string }) => h.name), ['test', 'build', 'deploy']);
  assert.equal(j.hooks[0].syntax.status, 'ok');
});

test('--route resolves against the route and reports a hook the ship also sets as shadowed', () => {
  const dir = checkout(VALID);
  const home = mkdtempSync(join(tmpdir(), 'crew-check-ship-'));
  mkdirSync(join(home, 'state'));
  writeFileSync(join(home, '.env'), 'KEY=k\n');
  const cfg = join(home, 'crew.yaml');
  writeFileSync(cfg, `ship:
  name: Test Ship
  agent: { bin: /bin/echo }
  stateDir: state
  logFile: ${join(home, 'crew.log')}
routes:
  - route: test/proj
    enabled: true
    dir: ${dir}
    baseUrl: http://127.0.0.1:1
    apiKeyFile: ${join(home, '.env')}
    apiKeyVar: KEY
    hooks:
      test: ship-side test
    resolved:
      workspaceId: ws-1
      models: { issues: i, comments: c, crew: w }
      seats: { dev: d, design: g, qa: q }
      operator: o
`);
  const r = run(['--route', 'test/proj', dir, '--json'], cfg);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).shadowed.includes('hooks.test'));
  const named = run(['test/proj', 'proj'], cfg);
  assert.match(named.stderr, /no repo named "proj"/);
});

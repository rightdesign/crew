// CREW-3332: a git that cannot run is reported as that, not as "not a git checkout".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREW, CREW_ENV } from './helpers/crew-bin.ts';
import { probeGit } from '../src/git.ts';

const MSG = 'xcode-select: error: stub developer tools are broken';

function setup(port = 1) {
  const home = mkdtempSync(join(tmpdir(), 'crew-gu-'));
  const checkout = join(home, 'project');
  mkdirSync(checkout);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: checkout });
  const plain = join(home, 'plain');
  mkdirSync(plain);
  const stubDir = join(home, 'stub');
  mkdirSync(stubDir);
  writeFileSync(join(stubDir, 'git'), `#!/bin/sh\necho "${MSG}" >&2\nexit 1\n`);
  chmodSync(join(stubDir, 'git'), 0o755);
  writeFileSync(join(home, '.env'), 'KEY=k\n');
  const cfg = join(home, 'crew.yaml');
  writeFileSync(cfg, `ship:
  name: Test Ship
  agent: { bin: /bin/echo }
  stateDir: state
  logFile: ${join(home, 'crew.log')}
  extraPath: ${stubDir}
routes:
  - route: test/proj
    enabled: true
    dir: ${checkout}
    worktreePrefix: proj-issue-
    baseUrl: http://127.0.0.1:${port}
    apiKeyFile: ${join(home, '.env')}
    apiKeyVar: KEY
    resolved:
      workspaceId: ws-1
      models: { issues: i, comments: c, crew: w }
      seats: { dev: d, design: g, qa: q }
      operator: o
`);
  const run = (args: string[], stubFirst: boolean) => spawnSync(process.execPath, [CREW, ...args], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, ...CREW_ENV, CREW_CONFIG: cfg, ...(stubFirst ? { PATH: `${stubDir}:${process.env.PATH}` } : {}) },
  });
  return { home, checkout, plain, run };
}

test('probeGit reports a failing git with its message', () => {
  const { home } = setup();
  const r = probeGit({ ...process.env, PATH: `${join(home, 'stub')}:${process.env.PATH}` });
  assert.equal(r.ok, false);
  assert.match((r as { detail: string }).detail, /stub developer tools are broken/);
  assert.equal(probeGit().ok, true);
});

test('repos add: a failing git is reported as that, not as a non-checkout', () => {
  const s = setup();
  const r = s.run(['repos', 'add', 'test/proj', 'project', s.checkout], true);
  const out = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.status, 0);
  assert.match(out, /stub developer tools are broken/);
  assert.doesNotMatch(out, /is not a git checkout/);
});

test('repos add: a git that runs but refuses the folder (ownership) is reported as git failing, not as a non-checkout', () => {
  const s = setup();
  const dir = join(s.home, 'stub2');
  mkdirSync(dir);
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(dir, 'git'), `#!/bin/sh\nif [ "$1" = "--version" ]; then exec ${real} "$@"; fi\necho "fatal: detected dubious ownership in repository" >&2\nexit 128\n`);
  chmodSync(join(dir, 'git'), 0o755);
  const r = spawnSync(process.execPath, [CREW, 'repos', 'add', 'test/proj', 'project', s.checkout], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, ...CREW_ENV, CREW_CONFIG: join(s.home, 'crew.yaml'), PATH: `${dir}:${process.env.PATH}` },
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.status, 0);
  assert.match(out, /dubious ownership/);
  assert.doesNotMatch(out, /is not a git checkout/);
});

test('repos add: a folder that is not a checkout still says so, and a missing path says it does not exist', () => {
  const s = setup();
  const a = s.run(['repos', 'add', 'test/proj', 'plain', s.plain], false);
  assert.match(`${a.stdout}${a.stderr}`, /is not a git checkout/);
  const missing = join(s.home, 'nope');
  const b = s.run(['repos', 'add', 'test/proj', 'nope', missing], false);
  assert.match(`${b.stdout}${b.stderr}`, /does not exist/);
  assert.doesNotMatch(`${b.stdout}${b.stderr}`, /is not a git checkout/);
});

test('doctor: a failing git on the scheduler PATH is reported in text and JSON', async () => {
  // The text report asks the tracker; a stub server that answers every list with an empty one keeps it local.
  const server = createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end('[]'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const s = setup((server.address() as AddressInfo).port);
    const env = { ...process.env, ...CREW_ENV, CREW_CONFIG: join(s.home, 'crew.yaml') };
    const runAsync = async (args: string[]) => {
      const child = spawn(process.execPath, [CREW, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      await once(child, 'close');
      return out;
    };
    const text = await runAsync(['doctor']);
    assert.match(text, /git: +FAILED to run \(.*\): xcode-select: error: stub developer tools are broken/);
    const json = await runAsync(['doctor', '--json']);
    const parsed = JSON.parse(json) as { problems: Array<{ kind: string; message: string }> };
    const p = parsed.problems.find((x) => x.kind === 'git_unrunnable');
    assert.ok(p);
    assert.match(p.message, /stub developer tools are broken/);
  } finally {
    server.close();
  }
});

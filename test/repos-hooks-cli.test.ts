// `crew repos hooks` through the real CLI process (CREW-2317): the unit tests call
// the functions directly and so cannot see argv parsing or the global signal handlers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREW, CREW_ENV } from './helpers/crew-bin.ts';

function ship(claudeScript?: string) {
  const home = mkdtempSync(join(tmpdir(), 'crew-rh-'));
  const repo = join(home, 'project');
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), 'x');
  writeFileSync(join(repo, '.github', 'workflows', 'release.yml'), 'on: push');
  writeFileSync(join(home, '.env'), 'KEY=k\n');
  let agentLine = '  agent: { bin: /bin/echo }';
  if (claudeScript) {
    const bin = join(home, 'fake-claude');
    writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\n${claudeScript}\n`);
    chmodSync(bin, 0o755);
    agentLine = `  agent: { bin: ${bin} }`;
  }
  const cfgPath = join(home, 'crew.yaml');
  writeFileSync(cfgPath, `ship:
  name: Test Ship
${agentLine}
  stateDir: state
  logFile: ${join(home, 'crew.log')}
routes:
  - route: test/proj
    enabled: true
    dir: ${repo}
    worktreePrefix: proj-issue-
    baseUrl: http://127.0.0.1:1
    apiKeyFile: ${join(home, '.env')}
    apiKeyVar: KEY
    resolved:
      workspaceId: ws-1
      models: { issues: i, comments: c, crew: w }
      seats: { dev: d, design: g, qa: q }
      operator: o
`);
  const start = (...args: string[]) => {
    const child = spawn(process.execPath, [CREW, 'repos', 'hooks', 'test/proj', 'project', ...args], {
      env: { ...process.env, ...CREW_ENV, CREW_CONFIG: cfgPath }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d; });
    child.stderr.on('data', (d: Buffer) => { stderr += d; });
    return { child, out: () => ({ stdout, stderr }) };
  };
  return { repo, start };
}

test('--write repo --recipes ID is parsed as a flag value, not a positional', async () => {
  const s = ship();
  const p = s.start('--write', 'repo', '--recipes', 'github-actions-release', '--json');
  const [code] = await once(p.child, 'exit');
  assert.equal(code, 0, p.out().stderr);
  assert.ok(existsSync(join(s.repo, '.crew.yaml')));
  const bad = s.start('--write', 'route', '--recipes', 'bogus');
  const [badCode] = await once(bad.child, 'exit');
  assert.equal(badCode, 2);
  assert.match(bad.out().stderr, /bogus/);
  assert.doesNotMatch(bad.out().stderr, /expected: crew repos hooks/);
});

test('--hook key=value overrides the sniffed value, adds new keys and refuses unknown ones', async () => {
  const s = ship();
  writeFileSync(join(s.repo, 'Makefile'), 'test:\n\techo t\nbuild:\n\techo b\n');
  const p = s.start('--write', 'repo', '--hook', 'test=make check', '--hook', 'version=cat VERSION', '--json');
  const [code] = await once(p.child, 'exit');
  assert.equal(code, 0, p.out().stderr);
  const out = JSON.parse(p.out().stdout);
  assert.deepEqual(out.written.hooks.sort(), ['build', 'test', 'version']);
  const yaml = readFileSync(join(s.repo, '.crew.yaml'), 'utf8');
  assert.match(yaml, /test: "make check"/);
  assert.match(yaml, /build: "make build"/);
  assert.match(yaml, /version: "cat VERSION"/);
  const bad = s.start('--write', 'route', '--hook', 'tset=x');
  const [badCode] = await once(bad.child, 'exit');
  assert.equal(badCode, 2);
  assert.match(bad.out().stderr, /unknown key "tset".*valid keys: test, build/);
  const noWrite = s.start('--hook', 'test=x');
  const [nwCode] = await once(noWrite.child, 'exit');
  assert.equal(nwCode, 2);
  assert.match(noWrite.out().stderr, /--hook only applies with --write/);
});

test('SIGINT during --agent reports cancelled with a non-zero exit instead of exiting 0 silently', async () => {
  const s = ship('sleep 30');
  const p = s.start('--agent', '--json');
  await new Promise((r) => setTimeout(r, 1500));
  const t0 = Date.now();
  p.child.kill('SIGINT');
  const [code] = await once(p.child, 'exit');
  assert.ok(Date.now() - t0 < 10_000);
  assert.equal(code, 1, p.out().stderr);
  assert.equal(JSON.parse(p.out().stdout).agentError.reason, 'cancelled');
});

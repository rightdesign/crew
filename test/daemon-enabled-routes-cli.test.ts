// CREW-3238: the daemon's enabled interlock tests the routes it will serve, not `cfg.routes[0]`, through the real CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREW, CREW_ENV } from './helpers/crew-bin.ts';

function config(enabled: boolean[]): { cfg: string; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'crew-daemon-enabled-'));
  mkdirSync(join(home, 'state'));
  writeFileSync(join(home, '.env'), 'KEY=k\n');
  const routes = enabled.map((on, i) => `  - route: r${i}/issues
    enabled: ${on}
    dir: ${home}
    baseUrl: http://127.0.0.1:1
    apiKeyFile: ${join(home, '.env')}
    apiKeyVar: KEY
    resolved:
      workspaceId: ws-${i}
      models: { issues: i, comments: c, crew: w }
      seats: { dev: d, design: g, qa: q }
      operator: o
`).join('');
  const cfg = join(home, 'crew.yaml');
  writeFileSync(cfg, `ship:
  name: Test Ship
  agent: { bin: /bin/echo }
  stateDir: state
  logFile: ${join(home, 'crew.log')}
routes:
${routes}`);
  return { cfg, home };
}

// A daemon that starts runs until killed, so give it a few seconds and judge by what it said and recorded.
function daemon(cfg: string, args: string[] = []) {
  const r = spawnSync(process.execPath, [CREW, 'daemon', ...args], {
    env: { ...process.env, ...CREW_ENV, CREW_CONFIG: cfg, HOME: mkdtempSync(join(tmpdir(), 'crew-daemon-home-')) },
    encoding: 'utf8', timeout: 6_000, killSignal: 'SIGKILL',
  });
  return { code: r.status, stderr: r.stderr ?? '' };
}

function attention(home: string): string {
  const f = join(home, 'state', '.ship-attention.json');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

test('bare daemon on a fleet whose first route is disabled but a later one is enabled starts', () => {
  const { cfg, home } = config([false, false, true]);
  const r = daemon(cfg);
  assert.doesNotMatch(r.stderr, /not enabled|refusing/, r.stderr);
  assert.doesNotMatch(attention(home), /daemon_start_failed/);
});

test('bare daemon with several routes and none enabled fails through failDaemonStart', () => {
  const { cfg, home } = config([false, false]);
  const r = daemon(cfg);
  assert.equal(r.code, 1, r.stderr);
  assert.match(attention(home), /daemon_start_failed/);
  assert.match(attention(home), /no enabled routes/);
});

test('daemon naming a disabled route refuses through failDaemonStart, not a bare exit 0', () => {
  const { cfg, home } = config([true, false]);
  const r = daemon(cfg, ['r1/issues']);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /not enabled/);
  assert.match(attention(home), /daemon_start_failed/);
});

test('a one-route ship with its route disabled still refuses; enabled starts', () => {
  const off = config([false]);
  const a = daemon(off.cfg);
  assert.equal(a.code, 1, a.stderr);
  assert.match(a.stderr, /not enabled/);
  const on = config([true]);
  const b = daemon(on.cfg);
  assert.doesNotMatch(b.stderr, /not enabled|refusing/, b.stderr);
});

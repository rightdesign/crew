// CREW-3064: a route the daemon can name but cannot run a pass for (its key file is missing) is a startup failure, through the real CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREW, CREW_ENV } from './helpers/crew-bin.ts';

function config(withKey: boolean): { cfg: string; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'crew-startfail-cli-'));
  mkdirSync(join(home, 'state'));
  if (withKey) writeFileSync(join(home, '.env'), 'KEY=k\n');
  const cfg = join(home, 'crew.yaml');
  writeFileSync(cfg, `ship:
  name: Test Ship
  agent: { bin: /bin/echo }
  stateDir: state
  logFile: ${join(home, 'crew.log')}
routes:
  - route: one/issues
    enabled: true
    dir: ${home}
    baseUrl: http://127.0.0.1:1
    apiKeyFile: ${join(home, '.env')}
    apiKeyVar: KEY
    resolved:
      workspaceId: ws-one
      models: { issues: i, comments: c, crew: w }
      seats: { dev: d, design: g, qa: q }
      operator: o
`);
  return { cfg, home };
}

function daemon(cfg: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...CREW_ENV };
  delete env.CREW_API_KEY; // the ambient key is the fallback for a missing key file
  return spawnSync(process.execPath, [CREW, 'daemon'], {
    env: { ...env, CREW_CONFIG: cfg, HOME: mkdtempSync(join(tmpdir(), 'crew-startfail-home-')) },
    encoding: 'utf8', timeout: 30_000,
  });
}

test('a route with a missing key file exits the daemon with a daemon_start_failed attention item', () => {
  const { cfg, home } = config(false);
  const r = daemon(cfg);
  assert.equal(r.status, 1, r.stderr);
  const attention = readFileSync(join(home, 'state', '.ship-attention.json'), 'utf8');
  assert.match(attention, /daemon_start_failed/);
  assert.match(attention, /no route can run a pass/);
  assert.ok(existsSync(join(home, 'state', '.daemon-start-failure.json')));

  // `crew status --json` reads the item even though the route's key is the thing that failed.
  const env: NodeJS.ProcessEnv = { ...process.env, ...CREW_ENV, CREW_CONFIG: cfg, HOME: mkdtempSync(join(tmpdir(), 'crew-startfail-home-')) };
  delete env.CREW_API_KEY;
  const status = spawnSync(process.execPath, [CREW, 'status', '--json'], { env, encoding: 'utf8', timeout: 30_000 });
  const parsed = JSON.parse(status.stdout) as { attention: Array<{ kind: string }> };
  assert.ok(parsed.attention.some((i) => i.kind === 'daemon_start_failed'), status.stdout);
});

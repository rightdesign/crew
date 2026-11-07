// CREW-3063: `crew daemon` names no route on a two-route ship, through the real CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREW, CREW_ENV } from './helpers/crew-bin.ts';

function twoRouteConfig(): string {
  const home = mkdtempSync(join(tmpdir(), 'crew-daemon-fleet-'));
  mkdirSync(join(home, 'state'));
  writeFileSync(join(home, '.env'), 'KEY=k\n');
  const route = (name: string): string => `  - route: ${name}
    enabled: true
    dir: ${home}
    baseUrl: http://127.0.0.1:1
    apiKeyFile: ${join(home, '.env')}
    apiKeyVar: KEY
    resolved:
      workspaceId: ws-${name.split('/')[0]}
      models: { issues: i, comments: c, crew: w }
      seats: { dev: d, design: g, qa: q }
      operator: o
`;
  const cfg = join(home, 'crew.yaml');
  writeFileSync(cfg, `ship:
  name: Test Ship
  agent: { bin: /bin/echo }
  stateDir: state
  logFile: ${join(home, 'crew.log')}
routes:
${route('one/issues')}${route('two/issues')}`);
  return cfg;
}

function crew(args: string[], config: string) {
  const r = spawnSync(process.execPath, [CREW, ...args], {
    env: { ...process.env, ...CREW_ENV, CREW_CONFIG: config, HOME: mkdtempSync(join(tmpdir(), 'crew-daemon-home-')) }, encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('crew daemon start|status|restart name no route on a two-route ship', () => {
  const cfg = twoRouteConfig();
  for (const sub of ['start', 'status', 'restart']) {
    const r = crew(['daemon', sub, '--dry-run'], cfg);
    assert.doesNotMatch(r.stderr, /name one/, `${sub}: ${r.stderr}`);
    assert.notEqual(r.code, 2, `${sub}: ${r.stderr}`);
  }
});

test('crew daemon with no route no longer stops at "name one" on a two-route ship', () => {
  // --dry-run is refused by the daemon itself, after route resolution; reaching that refusal proves it got past "name one".
  const r = crew(['daemon', '--dry-run'], twoRouteConfig());
  assert.doesNotMatch(r.stderr, /name one/);
  assert.match(r.stderr, /daemon does not support --dry-run/);
});

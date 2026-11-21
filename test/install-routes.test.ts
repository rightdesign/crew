// CREW-3875: `crew install` and `crew uninstall` act on the ship's scheduler units, which name no
// route, so a ship with several routes must never be asked to name one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foreignInstallRefusal } from '../src/install.ts';

const route = (name: string) => `  - route: ${name}\n    apiKey: k\n    baseUrl: https://example.test\n    dir: /tmp/${name.replace('/', '-')}\n    worktreePrefix: w-\n    enabled: true\n`;

function crew(routes: string[], args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-install-routes-'));
  writeFileSync(join(dir, 'crew.yaml'), `routes:\n${routes.map(route).join('')}`);
  const r = spawnSync(process.execPath, ['--experimental-strip-types', join(import.meta.dirname, '..', 'src', 'cli.ts'), ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: dir, CREW_CONFIG: join(dir, 'crew.yaml'), DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent-crew-test-bus', NODE_NO_WARNINGS: '1' },
    encoding: 'utf8',
    timeout: 45000,
  });
  return { out: `${r.stdout}${r.stderr}`, code: r.status };
}

const TWO = ['a/one', 'b/two'];

for (const args of [
  ['install', '--dry-run'],
  ['install', '--replace', '--dry-run'],
  ['uninstall', '--dry-run'],
  ['install', 'a/one', '--dry-run'],
  ['uninstall', 'b/two', '--dry-run'],
]) {
  test(`crew ${args.join(' ')} on a two-route ship never asks for a route`, { timeout: 60000 }, () => {
    const r = crew(TWO, args);
    assert.doesNotMatch(r.out, /name one/);
    assert.doesNotMatch(r.out, /no route/);
  });
}

test('a one-route ship still installs and uninstalls with and without the route name', { timeout: 60000 }, () => {
  for (const args of [['install', '--dry-run'], ['install', 'a/one', '--dry-run'], ['uninstall', '--dry-run']]) {
    const r = crew(['a/one'], args);
    assert.doesNotMatch(r.out, /name one|no route/, args.join(' '));
  }
});

test('the refusal names both copies and both commands, none of which needs a route', () => {
  const msg = foreignInstallRefusal(
    [{ label: 'com.tablation.crew.00000000', program: '/old/crew/bin/crew' }],
    '/new/crew/bin/crew',
  );
  assert.ok(msg.includes('/old/crew/bin/crew') && msg.includes('/new/crew/bin/crew'));
  assert.ok(msg.includes('`crew install --replace`'));
  assert.ok(msg.includes('`/old/crew/bin/crew uninstall`'));
  assert.match(msg, /Nothing was changed/);
  assert.match(msg, /crew\.yaml, routes or tickets/);
});

test('an unreadable program offers only --replace', () => {
  const msg = foreignInstallRefusal([{ label: 'com.tablation.crew.00000000', program: null }], '/new/bin/crew');
  assert.ok(msg.includes('only --replace'));
  assert.ok(!msg.includes(' uninstall`'));
});

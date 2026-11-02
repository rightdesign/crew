import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withUserBusEnv } from '../src/install.ts';
import { runtimeDirWarning } from '../src/doctor-checks.ts';

const yes = () => true;
const no = () => false;

test('withUserBusEnv defaults both variables from /run/user/<uid> when unset', () => {
  const env = withUserBusEnv({ HOME: '/home/crew' }, { platform: 'linux', uid: 1001, exists: yes });
  assert.equal(env.XDG_RUNTIME_DIR, '/run/user/1001');
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1001/bus');
  assert.equal(env.HOME, '/home/crew');
});

test('withUserBusEnv keeps values already set', () => {
  const base = { XDG_RUNTIME_DIR: '/x', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/y' };
  assert.equal(withUserBusEnv(base, { platform: 'linux', uid: 1, exists: yes }), base);
  const half = withUserBusEnv({ XDG_RUNTIME_DIR: '/x' }, { platform: 'linux', uid: 1, exists: yes });
  assert.equal(half.XDG_RUNTIME_DIR, '/x');
  assert.equal(half.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/x/bus');
});

test('withUserBusEnv leaves env alone when the directory is missing or off Linux', () => {
  const base = { A: '1' };
  assert.equal(withUserBusEnv(base, { platform: 'linux', uid: 1, exists: no }), base);
  assert.equal(withUserBusEnv(base, { platform: 'darwin', uid: 1, exists: yes }), base);
});

test('runtimeDirWarning reports a missing runtime dir only for a non-root Linux user', () => {
  assert.match(runtimeDirWarning('linux', 1001, no, 'crew')!, /enable-linger crew/);
  assert.equal(runtimeDirWarning('linux', 1001, yes), null);
  assert.equal(runtimeDirWarning('linux', 0, no), null);
  assert.equal(runtimeDirWarning('darwin', 501, no), null);
});

test('every spawn of a planDaemonControl command in cli.ts passes withUserBusEnv', () => {
  const lines = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8').split('\n');
  const sites = lines.filter((l) => /spawnSync\((cmd\[0\]!|control\.statusCommand\[0\]!)/.test(l));
  assert.ok(sites.length >= 4, `expected at least 4 daemon-control spawn sites, found ${sites.length}`);
  for (const l of sites) assert.match(l, /env: withUserBusEnv\(\)/, l.trim());
});

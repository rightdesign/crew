import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseLaunchctlPrint, parseSystemctlShow, classifyDaemon, daemonLineText, reloadRequestText, daemonProblem, probeDaemonUnit,
} from '../src/daemon-liveness.ts';
import type { InstallPlan } from '../src/install.ts';

const dir = mkdtempSync(join(tmpdir(), 'liveness-'));
const unit = join(dir, 'u.plist');
const log = join(dir, 'crew.scheduler.log');
writeFileSync(unit, '');
writeFileSync(log, 'noise\nroute name required\n\n');
const plan = (unitPaths: string[]) => ({ mechanism: 'launchd', unitPaths, schedulerLog: log }) as InstallPlan;

const printDead = '\tstate = spawn scheduled\n\tlast exit code = 2\n';
const printLive = '\tstate = running\n\tpid = 4242\n\tlast exit code = (never exited)\n';

test('launchctl print parsing', () => {
  assert.deepEqual(parseLaunchctlPrint(printDead), { pid: null, lastExitCode: 2 });
  assert.deepEqual(parseLaunchctlPrint(printLive), { pid: 4242, lastExitCode: null });
});

test('systemctl show parsing treats MainPID=0 as no process', () => {
  const r = parseSystemctlShow('ActiveState=activating\nMainPID=0\nExecMainStatus=2\n');
  assert.deepEqual([r.pid, r.lastExitCode, r.active], [null, 2, 'activating']);
});

test('an installed unit that exits at startup is FAIL with the code and last log line, and the reload line stops blaming agents', () => {
  const d = probeDaemonUnit({ plan: plan([unit]), label: 'l', uid: 501, system: false, stamp: null, run: () => ({ status: 0, stdout: printDead }) });
  assert.equal(d.state, 'exited');
  assert.match(daemonLineText(d), /^FAIL daemon is not running: exited 2, last line of .*scheduler\.log: route name required$/);
  assert.match(reloadRequestText(3219, d, 0), /no daemon is running/);
  assert.doesNotMatch(reloadRequestText(3219, d, 0), /waiting for its running agents/);
  assert.equal(daemonProblem(d, 'r')!.severity, 'blocker');
});

test('a healthy daemon prints pid and start time, and the reload text is unchanged', () => {
  const d = probeDaemonUnit({ plan: plan([unit]), label: 'l', uid: 501, system: false, stamp: { pid: 4242, startedAt: 1_700_000_000_000 }, run: () => ({ status: 0, stdout: printLive }) });
  assert.equal(d.state, 'running');
  assert.match(daemonLineText(d), /^ok pid 4242, started 2023-11-14T22:13:20\.000Z$/);
  assert.match(reloadRequestText(30, d, 1), /waiting for its running agents/);
  assert.equal(daemonProblem(d, 'r'), null);
});

test('a stamp from another pid is not reported as this daemon\'s start', () => {
  const d = classifyDaemon({ plan: plan([unit]), installed: true, reading: { pid: 7, lastExitCode: null }, stamp: { pid: 8, startedAt: 1 }, logLine: null });
  assert.equal(d.startedAt, null);
});

test('a long-pending reload with no agent runs points at the daemon line', () => {
  const d = classifyDaemon({ plan: plan([unit]), installed: true, reading: { pid: 7, lastExitCode: null }, stamp: null, logLine: null });
  assert.match(reloadRequestText(700, d, 0), /not honoring it \(see the daemon line\)/);
});

test('no unit installed says so and points at crew install', () => {
  const d = probeDaemonUnit({ plan: plan([join(dir, 'absent.plist')]), label: 'l', uid: 501, system: false, stamp: null, run: () => assert.fail('must not run') });
  assert.equal(d.state, 'not_installed');
  assert.match(daemonLineText(d), /no daemon unit is installed.*`crew install`/);
  assert.equal(daemonProblem(d, 'r')!.kind, 'daemon_not_installed');
});

test('JSON problem carries kind, message and the structured liveness fields exist', () => {
  const d = probeDaemonUnit({ plan: plan([unit]), label: 'l', uid: 501, system: false, stamp: null, run: () => ({ status: 0, stdout: printDead }) });
  assert.deepEqual([d.pid, d.lastExitCode, d.lastLogLine], [null, 2, 'route name required']);
  assert.equal(daemonProblem(d, 'r')!.kind, 'daemon_not_running');
});

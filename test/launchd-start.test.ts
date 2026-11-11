import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLaunchdStart, startLaunchdDaemon, logTail, type CommandResult } from '../src/launchd-start.ts';

const unit = { unitPath: '/u/x.plist', label: 'com.tablation.crew.x', uid: 501 };

const printOut = (pid: number | null, exit: number | null) =>
  `${unit.label} = {\n\tstate = ${pid ? 'running' : 'not running'}\n${pid ? `\tpid = ${pid}\n` : ''}${exit !== null ? `\tlast exit code = ${exit}\n` : ''}}\n`;

/** A fake launchctl: `prints` answers successive `print` calls; every other command is recorded. */
function fake(prints: Array<CommandResult>, other: Partial<CommandResult> = {}) {
  const ran: string[][] = [];
  let i = 0;
  const run = (cmd: string[]): CommandResult | null => {
    ran.push(cmd);
    if (cmd[1] === 'print') return prints[Math.min(i++, prints.length - 1)]!;
    return { status: 0, stdout: '', stderr: '', ...other };
  };
  return { ran, run };
}
const ok = (stdout: string): CommandResult => ({ status: 0, stdout, stderr: '' });
const notLoaded: CommandResult = { status: 113, stdout: '', stderr: 'Could not find service' };
const base = { ...unit, schedulerLog: '/log/s.log', dryRun: false, sleep: () => {}, readLog: () => 'a\nb\n\nboom: cannot start\n' };

test('planLaunchdStart: unloaded loads, loaded kick-starts, running does nothing', () => {
  assert.deepEqual(planLaunchdStart({ loaded: false, pid: null, lastExitCode: null }, unit).commands, [['launchctl', 'load', '/u/x.plist']]);
  assert.deepEqual(planLaunchdStart({ loaded: true, pid: null, lastExitCode: 1 }, unit).commands, [['launchctl', 'kickstart', 'gui/501/com.tablation.crew.x']]);
  assert.deepEqual(planLaunchdStart({ loaded: true, pid: 42, lastExitCode: null }, unit).commands, []);
});

test('start on a running unit reports it and runs nothing; twice in a row exits 0 both times', () => {
  const f = fake([ok(printOut(42, null))]);
  for (let n = 0; n < 2; n++) {
    const r = startLaunchdDaemon({ ...base, run: f.run });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /already running \(pid 42\)/);
  }
  assert.ok(f.ran.every((c) => c[1] === 'print'));
});

test('start on an unloaded unit loads it and changes nothing else', () => {
  const f = fake([notLoaded]);
  const r = startLaunchdDaemon({ ...base, run: f.run });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(f.ran.filter((c) => c[1] !== 'print'), [['launchctl', 'load', '/u/x.plist']]);
});

test('start on a loaded unit that exits at startup reports exit status and log tail, exits non-zero', () => {
  const f = fake([ok(printOut(null, 1)), ok(printOut(null, 1))]);
  const r = startLaunchdDaemon({ ...base, run: f.run });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /did not stay up/);
  assert.match(r.stderr, /last exit status: 1/);
  assert.match(r.stderr, /boom: cannot start/);
  assert.deepEqual(f.ran.filter((c) => c[1] === 'kickstart'), [['launchctl', 'kickstart', 'gui/501/com.tablation.crew.x']]);
});

test('start on a loaded unit that stays up reports the pid', () => {
  const f = fake([ok(printOut(null, 0)), ok(printOut(77, null))]);
  const r = startLaunchdDaemon({ ...base, run: f.run });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /running \(pid 77\)/);
});

test('dry run prints the commands for the current state and runs none', () => {
  const f = fake([ok(printOut(null, 1))]);
  const r = startLaunchdDaemon({ ...base, dryRun: true, run: f.run });
  assert.equal(r.stdout, 'would run: launchctl kickstart gui/501/com.tablation.crew.x\n');
  assert.ok(f.ran.every((c) => c[1] === 'print'));
  const g = fake([notLoaded]);
  assert.equal(startLaunchdDaemon({ ...base, dryRun: true, run: g.run }).stdout, 'would run: launchctl load /u/x.plist\n');
});

test('restart path: assumeUnloaded loads then verifies a process stayed up', () => {
  const f = fake([ok(printOut(null, 78))]);
  const r = startLaunchdDaemon({ ...base, assumeUnloaded: true, verifyAfterLoad: true, run: f.run });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /last exit status: 78/);
  assert.deepEqual(f.ran[0], ['launchctl', 'load', '/u/x.plist']);
});

test('logTail keeps the last non-empty lines', () => {
  assert.deepEqual(logTail('a\n\nb\nc\n', 2), ['b', 'c']);
  assert.deepEqual(logTail(null), []);
});

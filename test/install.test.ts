import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planInstall, planUninstall, planDaemonControl, INTERVAL_SECONDS, findOnPath, dockerPathProblem, pathFor } from '../src/install.ts';
import type { Ship } from '../src/config.ts';

const ship = (over: Partial<Ship> = {}): Ship => ({
  name: 'Test Ship',
  platform: 'macos',
  agent: { bin: '/usr/local/bin/claude', model: 'claude-sonnet-5', maxThinkingTokens: 4096 },
  useNvm: true,
  stateDir: '/tmp/crew-state',
  logFile: '/tmp/crew.log',
  userAgent: 'Mozilla/5.0 CrewAgent/1.0',
  maxConcurrentAgents: 2,
  streamRetentionDays: 7,
  relayPort: 2222, relayHttpPort: 443,
  ...over,
});

test('macOS gets a launchd plist, never systemd or cron', () => {
  const plan = planInstall(ship(), '/opt/crew', 'macos', true);
  assert.equal(plan.mechanism, 'launchd');
  assert.equal(plan.unitPaths.length, 1);
  assert.match(plan.unitPaths[0]!, /Library\/LaunchAgents\/com\.tablation\.crew\.[0-9a-f]{8}\.plist$/);
  assert.equal(plan.crontabLine, null);
});

test('launchd\'s plan unloads before loading, so a changed plist actually takes effect on reinstall (ISSUE-678)', () => {
  const plan = planInstall(ship(), '/opt/crew', 'macos', true);
  assert.equal(plan.preLoadCommands.length, 1);
  assert.deepEqual(plan.preLoadCommands[0]!.slice(0, 2), ['launchctl', 'unload']);
  assert.equal(plan.preLoadCommands[0]![2], plan.unitPaths[0]);
  assert.deepEqual(plan.loadCommands[0], ['launchctl', 'load', plan.unitPaths[0]]);
});

test('systemd and cron need no unload step — daemon-reload/enable and a plain crontab overwrite already pick up a changed unit', () => {
  const sdPlan = planInstall(ship({ platform: 'linux' }), '/opt/crew', 'linux', true);
  assert.deepEqual(sdPlan.preLoadCommands, []);
  const cronPlan = planInstall(ship({ platform: 'linux' }), '/opt/crew', 'linux', false);
  assert.deepEqual(cronPlan.preLoadCommands, []);
});

test('the unit label is derived from crewHome, so two checkouts never collide', () => {
  // Same checkout, planned twice: same label, so a reinstall targets the
  // unit it wrote last time rather than minting a fresh name every run.
  const a1 = planInstall(ship(), '/opt/crew-a', 'macos', true);
  const a2 = planInstall(ship(), '/opt/crew-a', 'macos', true);
  assert.equal(a1.unitPaths[0], a2.unitPaths[0]);

  // Different checkouts: different labels on every mechanism, so one
  // checkout's install/uninstall can never touch another's unit.
  const b = planInstall(ship(), '/opt/crew-b', 'macos', true);
  assert.notEqual(a1.unitPaths[0], b.unitPaths[0]);

  // 'release' still writes a service+timer pair (unlike 'run', now
  // persistent — see the systemd 'run' tests below), so it's the one used
  // here to check both unit paths differ across checkouts.
  const sdA = planInstall(ship({ platform: 'linux' }), '/opt/crew-a', 'linux', true, 'release');
  const sdB = planInstall(ship({ platform: 'linux' }), '/opt/crew-b', 'linux', true, 'release');
  assert.notEqual(sdA.unitPaths[0], sdB.unitPaths[0]);
  assert.notEqual(sdA.unitPaths[1], sdB.unitPaths[1]);

  const cronOutA = planUninstall(ship({ platform: 'linux' }), '/opt/crew-a', 'linux', false);
  const cronOutB = planUninstall(ship({ platform: 'linux' }), '/opt/crew-b', 'linux', false);
  assert.notEqual(cronOutA.crontabLine, cronOutB.crontabLine);
});

test('the plist names an absolute interpreter, never a bare "node"', () => {
  const plan = planInstall(ship(), '/opt/crew', 'macos', true);
  const xml = Object.values(plan.unitContent)[0]!;
  assert.match(xml, /<string>\/.*<\/string>/); // process.execPath is absolute in this test runner
  assert.ok(!xml.includes('<string>node</string>'));
});

test('the run job\'s plist is a persistent service: RunAtLoad + KeepAlive, no StartInterval (ISSUE-763)', () => {
  const plan = planInstall(ship(), '/opt/crew', 'macos', true, 'run');
  const xml = Object.values(plan.unitContent)[0]!;
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.ok(!xml.includes('StartInterval'));
});

test('the release and passengers plists still do not fire at load — only run became persistent', () => {
  for (const job of ['release', 'passengers'] as const) {
    const plan = planInstall(ship(), '/opt/crew', 'macos', true, job);
    const xml = Object.values(plan.unitContent)[0]!;
    assert.match(xml, /<key>RunAtLoad<\/key>\s*<false\/>/);
    assert.match(xml, new RegExp(`<key>StartInterval</key>\\s*<integer>${INTERVAL_SECONDS}</integer>`));
    assert.ok(!xml.includes('KeepAlive'));
  }
});

test('the scheduler log is never the same file as the crew\'s own log', () => {
  const plan = planInstall(ship({ logFile: '/tmp/crew.log' }), '/opt/crew', 'macos', true);
  assert.notEqual(plan.schedulerLog, plan.crewLog);
  assert.equal(plan.crewLog, '/tmp/crew.log');
  assert.equal(plan.schedulerLog, '/tmp/crew.scheduler.log');
});

test('extraPath is prepended into the unit\'s own PATH, not left for the scheduler to guess', () => {
  const plan = planInstall(ship({ extraPath: '/opt/homebrew/bin' }), '/opt/crew', 'macos', true);
  const xml = Object.values(plan.unitContent)[0]!;
  assert.match(xml, /\/opt\/homebrew\/bin/);
});

test('linux with systemd gets a user service+timer for release/passengers, not cron', () => {
  const plan = planInstall(ship({ platform: 'linux' }), '/opt/crew', 'linux', true, 'release');
  assert.equal(plan.mechanism, 'systemd');
  assert.equal(plan.unitPaths.length, 2);
  assert.ok(plan.unitPaths.every((p) => p.includes('.config/systemd/user/')));
  assert.equal(plan.crontabLine, null);
});

test('the release job\'s systemd timer does not fire at load either', () => {
  const plan = planInstall(ship({ platform: 'linux' }), '/opt/crew', 'linux', true, 'release');
  const timer = plan.unitContent[plan.unitPaths[1]!]!;
  assert.ok(!timer.includes('OnBootSec'));
  assert.ok(!/Persistent\s*=\s*true/i.test(timer));
  assert.match(timer, new RegExp(`OnActiveSec=${INTERVAL_SECONDS}`));
});

test('linux with systemd gets a lone persistent .service for run, no .timer (ISSUE-763)', () => {
  const plan = planInstall(ship({ platform: 'linux' }), '/opt/crew', 'linux', true, 'run');
  assert.equal(plan.mechanism, 'systemd');
  assert.equal(plan.unitPaths.length, 1);
  assert.ok(plan.unitPaths[0]!.endsWith('.service'));
  const service = plan.unitContent[plan.unitPaths[0]!]!;
  assert.match(service, /Type=simple/);
  assert.match(service, /Restart=on-failure/);
  assert.match(service, /ExecStart=.*\bdaemon\b/);
  assert.match(service, /WantedBy=default\.target/);
  assert.deepEqual(plan.loadCommands[1], ['systemctl', '--user', 'enable', '--now', plan.unitPaths[0]!.split('/').pop()!]);
});

test('linux without systemd falls back to a crontab line, not a unit file', () => {
  const plan = planInstall(ship({ platform: 'linux' }), '/opt/crew', 'linux', false);
  assert.equal(plan.mechanism, 'cron');
  assert.equal(plan.unitPaths.length, 0);
  assert.ok(plan.crontabLine);
  assert.match(plan.crontabLine!, /\*\/2 \* \* \* \*/);
});

test('the cron line redirects to the scheduler log, appended, not the crew log', () => {
  const plan = planInstall(ship({ platform: 'linux' }), '/opt/crew', 'linux', false);
  assert.match(plan.crontabLine!, />> \/tmp\/crew\.scheduler\.log 2>&1$/);
});

test('windows has no plan yet — the ticket calls it "eventually"', () => {
  assert.throws(() => planInstall(ship({ platform: 'windows' }), '/opt/crew', 'windows', false));
});

test('the release job gets its own unit, distinct from run\'s — same checkout, two labels', () => {
  const runPlan = planInstall(ship(), '/opt/crew', 'macos', true, 'run');
  const releasePlan = planInstall(ship(), '/opt/crew', 'macos', true, 'release');
  assert.notEqual(runPlan.unitPaths[0], releasePlan.unitPaths[0]);
  assert.match(releasePlan.unitPaths[0]!, /com\.tablation\.crew-release\.[0-9a-f]{8}\.plist$/);
  // Two units on one machine must not share a scheduler log, or a crash in
  // one is unreadable interleaved with the other's normal output.
  assert.notEqual(runPlan.schedulerLog, releasePlan.schedulerLog);
});

test('on launchd/systemd the run unit runs `crew daemon`; the release unit runs `release --fleet`', () => {
  const runXml = Object.values(planInstall(ship(), '/opt/crew', 'macos', true, 'run').unitContent)[0]!;
  const releaseXml = Object.values(planInstall(ship(), '/opt/crew', 'macos', true, 'release').unitContent)[0]!;
  assert.match(runXml, /<string>daemon<\/string>/);
  assert.ok(!runXml.includes('--no-release'));
  assert.match(releaseXml, /<string>release<\/string>\s*<string>--fleet<\/string>/);
});

test('on cron the run job keeps the old one-shot `run --no-release` invocation — cron cannot supervise a persistent process (ISSUE-763)', () => {
  const plan = planInstall(ship({ platform: 'linux' }), '/opt/crew', 'linux', false, 'run');
  assert.match(plan.crontabLine!, /\brun --no-release\b/);
  assert.ok(!plan.crontabLine!.includes(' daemon'));
});

test('planInstall defaults to the run job — every pre-release-lane caller is unaffected', () => {
  const explicit = planInstall(ship(), '/opt/crew', 'macos', true, 'run');
  const defaulted = planInstall(ship(), '/opt/crew', 'macos', true);
  assert.deepEqual(defaulted, explicit);
});

test('on systemd, the release job gets its own service+timer pair', () => {
  const plan = planInstall(ship({ platform: 'linux' }), '/opt/crew', 'linux', true, 'release');
  assert.equal(plan.mechanism, 'systemd');
  assert.ok(plan.unitPaths.every((p) => p.includes('crew-release')));
  const service = plan.unitContent[plan.unitPaths[0]!]!;
  assert.match(service, /release --fleet/);
});

test('on cron, run and release get distinct markers, so a reinstall of one never clobbers the other\'s line', () => {
  const runPlan = planInstall(ship({ platform: 'linux' }), '/opt/crew', 'linux', false, 'run');
  const releasePlan = planInstall(ship({ platform: 'linux' }), '/opt/crew', 'linux', false, 'release');
  assert.notEqual(runPlan.cronMarker, releasePlan.cronMarker);
  assert.match(releasePlan.crontabLine!, /release --fleet/);
});

test('uninstalling the release job targets only the release unit, never run\'s', () => {
  const releaseIn = planInstall(ship(), '/opt/crew', 'macos', true, 'release');
  const releaseOut = planUninstall(ship(), '/opt/crew', 'macos', true, 'release');
  assert.deepEqual(releaseOut.unitPaths, releaseIn.unitPaths);
  const runOut = planUninstall(ship(), '/opt/crew', 'macos', true, 'run');
  assert.notDeepEqual(runOut.unitPaths, releaseOut.unitPaths);
});

test('the passengers job gets its own unit, distinct from run and release (ISSUE-677)', () => {
  const runPlan = planInstall(ship(), '/opt/crew', 'macos', true, 'run');
  const releasePlan = planInstall(ship(), '/opt/crew', 'macos', true, 'release');
  const passengersPlan = planInstall(ship(), '/opt/crew', 'macos', true, 'passengers');
  assert.notEqual(passengersPlan.unitPaths[0], runPlan.unitPaths[0]);
  assert.notEqual(passengersPlan.unitPaths[0], releasePlan.unitPaths[0]);
  assert.match(passengersPlan.unitPaths[0]!, /com\.tablation\.crew-passengers\.[0-9a-f]{8}\.plist$/);
  assert.notEqual(passengersPlan.schedulerLog, runPlan.schedulerLog);
});

test('the passengers unit runs `crew passengers`, no --no-release/--fleet flag', () => {
  const xml = Object.values(planInstall(ship(), '/opt/crew', 'macos', true, 'passengers').unitContent)[0]!;
  assert.match(xml, /<string>passengers<\/string>/);
  assert.ok(!xml.includes('<string>--no-release</string>'));
  assert.ok(!xml.includes('<string>--fleet</string>'));
});

test('on systemd, the passengers job gets its own service+timer pair', () => {
  const plan = planInstall(ship({ platform: 'linux' }), '/opt/crew', 'linux', true, 'passengers');
  assert.equal(plan.mechanism, 'systemd');
  assert.ok(plan.unitPaths.every((p) => p.includes('crew-passengers')));
  const service = plan.unitContent[plan.unitPaths[0]!]!;
  assert.match(service, /ExecStart=.*\bpassengers\b/);
});

test('uninstalling the passengers job targets only its own unit', () => {
  const passengersIn = planInstall(ship(), '/opt/crew', 'macos', true, 'passengers');
  const passengersOut = planUninstall(ship(), '/opt/crew', 'macos', true, 'passengers');
  assert.deepEqual(passengersOut.unitPaths, passengersIn.unitPaths);
  const runOut = planUninstall(ship(), '/opt/crew', 'macos', true, 'run');
  assert.notDeepEqual(runOut.unitPaths, passengersOut.unitPaths);
});

test('uninstall targets exactly what install would have written, on each mechanism', () => {
  const macIn = planInstall(ship(), '/opt/crew', 'macos', true);
  const macOut = planUninstall(ship(), '/opt/crew', 'macos', true);
  assert.deepEqual(macOut.unitPaths, macIn.unitPaths);

  const sdIn = planInstall(ship({ platform: 'linux' }), '/opt/crew', 'linux', true);
  const sdOut = planUninstall(ship({ platform: 'linux' }), '/opt/crew', 'linux', true);
  assert.deepEqual(sdOut.unitPaths, sdIn.unitPaths);

  const cronOut = planUninstall(ship({ platform: 'linux' }), '/opt/crew', 'linux', false);
  assert.equal(cronOut.unitPaths.length, 0);
  assert.ok(cronOut.crontabLine);
});

test('uninstalling the run job on systemd targets only its lone .service, and disables it directly (not a .timer) (ISSUE-763)', () => {
  const runIn = planInstall(ship({ platform: 'linux' }), '/opt/crew', 'linux', true, 'run');
  const runOut = planUninstall(ship({ platform: 'linux' }), '/opt/crew', 'linux', true, 'run');
  assert.deepEqual(runOut.unitPaths, runIn.unitPaths);
  assert.equal(runOut.unitPaths.length, 1);
  assert.deepEqual(runOut.unloadCommands, [['systemctl', '--user', 'disable', '--now', runIn.unitPaths[0]!.split('/').pop()!]]);
});

test('planDaemonControl targets the run job\'s own label/unit on every mechanism (ISSUE-763)', () => {
  const mac = planDaemonControl('/opt/crew', 'macos', true);
  assert.equal(mac.mechanism, 'launchd');
  assert.deepEqual(mac.startCommand!.slice(0, 2), ['launchctl', 'load']);
  assert.deepEqual(mac.stopCommand!.slice(0, 2), ['launchctl', 'unload']);
  assert.deepEqual(mac.statusCommand!.slice(0, 2), ['launchctl', 'list']);
  // Same unit path/label planInstall(..., 'run') itself would write.
  const runPlan = planInstall(ship(), '/opt/crew', 'macos', true, 'run');
  assert.equal(mac.startCommand![2], runPlan.unitPaths[0]);

  const sd = planDaemonControl('/opt/crew', 'linux', true);
  assert.equal(sd.mechanism, 'systemd');
  const unit = sd.startCommand![3]!;
  assert.ok(unit.endsWith('.service'));
  assert.deepEqual(sd.startCommand, ['systemctl', '--user', 'start', unit]);
  assert.deepEqual(sd.stopCommand, ['systemctl', '--user', 'stop', unit]);
  assert.deepEqual(sd.statusCommand, ['systemctl', '--user', 'status', unit]);
  const sdRunPlan = planInstall(ship({ platform: 'linux' }), '/opt/crew', 'linux', true, 'run');
  assert.equal(unit, sdRunPlan.unitPaths[0]!.split('/').pop());

  const cron = planDaemonControl('/opt/crew', 'linux', false);
  assert.equal(cron.mechanism, 'cron');
  assert.equal(cron.startCommand, null);
  assert.equal(cron.stopCommand, null);
  assert.equal(cron.statusCommand, null);
});

test('findOnPath finds an executable file down the PATH, in order', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-findonpath-'));
  const first = join(root, 'first');
  const second = join(root, 'second');
  mkdirSync(first);
  mkdirSync(second);
  // Same name in both dirs: the earlier PATH entry wins.
  writeFileSync(join(second, 'tool'), '#!/bin/sh\n');
  chmodSync(join(second, 'tool'), 0o755);
  writeFileSync(join(first, 'tool'), '#!/bin/sh\n');
  chmodSync(join(first, 'tool'), 0o755);
  assert.equal(findOnPath('tool', `${first}:${second}`), join(first, 'tool'));
  assert.equal(findOnPath('tool', `${second}:${first}`), join(second, 'tool'));
});

test('findOnPath skips a non-executable file and a directory of the same name', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-findonpath-'));
  const dir = join(root, 'bin');
  mkdirSync(dir);
  writeFileSync(join(dir, 'tool'), 'not runnable\n');
  chmodSync(join(dir, 'tool'), 0o644);
  mkdirSync(join(root, 'elsewhere', 'git'), { recursive: true });
  assert.equal(findOnPath('tool', dir), undefined);
  assert.equal(findOnPath('git', join(root, 'elsewhere')), undefined);
});

test('findOnPath checks a slash-bearing name as a path, not against PATH', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-findonpath-'));
  const bin = join(root, 'claude');
  writeFileSync(bin, '#!/bin/sh\n');
  chmodSync(bin, 0o755);
  assert.equal(findOnPath(bin, '/nonexistent'), bin);
  assert.equal(findOnPath(join(root, 'missing'), root), undefined);
});

test('dockerPathProblem names the shell directory ship.extraPath needs, and clears once it is added', (t) => {
  if (findOnPath('docker', pathFor(ship()))) return t.skip('docker is on the scheduler base PATH here');
  const root = mkdtempSync(join(tmpdir(), 'crew-docker-'));
  writeFileSync(join(root, 'docker'), '#!/bin/sh\n');
  chmodSync(join(root, 'docker'), 0o755);
  const missing = dockerPathProblem(ship(), root);
  assert.match(missing!, new RegExp(`add ${root} to ship\\.extraPath`));
  assert.equal(dockerPathProblem(ship({ extraPath: root }), root), undefined);
});

test('dockerPathProblem with docker nowhere says so rather than naming a directory', (t) => {
  if (findOnPath('docker', pathFor(ship()))) return t.skip('docker is on the scheduler base PATH here');
  assert.match(dockerPathProblem(ship(), '/nonexistent')!, /or your shell PATH; install Docker/);
});

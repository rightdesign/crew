import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planInstall, planUninstall, INTERVAL_SECONDS } from '../src/install.ts';
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
  relayPort: 2222,
  ...over,
});

test('macOS gets a launchd plist, never systemd or cron', () => {
  const plan = planInstall(ship(), '/opt/crew', 'macos', true);
  assert.equal(plan.mechanism, 'launchd');
  assert.equal(plan.unitPaths.length, 1);
  assert.match(plan.unitPaths[0]!, /Library\/LaunchAgents\/com\.tablation\.crew\.[0-9a-f]{8}\.plist$/);
  assert.equal(plan.crontabLine, null);
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

  const sdA = planInstall(ship({ platform: 'linux' }), '/opt/crew-a', 'linux', true);
  const sdB = planInstall(ship({ platform: 'linux' }), '/opt/crew-b', 'linux', true);
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

test('the plist does not fire at load', () => {
  const plan = planInstall(ship(), '/opt/crew', 'macos', true);
  const xml = Object.values(plan.unitContent)[0]!;
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(xml, new RegExp(`<key>StartInterval</key>\\s*<integer>${INTERVAL_SECONDS}</integer>`));
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

test('linux with systemd gets a user service+timer, not cron', () => {
  const plan = planInstall(ship({ platform: 'linux' }), '/opt/crew', 'linux', true);
  assert.equal(plan.mechanism, 'systemd');
  assert.equal(plan.unitPaths.length, 2);
  assert.ok(plan.unitPaths.every((p) => p.includes('.config/systemd/user/')));
  assert.equal(plan.crontabLine, null);
});

test('the systemd timer does not fire at load either', () => {
  const plan = planInstall(ship({ platform: 'linux' }), '/opt/crew', 'linux', true);
  const timer = plan.unitContent[plan.unitPaths[1]!]!;
  assert.ok(!timer.includes('OnBootSec'));
  assert.ok(!/Persistent\s*=\s*true/i.test(timer));
  assert.match(timer, new RegExp(`OnActiveSec=${INTERVAL_SECONDS}`));
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

test('the run unit passes itself --no-release; the release unit runs `release --fleet`', () => {
  const runXml = Object.values(planInstall(ship(), '/opt/crew', 'macos', true, 'run').unitContent)[0]!;
  const releaseXml = Object.values(planInstall(ship(), '/opt/crew', 'macos', true, 'release').unitContent)[0]!;
  assert.match(runXml, /<string>run<\/string>\s*<string>--no-release<\/string>/);
  assert.match(releaseXml, /<string>release<\/string>\s*<string>--fleet<\/string>/);
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  labelFor, planUninstall, applyUninstall, programFromPlist, listLaunchdUnits, foreignLaunchdUnits,
  clearForeignLaunchdUnits, parseLaunchctlList,
} from '../src/install.ts';
import type { InstallLog } from '../src/install.ts';

// CREW-1376: a crew moved to a new path writes a second set of launchd units
// (labelFor hashes the checkout path), and the old set stays loaded. These
// tests drive that with a fake LaunchAgents dir. Nothing here spawns
// launchctl: every apply path that would is run with dryRun = true.

const recorder = (): InstallLog & { lines: string[]; warnings: string[] } => {
  const lines: string[] = [];
  const warnings: string[] = [];
  return {
    lines,
    warnings,
    emit: (m: string) => { lines.push(m); },
    warn: (m: string) => { warnings.push(m); },
  };
};

// The shape `planLaunchd` writes: a node checkout runs `<node> <home>/bin/crew daemon`.
const plistFor = (label: string, args: string[]): string => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    ${args.map((a) => `<string>${a}</string>`).join('\n    ')}
  </array>
</dict>
</plist>
`;

function setup(): { home: string; agents: string; program: string } {
  const root = mkdtempSync(join(tmpdir(), 'crew-launchd-'));
  const home = join(root, 'checkout');
  mkdirSync(join(home, 'bin'), { recursive: true });
  const agents = join(root, 'LaunchAgents');
  mkdirSync(agents);
  const program = join(home, 'bin', 'crew');
  writeFileSync(program, '');
  return { home, agents, program };
}

test('programFromPlist reads the checkout\'s bin/crew argument, not the node interpreter in front of it', () => {
  const text = plistFor('com.tablation.crew.abcd1234', ['/usr/local/bin/node', '/opt/crew/bin/crew', 'daemon']);
  assert.equal(programFromPlist(text), '/opt/crew/bin/crew');
});

test('programFromPlist takes argv[0] for a compiled crew binary, and unescapes XML entities', () => {
  const text = plistFor('com.tablation.crew.abcd1234', ['/opt/crew &amp; co/crew', 'daemon']);
  assert.equal(programFromPlist(text), '/opt/crew & co/crew');
});

test('programFromPlist returns null for a plist with no ProgramArguments', () => {
  assert.equal(programFromPlist('<plist><dict></dict></plist>'), null);
});

test('listLaunchdUnits sees only com.tablation.crew* plists, and marks a unit whose program is gone', () => {
  const { home, agents, program } = setup();
  const live = labelFor(home, 'run');
  const gone = 'com.tablation.crew-passengers.9bcaaea6';
  writeFileSync(join(agents, `${live}.plist`), plistFor(live, [process.execPath, program, 'daemon']));
  writeFileSync(join(agents, `${gone}.plist`), plistFor(gone, [process.execPath, '/old/checkout/bin/crew', 'passengers']));
  writeFileSync(join(agents, 'com.apple.something.plist'), plistFor('com.apple.something', ['/bin/ls']));

  const units = listLaunchdUnits(agents);
  assert.deepEqual(units.map((u) => u.label), [gone, live].sort());
  assert.equal(units.find((u) => u.label === live)!.programExists, true);
  assert.equal(units.find((u) => u.label === gone)!.programExists, false);
});

test('foreignLaunchdUnits excludes this checkout\'s own run, release and passengers labels', () => {
  const { home, agents, program } = setup();
  const own = ['run', 'release', 'passengers'] as const;
  for (const job of own) {
    const label = labelFor(home, job);
    writeFileSync(join(agents, `${label}.plist`), plistFor(label, [process.execPath, program, job]));
  }
  const other = 'com.tablation.crew.00000000';
  writeFileSync(join(agents, `${other}.plist`), plistFor(other, [process.execPath, '/elsewhere/bin/crew', 'daemon']));

  assert.deepEqual(foreignLaunchdUnits(home, agents).map((u) => u.label), [other]);
});

test('install removes a stale foreign unit whose program is gone, without asking', () => {
  const { home, agents } = setup();
  const stale = 'com.tablation.crew-passengers.9bcaaea6';
  writeFileSync(join(agents, `${stale}.plist`), plistFor(stale, [process.execPath, '/gone/bin/crew', 'passengers']));

  const log = recorder();
  assert.equal(clearForeignLaunchdUnits(home, false, true, log, agents), true);
  assert.ok(log.lines.some((l) => l.includes('removing a stale unit') && l.includes(stale)));
  assert.deepEqual(log.warnings, []);
});

test('install refuses, before writing anything, when a foreign unit still points at a live other checkout', () => {
  const { home, agents, program } = setup();
  const live = 'com.tablation.crew.00000000';
  writeFileSync(join(agents, `${live}.plist`), plistFor(live, [process.execPath, program, 'daemon']));

  const log = recorder();
  assert.equal(clearForeignLaunchdUnits(home, false, false, log, agents), false);
  assert.equal(log.warnings.length, 1);
  assert.match(log.warnings[0]!, /two crew installs target this machine/);
  assert.match(log.warnings[0]!, /crew uninstall/);
  assert.match(log.warnings[0]!, /--replace/);
  assert.deepEqual(log.lines, []);
});

test('--replace removes a live other checkout\'s unit too', () => {
  const { home, agents, program } = setup();
  const live = 'com.tablation.crew.00000000';
  writeFileSync(join(agents, `${live}.plist`), plistFor(live, [process.execPath, program, 'daemon']));

  const log = recorder();
  assert.equal(clearForeignLaunchdUnits(home, true, true, log, agents), true);
  assert.ok(log.lines.some((l) => l.includes('replacing a live other install') && l.includes(live)));
});

test('install refuses a foreign unit with no readable ProgramArguments, and removes nothing (its owner is unknown, not gone)', () => {
  const { home, agents } = setup();
  const unknown = 'com.tablation.crew.00000000';
  writeFileSync(join(agents, `${unknown}.plist`), '<plist><dict></dict></plist>');

  const log = recorder();
  assert.equal(clearForeignLaunchdUnits(home, false, false, log, agents), false);
  assert.match(log.warnings[0]!, /two crew installs target this machine/);
  assert.match(log.warnings[0]!, new RegExp(`${unknown} runs an unreadable ProgramArguments`));
  assert.deepEqual(log.lines, []);
  assert.ok(listLaunchdUnits(agents).some((u) => u.label === unknown), 'plist must still be on disk');
});

test('--replace removes a foreign unit with no readable ProgramArguments', () => {
  const { home, agents } = setup();
  const unknown = 'com.tablation.crew.00000000';
  writeFileSync(join(agents, `${unknown}.plist`), '<plist><dict></dict></plist>');

  const log = recorder();
  assert.equal(clearForeignLaunchdUnits(home, true, true, log, agents), true);
  assert.ok(log.lines.some((l) => l.includes('no readable ProgramArguments') && l.includes(unknown)));
});

test('a plain dry-run install with no foreign units is a no-op that still succeeds', () => {
  const { home, agents } = setup();
  const log = recorder();
  assert.equal(clearForeignLaunchdUnits(home, false, true, log, agents), true);
  assert.deepEqual(log.lines, []);
});

test('uninstall (launchd) falls back to `launchctl remove <label>`, so a job whose plist is already gone still comes off', () => {
  const plan = planUninstall({ name: 'x' } as never, '/opt/crew', 'macos', false, 'run');
  assert.equal(plan.removeLabel, labelFor('/opt/crew', 'run'));
});

test('uninstall on systemd and cron has no launchctl remove fallback', () => {
  assert.equal(planUninstall({ name: 'x' } as never, '/opt/crew', 'linux', true, 'run').removeLabel, undefined);
  assert.equal(planUninstall({ name: 'x' } as never, '/opt/crew', 'linux', false, 'run').removeLabel, undefined);
});

test('applyUninstall dry-run names the launchctl remove fallback it would run', () => {
  const plan = planUninstall({ name: 'x' } as never, '/opt/crew', 'macos', false, 'release');
  const log = recorder();
  void applyUninstall(plan, '/opt/crew', true, log);
  assert.ok(log.lines.includes(`would run: launchctl remove ${labelFor('/opt/crew', 'release')}`));
});

test('parseLaunchctlList reads PID, last exit and label per row, and skips the header', () => {
  const text = 'PID\tStatus\tLabel\n-\t78\tcom.tablation.crew-passengers.9bcaaea6\n4321\t0\tcom.tablation.crew.8b10e9df\n';
  const jobs = parseLaunchctlList(text);
  assert.deepEqual(jobs.get('com.tablation.crew-passengers.9bcaaea6'), { pid: '-', lastExit: '78' });
  assert.deepEqual(jobs.get('com.tablation.crew.8b10e9df'), { pid: '4321', lastExit: '0' });
  assert.equal(jobs.has('Label'), false);
});

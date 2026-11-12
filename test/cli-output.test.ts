import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeOutcomes, withFix } from '../src/cli-output.ts';

const rows = [{ n: 'a', ok: true }, { n: 'b', ok: false }, { n: 'c', ok: true }];
const describe = (r: { n: string }) => `${r.n}: line`;

test('summarizeOutcomes collapses routine outcomes into one count', () => {
  assert.deepEqual(summarizeOutcomes(rows, describe, (r) => r.ok, 'skill', false), ['b: line', '2 skills already in sync']);
  assert.deepEqual(summarizeOutcomes(rows.slice(0, 1), describe, (r) => r.ok, 'skill', false), ['1 skill already in sync']);
});

test('summarizeOutcomes lists every outcome under verbose', () => {
  assert.deepEqual(summarizeOutcomes(rows, describe, (r) => r.ok, 'skill', true), ['a: line', 'b: line', 'c: line']);
});

test('withFix appends the next command', () => {
  assert.equal(withFix('crew agents sync: boom.', '`crew doctor`'), 'crew agents sync: boom — try: `crew doctor`');
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeJobs, type JobResult } from '../src/cli-output.ts';
import { applyInstall, applyUninstall, type InstallPlan, type UninstallPlan } from '../src/install.ts';

const job = (name: string, action: JobResult['action']): JobResult => ({ job: name, mechanism: 'launchd', action });
const base = { dryRun: false, verbose: false, host: 'macos' };

test('summarizeJobs prints a single line when every job is unchanged', () => {
  const lines = summarizeJobs([job('run', 'unchanged'), job('release', 'unchanged'), job('passengers', 'unchanged')], base);
  assert.deepEqual(lines, ['all 3 jobs already installed (run, release, passengers)']);
});

test('summarizeJobs lists changed jobs and collapses the rest', () => {
  const lines = summarizeJobs([job('run', 'replaced'), job('release', 'installed'), job('passengers', 'unchanged')], base);
  assert.deepEqual(lines, [
    'replaced run via launchd for macos',
    'installed release via launchd for macos',
    '1 job already installed (passengers)',
  ]);
});

test('summarizeJobs lists every job under verbose and marks a dry run as not applied', () => {
  const rs = [job('run', 'unchanged'), job('release', 'installed')];
  assert.deepEqual(summarizeJobs(rs, { ...base, verbose: true }), ['run already installed (launchd)', 'installed release via launchd for macos']);
  assert.deepEqual(summarizeJobs(rs, { ...base, dryRun: true }), [
    'would install run via launchd for macos (dry run, not applied)',
    'would install release via launchd for macos (dry run, not applied)',
  ]);
});

test('summarizeJobs words an uninstall', () => {
  assert.deepEqual(summarizeJobs([job('run', 'unchanged'), job('release', 'unchanged')], { ...base, uninstall: true }), ['all 2 jobs already not installed (run, release)']);
  assert.deepEqual(summarizeJobs([job('run', 'removed')], { ...base, uninstall: true }), ['removed run via launchd for macos']);
});

function planIn(dir: string, loadCommands: string[][]): InstallPlan {
  const path = join(dir, 'unit.plist');
  return {
    mechanism: 'launchd', unitPaths: [path], unitContent: { [path]: 'unit-v1' }, crontabLine: null, preLoadCommands: [], loadCommands,
    crewLog: '/tmp/crew.log', schedulerLog: '/tmp/sched.log', cronMarker: null, lingerCommand: null, lingerHint: null,
  } as unknown as InstallPlan;
}
const quiet = { emit: () => undefined, warn: () => undefined };

test('applyInstall reports installed, unchanged and replaced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-3284-'));
  const plan = planIn(dir, []);
  assert.equal((await applyInstall(plan, dir, false, quiet)).action, 'installed');
  assert.equal((await applyInstall(plan, dir, false, quiet)).action, 'unchanged');
  writeFileSync(plan.unitPaths[0]!, 'older');
  assert.equal((await applyInstall(plan, dir, false, quiet)).action, 'replaced');
});

test('applyInstall throws when loading the unit fails, after warning once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-3284-'));
  const warned: string[] = [];
  await assert.rejects(applyInstall(planIn(dir, [['false']]), dir, false, { emit: () => undefined, warn: (m) => warned.push(m) }), /loading the unit failed/);
  assert.equal(warned.length, 1);
});

test('applyUninstall reports whether it removed anything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-3284-'));
  const plan = planIn(dir, []);
  await applyInstall(plan, dir, false, quiet);
  const un = { mechanism: 'launchd', unitPaths: plan.unitPaths, unloadCommands: [], removeLabel: null, crontabLine: null } as unknown as UninstallPlan;
  assert.equal((await applyUninstall(un, dir, false, quiet)).changed, true);
  assert.equal((await applyUninstall(un, dir, false, quiet)).changed, false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseRepoConfig, RepoConfigError, NewerContractError, newerContractSummary } from '../src/repo-config.ts';
import { renderRepoCheck } from '../src/repos-check.ts';
import { resolveRepoConfig } from '../src/repo-config.ts';
import { raiseShipAttention, clearShipAttention, repoContractNewerItem, repoContractRefusedItem } from '../src/ship-attention.ts';
import { State } from '../src/state.ts';
import { Emitter, eventFileFor } from '../src/events.ts';

const file = '/r/.crew.yaml';
const contract = (extra: { min?: string; release?: string; top?: string; verify?: string }) => [
  'version: 1',
  ...(extra.min ? [`minCrewVersion: ${extra.min}`] : []),
  ...(extra.top ? [extra.top] : []),
  'release:', '  mode: integrate', ...(extra.release ? [`  ${extra.release}`] : []),
  ...(extra.verify ? ['  verify:', `    ${extra.verify}`] : []),
].join('\n');

test('a newer contract with one ignorable unknown release key is served, the key ignored and named', () => {
  const cfg = parseRepoConfig(contract({ min: '0.200.0', release: 'futureKey: true' }), file, { crewVersion: '0.167.0' });
  assert.deepEqual(cfg.newerContract, { required: '0.200.0', running: '0.167.0', keys: ['release.futureKey'] });
  assert.equal(cfg.release.mode, 'integrate');
  assert.match(newerContractSummary(cfg.newerContract!), /crew 0\.200\.0.*crew 0\.167\.0.*release\.futureKey.*Upgrading crew clears this/);
});

test('the same contract on a crew that meets the minimum and knows the key: no note', () => {
  const cfg = parseRepoConfig(contract({ min: '0.167.0', release: 'rebuildPrimary: true' }), file, { crewVersion: '0.167.0' });
  assert.equal(cfg.newerContract, undefined);
  assert.equal(cfg.release.rebuildPrimary, true);
});

test('a crew that meets the minimum still refuses an unknown key as a typo', () => {
  assert.throws(
    () => parseRepoConfig(contract({ min: '0.100.0', release: 'futureKey: true' }), file, { crewVersion: '0.167.0' }),
    (e: Error) => e instanceof RepoConfigError && !(e instanceof NewerContractError) && /unknown release key: futureKey \(allowed:/.test(e.message),
  );
});

test('an unknown key with no minimum declared is refused with today\'s message', () => {
  assert.throws(
    () => parseRepoConfig(contract({ release: 'futureKey: true' }), file, { crewVersion: '0.167.0' }),
    (e: Error) => !(e instanceof NewerContractError) && e instanceof RepoConfigError && /^\/r\/\.crew\.yaml: unknown release key: futureKey \(allowed: .*\)$/.test(e.message),
  );
});

test('an unknown key in a group that cannot be ignored is refused with the newer-crew message', () => {
  for (const c of [contract({ min: '0.200.0', verify: 'futureGate: 1' }), contract({ min: '0.200.0', top: 'gates: {}' })]) {
    assert.throws(
      () => parseRepoConfig(c, file, { crewVersion: '0.167.0' }),
      (e: Error) => e instanceof NewerContractError && /needs a newer crew \(0\.200\.0 or later\)/.test(e.message) && !/invalid|resumes/i.test(e.message),
    );
  }
});

test('minCrewVersion must be a version', () => {
  assert.throws(() => parseRepoConfig(contract({ min: 'soon' }), file, { crewVersion: '0.167.0' }), /minCrewVersion must be a version/);
});

test('crew doctor renders the newer-contract case in the same words', () => {
  const parsed = parseRepoConfig(contract({ min: '0.200.0', release: 'futureKey: true' }), file, { crewVersion: '0.167.0' });
  const effective = resolveRepoConfig(parsed, undefined, '/r');
  const out = renderRepoCheck({ file, parsed, effective, readiness: [], hooks: [], shadowed: [], mapFile: null, samples: [], error: null, exitCode: 0 });
  assert.ok(out.includes(newerContractSummary(parsed.newerContract!)));
});

test('a refused newer contract tells the operator to upgrade, not that it resumes by itself', () => {
  let msg: string = '';
  try { parseRepoConfig(contract({ min: '0.200.0', verify: 'futureGate: 1' }), file, { crewVersion: '0.167.0' }); } catch (e) { msg = (e as Error).message; }
  const item = repoContractRefusedItem('crew', msg);
  assert.match(item.message, /older than its repo contract needs/);
  assert.match(item.message, /Upgrade crew to resume/);
  assert.doesNotMatch(item.message, /Resumes automatically/);
});

test('the newer-contract attention item is announced once, then cleared', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-newer-'));
  const state = new State(dir);
  const emit = new Emitter({ route: 'r', eventFile: eventFileFor(dir), console: () => {} });
  const note = { required: '0.200.0', running: '0.167.0', keys: ['release.futureKey'] };
  assert.equal(await raiseShipAttention({ state, emit }, repoContractNewerItem('crew', note)), true);
  assert.equal(await raiseShipAttention({ state, emit }, repoContractNewerItem('crew', note)), false);
  assert.equal(readFileSync(eventFileFor(dir), 'utf8').trim().split('\n').length, 1);
  clearShipAttention(state, 'repo_contract_newer:crew');
  assert.deepEqual(state.shipAttention().previous(), []);
});

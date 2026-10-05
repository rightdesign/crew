import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveExtraPath, findOnPath, nextSteps, renderFullConfig, renderShipBlock, runWizard, shouldRunWizard,
  writeNewConfig, HOST_PASSENGERS_DOCS_URL, type Prompter, type WizardEnv,
} from '../src/connect-wizard.ts';
import { loadConfig } from '../src/config.ts';
import { renderConnection, type Discovered } from '../src/connect.ts';

/** Scripted prompter: answers are consumed in order, and every said/asked line is kept. */
function script(answers: Array<string | boolean>) {
  const said: string[] = [];
  const asked: string[] = [];
  const p: Prompter = {
    say: (l) => { said.push(l); },
    ask: async (q, fallback) => { asked.push(q); const a = answers.shift(); return (typeof a === 'string' && a) || fallback || ''; },
    confirm: async (q, fallback) => { asked.push(q); const a = answers.shift(); return typeof a === 'boolean' ? a : fallback; },
  };
  return { p, said, asked };
}

const env = (over: Partial<WizardEnv> = {}): WizardEnv => ({
  hostname: 'brads-box', platform: 'macos', pathEnv: '/opt/bin:/usr/bin', nodePath: '/opt/node/bin/node',
  dockerAvailable: true, isExecutable: (p) => ['/opt/bin/claude', '/opt/bin/pnpm', '/elsewhere/claude'].includes(p),
  ...over,
});

test('shouldRunWizard: only on a TTY with no config at any search location', () => {
  assert.equal(shouldRunWizard({ isTTY: true, crewHome: '/c', configExists: () => false }), true);
  assert.equal(shouldRunWizard({ isTTY: false, crewHome: '/c', configExists: () => false }), false);
  assert.equal(shouldRunWizard({ isTTY: true, crewHome: '/c', configExists: () => true }), false);
});

test('findOnPath returns the first executable match, and undefined when none', () => {
  assert.equal(findOnPath('claude', '/a:/opt/bin', (p) => p === '/opt/bin/claude'), '/opt/bin/claude');
  assert.equal(findOnPath('claude', '/a:/b', () => false), undefined);
});

test('deriveExtraPath dedupes and drops directories a scheduler already has', () => {
  assert.equal(deriveExtraPath(['/opt/node/bin', '/opt/node/bin', '/usr/bin', undefined]), '/opt/node/bin');
  assert.equal(deriveExtraPath(['/usr/bin']), undefined);
});

test('wizard accepts every default: hostname, the claude on PATH, node/pnpm dirs, Host Passengers off', async () => {
  const { p } = script([]);
  const a = await runWizard(p, env());
  assert.deepEqual(a, {
    name: 'brads-box', platform: 'macos', agentBin: '/opt/bin/claude',
    extraPath: '/opt/node/bin:/opt/bin', hostPassengers: false,
  });
});

test('wizard: a rejected claude path falls through to asking, and re-asks until it is executable', async () => {
  const { p, said } = script(['my-ship', false, '/nope', '/elsewhere/claude', true]);
  const a = await runWizard(p, env());
  assert.equal(a.name, 'my-ship');
  assert.equal(a.agentBin, '/elsewhere/claude');
  assert.equal(a.hostPassengers, true);
  assert.ok(said.some((l) => l.includes('/nope is not an executable')));
});

test('wizard: no claude on PATH is said plainly and asked for', async () => {
  const { p, said } = script(['', '/elsewhere/claude']);
  const a = await runWizard(p, env({ pathEnv: '/usr/bin' }));
  assert.equal(a.agentBin, '/elsewhere/claude');
  assert.ok(said.some((l) => l.includes('Could not find "claude"')));
});

test('wizard: Host Passengers yes without Docker warns but still records the answer, and links the docs', async () => {
  const { p, said } = script(['', true, true]);
  const a = await runWizard(p, env({ dockerAvailable: false }));
  assert.equal(a.hostPassengers, true);
  assert.ok(said.some((l) => l.includes('Docker is not available')));
  assert.ok(said.some((l) => l.includes(HOST_PASSENGERS_DOCS_URL)));
});

test('the written file loads back: ship answers and a route with real baseUrl, hostPassengers and enabled: false', () => {
  const answers = { name: 'brads-box', platform: 'macos' as const, agentBin: '/opt/bin/claude', extraPath: '/opt/node/bin', hostPassengers: true };
  const d: Discovered = {
    workspaceId: 'w', workspaceSlug: 'issues', models: {}, seats: {}, holds: [], problems: [], provisioning: [],
  };
  const block = renderConnection(d, 'issues/issues', '~/Crew/issues', {
    keychainBacked: true, baseUrl: 'https://app.tablation.com', hostPassengers: true,
  });
  const dir = mkdtempSync(join(tmpdir(), 'crew-wizard-'));
  const file = join(dir, 'crew.yaml');
  assert.equal(writeNewConfig(file, renderFullConfig(answers, block)), true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const cfg = loadConfig(dir, file);
  assert.equal(cfg.ship.name, 'brads-box');
  assert.equal(cfg.ship.agent.bin, '/opt/bin/claude');
  assert.equal(cfg.ship.extraPath, '/opt/node/bin');
  assert.equal(cfg.routes.length, 1);
  assert.equal(cfg.routes[0]!.route, 'issues/issues');
  assert.equal(cfg.routes[0]!.enabled, false);
  assert.equal(cfg.routes[0]!.hostPassengers, true);
  assert.equal(cfg.routes[0]!.baseUrl, 'https://app.tablation.com');
});

test('the ship-only block loads with allowNoRoutes — and is refused without it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-wizard-'));
  const text = renderShipBlock({ name: 'x', platform: 'linux', agentBin: '/bin/claude', hostPassengers: false });
  const cfg = loadConfig(dir, join(dir, 'crew.yaml'), { text, allowNoRoutes: true });
  assert.equal(cfg.routes.length, 0);
  assert.throws(() => loadConfig(dir, join(dir, 'crew.yaml'), { text }), /routes/);
});

test('writeNewConfig never overwrites an existing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-wizard-'));
  const file = join(dir, 'crew.yaml');
  writeFileSync(file, 'hand-maintained');
  assert.equal(writeNewConfig(file, 'new'), false);
  assert.equal(readFileSync(file, 'utf8'), 'hand-maintained');
});

test('nextSteps: repos hint only when needed, says nothing runs yet, flags Windows', () => {
  const t = nextSteps({ route: 'issues/issues', configPath: '/c/crew.yaml', platform: 'macos', needsRepos: true });
  assert.match(t, /crew repos add issues\/issues/);
  assert.match(t, /crew doctor issues\/issues/);
  assert.match(t, /enabled: false/);
  assert.match(t, /crew install/);
  assert.doesNotMatch(t, /Windows/);
  assert.doesNotMatch(nextSteps({ route: 'a/b', configPath: '/c', platform: 'linux', needsRepos: false }), /repos add/);
  assert.match(nextSteps({ route: 'a/b', configPath: '/c', platform: 'windows', needsRepos: false }), /Windows has no scheduler/);
});

test('wizard: Host Passengers yes puts the directory docker lives in on extraPath', async () => {
  const { p } = script(['', true, true]);
  const a = await runWizard(p, env({
    pathEnv: '/opt/bin:/usr/local/bin:/usr/bin',
    isExecutable: (x) => ['/opt/bin/claude', '/opt/bin/pnpm', '/usr/local/bin/docker'].includes(x),
  }));
  assert.equal(a.extraPath, '/opt/node/bin:/opt/bin:/usr/local/bin');
});

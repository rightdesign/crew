import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, ConfigError } from '../src/config.ts';
import { planAgentRun, describePlan } from '../src/agent.ts';
import { profileFor } from '../src/capability.ts';
import { claudeToolsFor } from '../src/adapters/claude.ts';
import { resolveToolchain, shipToolchains, adapterFor } from '../src/toolchain.ts';

function cfgFrom(yaml: string) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-tc-'));
  const file = join(dir, 'crew.yaml');
  writeFileSync(file, yaml);
  return loadConfig(dir, file);
}

const ROUTE = (extra = '') => `
  - route: issues/dev-crew
    dir: /tmp/proj
    baseUrl: https://example.test/
${extra}`;

function plan(cfg: ReturnType<typeof cfgFrom>, routeIdx = 0) {
  const home = mkdtempSync(join(tmpdir(), 'crew-home-'));
  const personas = join(home, 'personas');
  mkdirSync(personas, { recursive: true });
  writeFileSync(join(personas, 'common.md'), 'C\n');
  writeFileSync(join(personas, 'lane-dev.md'), 'D\n');
  const route = { ...cfg.routes[routeIdx]!, promptsDir: home };
  return planAgentRun({
    role: 'dev', route, ship: cfg.ship, stateDir: mkdtempSync(join(tmpdir(), 'crew-st-')),
    roster: 'R', environment: 'E', cycle: 'c1',
  });
}

test('profiles: triage reads, QA writes, dev/pair edit, only design gets design tools', () => {
  assert.deepEqual(profileFor('triage'), { level: 'read', designTools: false });
  assert.deepEqual(profileFor('qa'), { level: 'write', designTools: false });
  assert.deepEqual(profileFor('dev'), { level: 'edit', designTools: false });
  assert.deepEqual(profileFor('pair'), { level: 'edit', designTools: false });
  assert.deepEqual(profileFor('design'), { level: 'edit', designTools: true });
});

test('the Claude adapter maps profiles back onto the exact pre-toolchain tool lists', () => {
  const t = 'mcp__tablation__*';
  assert.deepEqual(claudeToolsFor(profileFor('triage')), ['Bash', 'Read', t]);
  assert.deepEqual(claudeToolsFor(profileFor('qa')), ['Bash', 'Read', 'Write', 'Grep', 'Glob', t]);
  assert.deepEqual(claudeToolsFor(profileFor('dev')), ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', t]);
  assert.deepEqual(claudeToolsFor(profileFor('design')), ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', t, 'Skill', 'Artifact']);
});

test('a legacy agent: block defines the implicit claude toolchain and behaves as before', () => {
  const cfg = cfgFrom(`ship:\n  agent: { bin: /bin/true, model: m-1 }\nroutes:${ROUTE()}`);
  assert.equal(cfg.ship.toolchains, undefined);
  assert.deepEqual(shipToolchains(cfg.ship).map((t) => t.name), ['claude']);
  const p = plan(cfg);
  assert.equal(p.bin, '/bin/true');
  assert.equal(p.toolchain, 'claude');
  assert.ok(p.args.includes('m-1'));
  assert.ok(!describePlan(p).includes('toolchain:'), 'a plain Claude run prints exactly what it did before');
});

test('two toolchains and a route override pick the right one per route', () => {
  const cfg = cfgFrom(`
ship:
  agent: { bin: /bin/true }
  toolchain: fast
  toolchains:
    fast:
      harness: claude
      bin: /opt/fast-claude
      model: m-fast
      args: [--extra]
      env: { FOO: bar }
    wrapped:
      harness: claude
      bin: claude
      launcher: /opt/launch
routes:${ROUTE()}${ROUTE('    toolchain: wrapped\n').replace('dev-crew', 'other')}`);
  const a = plan(cfg, 0);
  assert.equal(a.toolchain, 'fast');
  assert.equal(a.bin, '/opt/fast-claude');
  assert.equal(a.args.at(-1), '--extra');
  assert.equal(a.setEnv.FOO, 'bar');
  assert.match(describePlan(a), /toolchain: fast \(claude\)/);
  const b = plan(cfg, 1);
  assert.equal(b.toolchain, 'wrapped');
  assert.equal(b.bin, '/opt/launch');
  assert.equal(b.args[0], 'claude');
});

test('an explicit claude entry replaces the legacy implicit one; tiers default per harness', () => {
  const cfg = cfgFrom(`
ship:
  toolchains:
    claude: { harness: claude, bin: /opt/c, tiers: { deep: { model: big, reasoning: high } } }
routes:${ROUTE()}`);
  const tc = resolveToolchain(cfg.ship);
  assert.equal(tc.bin, '/opt/c');
  assert.equal(tc.tiers.deep?.model, 'big');
  assert.equal(tc.tiers.deep?.reasoning, 'high');
  assert.equal(tc.tiers.light?.model, adapterFor('claude').defaultTiers.light?.model);
});

test('unknown toolchain names, harnesses and tiers fail at load time', () => {
  assert.throws(() => cfgFrom(`ship:\n  toolchain: nope\nroutes:${ROUTE()}`), (e) => e instanceof ConfigError && /ship\.toolchain "nope"/.test(e.message));
  assert.throws(() => cfgFrom(`ship:\n  toolchains:\n    x: { harness: gemini }\nroutes:${ROUTE()}`), /ship\.toolchains\.x\.harness/);
  assert.throws(() => cfgFrom(`ship:\n  toolchains:\n    x: { harness: claude, tiers: { huge: { model: m } } }\nroutes:${ROUTE()}`), /not a tier/);
  assert.throws(() => cfgFrom(`ship:\n  toolchains:\n    x: { harness: claude, color: red }\nroutes:${ROUTE()}`), /color/);
  // A bad route override drops that route (with a warning) instead of the whole ship.
  assert.throws(() => cfgFrom(`ship:\n  agent: { bin: /bin/true }\nroutes:${ROUTE('    toolchain: nope\n')}`), /toolchain "nope"/);
  const cfg = cfgFrom(`ship:\n  agent: { bin: /bin/true }\nroutes:${ROUTE()}${ROUTE('    toolchain: nope\n').replace('dev-crew', 'bad')}`);
  assert.equal(cfg.routes.length, 1);
  assert.match(cfg.warnings.join('\n'), /bad/);
});

test('every adapter declares capability limitations for doctor to print', () => {
  assert.ok(adapterFor('claude').limitations.length > 0);
});

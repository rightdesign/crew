import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, ConfigError } from '../src/config.ts';
import { planAgentRun, describePlan } from '../src/agent.ts';
import { profileFor } from '../src/capability.ts';
import { claudeToolsFor } from '../src/adapters/claude.ts';
import { resolveToolchain, shipToolchains, adapterFor, resolveSeat, toolchainVendor } from '../src/toolchain.ts';

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

// CREW-1515: seat resolution — persona vendor / tier / model pick the toolchain and model.

const TWO = `ship:
  agent: { bin: /bin/true, model: claude-sonnet-5 }
  toolchains:
    routed:
      harness: claude
      bin: /bin/true
      launcher: /opt/bin/ori
      model: anthropic/claude-sonnet-5-5
      tiers:
        deep: { model: openai/gpt-5, reasoning: '9000' }
routes:${ROUTE()}`;

test('toolchainVendor: native vendor, or openrouter behind the ori launcher', () => {
  const cfg = cfgFrom(TWO);
  const [legacy, routed] = shipToolchains(cfg.ship);
  assert.equal(toolchainVendor(legacy!), 'anthropic');
  assert.equal(toolchainVendor(routed!), 'openrouter');
});

test('resolveSeat: no persona choice runs the default exactly as before', () => {
  const cfg = cfgFrom(`ship:\n  agent: { bin: /bin/true, model: m-1, maxThinkingTokens: 777 }\nroutes:${ROUTE()}`);
  for (const persona of [{}, { tier: 'standard' as const }]) {
    const r = resolveSeat(cfg.ship, cfg.routes[0], 'dev', persona);
    assert.equal(r.toolchain.name, 'claude');
    assert.equal(r.model, 'm-1');
    assert.equal(r.toolchain.maxThinkingTokens, 777);
    assert.deepEqual(r.warnings, []);
  }
});

test('resolveSeat: a persona vendor the default serves keeps the default', () => {
  const cfg = cfgFrom(TWO);
  const r = resolveSeat(cfg.ship, cfg.routes[0], 'dev', { vendor: 'anthropic' });
  assert.equal(r.toolchain.name, 'claude');
  assert.deepEqual(r.warnings, []);
});

test('resolveSeat: a persona vendor matching a non-default entry selects it', () => {
  const cfg = cfgFrom(TWO);
  const r = resolveSeat(cfg.ship, cfg.routes[0], 'dev', { vendor: 'openrouter' });
  assert.equal(r.toolchain.name, 'routed');
  assert.equal(r.model, 'anthropic/claude-sonnet-5-5');
  assert.match(r.toolchainWhy, /persona vendor openrouter/);
  assert.deepEqual(r.warnings, []);
});

test('resolveSeat: a vendor nothing serves runs the default with a warning naming seat, vendor and toolchain', () => {
  const cfg = cfgFrom(TWO);
  const r = resolveSeat(cfg.ship, cfg.routes[0], 'qa', { vendor: 'openai' });
  assert.equal(r.toolchain.name, 'claude');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /qa/);
  assert.match(r.warnings[0]!, /openai/);
  assert.match(r.warnings[0]!, /claude/);
});

test('resolveSeat: an explicit model of the toolchain\'s vendor wins over the tier', () => {
  const cfg = cfgFrom(TWO);
  const r = resolveSeat(cfg.ship, cfg.routes[0], 'dev', { model: 'claude-opus-5-5', tier: 'light' });
  assert.equal(r.model, 'claude-opus-5-5');
  assert.equal(r.modelWhy, 'persona model');
  assert.deepEqual(r.warnings, []);
});

test('resolveSeat: an explicit model of another vendor is ignored with a warning, never passed through', () => {
  const cfg = cfgFrom(TWO);
  const r = resolveSeat(cfg.ship, cfg.routes[0], 'dev', { model: 'gpt-5' });
  assert.equal(r.model, 'claude-sonnet-5');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /gpt-5/);
});

test('resolveSeat: tiers map through the toolchain, bringing the reasoning knob (Claude thinking budget)', () => {
  const cfg = cfgFrom(`ship:\n  agent: { bin: /bin/true, model: m-1, maxThinkingTokens: 777 }\nroutes:${ROUTE()}`);
  const light = resolveSeat(cfg.ship, cfg.routes[0], 'triage', { tier: 'light' });
  assert.equal(light.model, 'claude-haiku-4-5-20251001');
  assert.equal(light.toolchain.maxThinkingTokens, 2048);
  const deep = resolveSeat(cfg.ship, cfg.routes[0], 'dev', { tier: 'deep' });
  assert.equal(deep.model, 'claude-opus-5-5');
  assert.equal(deep.toolchain.maxThinkingTokens, 16384);
});

test('resolveSeat: an entry\'s own tier override beats the harness default, and an ori entry accepts any explicit model', () => {
  const cfg = cfgFrom(TWO);
  const deep = resolveSeat(cfg.ship, cfg.routes[0], 'dev', { vendor: 'openrouter', tier: 'deep' });
  assert.equal(deep.model, 'openai/gpt-5');
  assert.equal(deep.toolchain.maxThinkingTokens, 9000);
  const explicit = resolveSeat(cfg.ship, cfg.routes[0], 'dev', { vendor: 'openrouter', model: 'google/gemini-3' });
  assert.equal(explicit.model, 'google/gemini-3');
  assert.deepEqual(explicit.warnings, []);
});

test('planAgentRun carries the resolution: chosen toolchain, model, warnings and --dry-run lines', () => {
  const cfg = cfgFrom(TWO);
  const home = mkdtempSync(join(tmpdir(), 'crew-home-'));
  mkdirSync(join(home, 'personas'), { recursive: true });
  writeFileSync(join(home, 'personas', 'common.md'), 'C\n');
  writeFileSync(join(home, 'personas', 'lane-dev.md'), 'D\n');
  const p = planAgentRun({
    role: 'dev', route: { ...cfg.routes[0]!, promptsDir: home }, ship: cfg.ship,
    stateDir: mkdtempSync(join(tmpdir(), 'crew-st-')), roster: 'R', environment: 'E', cycle: 'c1',
    agentPersona: { vendor: 'google' },
  });
  assert.equal(p.toolchain, 'claude');
  assert.equal(p.warnings?.length, 1);
  const text = describePlan(p);
  assert.match(text, /resolved: toolchain claude/);
  assert.match(text, /warning: .*google/);
});

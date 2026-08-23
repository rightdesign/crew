import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, configuredMembers, ConfigError } from '../src/config.ts';

function withConfig(yaml: string) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-cfg-'));
  const file = join(dir, 'crew.yaml');
  writeFileSync(file, yaml);
  return { dir, file };
}

const MINIMAL = `
project: { dir: /tmp/proj, worktreePrefix: proj-issue- }
tracker:
  baseUrl: https://example.test/
  workspaceId: ws
  models: { issues: i, comments: c, crew: m }
crew:
  seats: { dev: dev-1, qa: qa-1 }
  operator: op-1
  holds: [{ id: pair-1, role: live session }]
`;

test('loads a minimal config and normalises it', () => {
  const { dir, file } = withConfig(MINIMAL);
  const cfg = loadConfig(dir, file);
  assert.equal(cfg.enabled, false);                       // interlock defaults closed
  assert.equal(cfg.tracker.baseUrl, 'https://example.test'); // trailing slash trimmed
  assert.equal(cfg.agent.model, 'claude-sonnet-5');
  assert.deepEqual(cfg.release.versionFiles, ['package.json']);
  assert.equal(cfg.release.changelog, 'CHANGELOG.md');
  assert.equal(cfg.runtime.useNvm, true);
});

test('the interlock is opt-in: anything but true is false', () => {
  for (const v of ['false', '"true"', 'yes', '1']) {
    const { dir, file } = withConfig(`enabled: ${v}\n${MINIMAL}`);
    assert.equal(loadConfig(dir, file).enabled, v === '1' ? false : false);
  }
  const { dir, file } = withConfig(`enabled: true\n${MINIMAL}`);
  assert.equal(loadConfig(dir, file).enabled, true);
});

test('every missing setting is reported at once, not one per run', () => {
  const { dir, file } = withConfig('project: { dir: /tmp/p, worktreePrefix: x- }\n');
  assert.throws(() => loadConfig(dir, file), (e: Error) => {
    assert.ok(e instanceof ConfigError);
    for (const p of [
      'tracker.baseUrl', 'tracker.workspaceId', 'tracker.models.issues',
      'tracker.models.comments', 'tracker.models.crew', 'crew.operator', 'crew.seats',
    ]) assert.match(e.message, new RegExp(p.replace(/\./g, '\\.')));
    return true;
  });
});

test('a single missing setting reads as one line', () => {
  const one = MINIMAL.replace('workspaceId: ws', 'workspaceId: ""');
  const { dir, file } = withConfig(one);
  assert.throws(() => loadConfig(dir, file), /workspaceId is required$/m);
});

test('a config with no seats is refused', () => {
  const bad = MINIMAL.replace('seats: { dev: dev-1, qa: qa-1 }', 'seats: {}');
  const { dir, file } = withConfig(bad);
  assert.throws(() => loadConfig(dir, file), /crew\.seats/);
});

test('configuredMembers maps seats and holds for the roster', () => {
  const { dir, file } = withConfig(MINIMAL);
  const members = configuredMembers(loadConfig(dir, file));
  assert.deepEqual(members, [
    { id: 'dev-1', role: 'Dev', kind: 'seat' },
    { id: 'qa-1', role: 'QA', kind: 'seat' },
    { id: 'op-1', role: 'Operator', kind: 'hold' },
    { id: 'pair-1', role: 'live session', kind: 'hold' },
  ]);
});

test('an omitted seat means this ship does not crew that role', () => {
  const { dir, file } = withConfig(MINIMAL);
  const cfg = loadConfig(dir, file);
  assert.equal(cfg.crew.seats.design, undefined);
  assert.ok(!configuredMembers(cfg).some((m) => m.role === 'Design'));
});

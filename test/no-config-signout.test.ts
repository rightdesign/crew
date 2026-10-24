import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// CREW-2443: sign-out and reset exist for a machine with no crew.yaml at all.
const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
const run = (args: string[]) => {
  // Everything points at a throwaway dir, which is what the agent-session guard asks for.
  const { CREW_LANE_ROLE: _role, ...inherited } = process.env;
  const home = mkdtempSync(join(tmpdir(), 'crew-noconfig-'));
  return spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], {
    encoding: 'utf8',
    env: { ...inherited, HOME: home, XDG_CONFIG_HOME: join(home, 'cfg'), CREW_CONFIG: join(home, 'cfg', 'crew.yaml'), CREW_HOME: home },
  });
};

test('connect --sign-out with no crew.yaml exits 0 and reports ok', () => {
  const r = run(['connect', '--sign-out', '--json', '--dry-run', '--base-url', 'https://app.example.test']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /no config found/);
  assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()!).ok, true);
});

test('disconnect --reset --dry-run with no crew.yaml reads the config step as absent', () => {
  const r = run(['disconnect', '--reset', '--json', '--dry-run']);
  assert.doesNotMatch(r.stderr, /no config found/);
  const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
  assert.equal(out.steps.find((s: { step: string }) => s.step === 'config').action, 'absent');
});

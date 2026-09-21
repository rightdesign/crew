import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const LAUNCHER = resolve(import.meta.dirname, '..', 'bin', 'crew');

/**
 * CREW-988: `bin/crew` prefers `dist/cli.js`, and `dist/` is only rebuilt by
 * the release's build hook — which runs AFTER the test gate. A test that
 * spawns the launcher was therefore exercising the previous release's bundle,
 * so CREW-980's new guard "failed" its own tests on main and deadlocked the
 * release. `CREW_FROM_SOURCE=1` (`helpers/crew-bin.ts`'s `CREW_ENV`, which
 * every CLI-spawning test spreads into its child env) must win over a present
 * `dist/`.
 *
 * The launcher resolves both paths relative to itself, so a copy of it in a
 * scratch tree with a decoy bundle and a decoy source is a faithful rig.
 */
function rig() {
  const root = mkdtempSync(join(tmpdir(), 'crew-launcher-'));
  for (const d of ['bin', 'dist', 'src']) mkdirSync(join(root, d));
  copyFileSync(LAUNCHER, join(root, 'bin', 'crew'));
  writeFileSync(join(root, 'dist', 'cli.js'), 'console.log("ran:dist");\n');
  writeFileSync(join(root, 'src', 'cli.ts'), 'const from: string = "source";\nconsole.log(`ran:${from}`);\n');
  // Without this the scratch tree's .js bundle is parsed as CommonJS-or-ESM by
  // guesswork; the real package.json declares it.
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  return join(root, 'bin', 'crew');
}

function launch(launcher: string, env: Record<string, string | undefined>) {
  return execFileSync(process.execPath, [launcher], {
    env: { ...process.env, ...env }, encoding: 'utf8',
  }).trim();
}

test('the launcher runs the built bundle when one exists — what an installed crew does', () => {
  assert.equal(launch(rig(), { CREW_FROM_SOURCE: undefined }), 'ran:dist');
});

test('CREW_FROM_SOURCE=1 runs src/cli.ts even though dist/cli.js exists — the test gate must never exercise a stale bundle (CREW-988)', () => {
  assert.equal(launch(rig(), { CREW_FROM_SOURCE: '1' }), 'ran:source');
});

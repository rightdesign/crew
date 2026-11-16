import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// VitePress compiles each page as a Vue template, so a bare angle-bracket
// placeholder in prose parses as an unclosed element and fails the Docs
// workflow after the release has merged (CREW-3469). Building into a scratch
// directory here fails the same mistake on the ticket's own branch.
test('the docs site builds (placeholders in prose go in inline code)', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'docs-build-')), 'dist');
  const r = spawnSync(
    'pnpm',
    ['exec', 'vitepress', 'build', 'docs', '--outDir', out],
    { cwd: root, encoding: 'utf8', timeout: 80000 },
  );
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-2000));
});

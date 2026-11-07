import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { platformAdmitters, platformStuckNote } from '../src/platform-gate.ts';
import { repoPlatformUnreleasableItem, repoPlatformUnreleasableKey } from '../src/ship-attention.ts';

const yaml = (platform: string) => ['version: 1', `platform: ${platform}`, 'release:', '  mode: integrate'].join('\n');

/** A repo whose base says `basePlatform` and whose `issue-1` branch says `branchPlatform` (null = leaves the contract alone). */
function repoWith(basePlatform: string, branchPlatform: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-platform-gate-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  writeFileSync(join(dir, '.crew.yaml'), yaml(basePlatform));
  g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'issue-1');
  if (branchPlatform !== null) writeFileSync(join(dir, '.crew.yaml'), yaml(branchPlatform));
  else writeFileSync(join(dir, 'other'), 'x');
  g('add', '.'); g('commit', '-q', '--allow-empty', '-m', 'work');
  g('checkout', '-q', 'main');
  return dir;
}
const T = [{ issue_id: 'CTPL-1' }];
const locate = () => 'issue-1';

test('base linux, branch unix, ship macos: the branch admits the ship', () => {
  const got = platformAdmitters(repoWith('linux', 'unix'), 'main', 'macos', T, locate);
  assert.deepEqual(got.map((a) => [a.issueId, a.platform]), [['CTPL-1', 'unix']]);
});

test('base linux, branch linux, ship macos: nothing admits the ship', () => {
  assert.deepEqual(platformAdmitters(repoWith('linux', 'linux'), 'main', 'macos', T, locate), []);
});

test('a branch that does not touch the contract never admits', () => {
  assert.deepEqual(platformAdmitters(repoWith('linux', null), 'main', 'macos', T, locate), []);
});

test('a ticket with no branch is ignored', () => {
  assert.deepEqual(platformAdmitters(repoWith('linux', 'unix'), 'main', 'macos', T, () => null), []);
});

test('the stuck note names the tickets and the platforms that could release', () => {
  const note = platformStuckNote('template-web-static', 'linux', 'macos', ['CTPL-3097']);
  assert.match(note, /CTPL-3097/);
  assert.match(note, /requires linux/);
  const item = repoPlatformUnreleasableItem('template-web-static', note);
  assert.equal(item.key, repoPlatformUnreleasableKey('template-web-static'));
  assert.equal(item.kind, 'repo_platform_unreleasable');
});

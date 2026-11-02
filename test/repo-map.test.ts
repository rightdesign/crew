import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { budgetMap, withRepoMaps, mapFilePath, inspectMapFile } from '../src/repo-map.ts';
import { resolveRepoConfig, parseRepoConfig } from '../src/repo-config.ts';
import type { EnvironmentRepo } from '../src/environment.ts';


const repo = (hook: string | null): EnvironmentRepo => ({
  name: 'r', dir: process.cwd(),
  config: resolveRepoConfig(parseRepoConfig(`version: 1\nrelease:\n  mode: integrate\n${hook === null ? '' : `hooks:\n  map: ${JSON.stringify(hook)}\n`}`, '.crew.yaml'), undefined, process.cwd()),
});

// CREW-2873
test('budgetMap leaves a map within budget alone', () => {
  assert.equal(budgetMap('a\nb\n', 10), 'a\nb');
});

test('budgetMap drops whole lines from the bottom and ends with how much was cut', () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${String(i).padStart(2, '0')} ${'x'.repeat(30)}`).join('\n');
  const out = budgetMap(text, 100); // 400 characters
  assert.ok(out.length <= 400, `got ${out.length}`);
  const lines = out.split('\n');
  assert.match(lines.at(-1)!, /^… \d+ of 50 lines cut to fit ship\.mapTokenBudget \(100 tokens\)$/);
  assert.match(lines[0]!, /^line 00/);
  for (const l of lines.slice(0, -1)) assert.match(l, /^line \d\d x{30}$/); // no partial lines
});

test('a declared hook is run and budgeted; no hook means no section', async () => {
  const r = await withRepoMaps([repo('printf "a\\nb\\n"')], 1000);
  assert.equal(r[0]!.map, 'a\nb');
  const none = await withRepoMaps([repo(null)], 1000);
  assert.equal(none[0]!.map, undefined);
  assert.equal(none[0]!.mapSkipped, undefined);
});

test('a failing or silent hook is skipped with a reason, never thrown', async () => {
  const [bad] = await withRepoMaps([repo('exit 3')], 1000);
  assert.equal(bad!.map, undefined);
  assert.match(bad!.mapSkipped!, /exited 3/);
  const [quiet] = await withRepoMaps([repo('true')], 1000);
  assert.match(quiet!.mapSkipped!, /printed nothing/);
});

test('only stdout is the map; stderr is ignored', async () => {
  const [r] = await withRepoMaps([repo('echo "warning: noisy" >&2; printf "v1\\n"')], 1000);
  assert.equal(r!.map, 'v1');
  const [onlyErr] = await withRepoMaps([repo('echo oops >&2')], 1000);
  assert.equal(onlyErr!.map, undefined);
  assert.match(onlyErr!.mapSkipped!, /printed nothing/);
});

test('each assembly re-runs the hook, so a changed map and a recovered failure show up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'map-'));
  const file = join(dir, 'MAP.md');
  const r: EnvironmentRepo = { ...repo('cat MAP.md'), dir };
  const first = await withRepoMaps([r], 1000);
  assert.match(first[0]!.mapSkipped!, /exited/);
  writeFileSync(file, 'v1\n');
  assert.equal((await withRepoMaps([r], 1000))[0]!.map, 'v1');
  writeFileSync(file, 'v2\n');
  assert.equal((await withRepoMaps([r], 1000))[0]!.map, 'v2');
});

// CREW-2919
test('mapFilePath accepts only a single relative .md path', () => {
  for (const ok of ['docs/REPO_MAP.md', 'MAP.md', 'a/b-c_d.1/map.MD']) assert.equal(mapFilePath(ok), ok, ok);
  for (const no of ['scripts/repo-map.sh', 'cat docs/MAP.md', 'docs/MAP.md; rm x', '$X/MAP.md', '/etc/MAP.md', '../MAP.md', 'a/../MAP.md', './MAP.md', 'docs/MAP.md | cat', '"docs/MAP.md"', 'docs/my map.md', '', 'docs/MAP.md.sh']) {
    assert.equal(mapFilePath(no), null, no);
  }
  assert.equal(mapFilePath(undefined), null);
});

const fileRepo = (dir: string, hook: string): EnvironmentRepo => ({ ...repo(hook), dir });

test('a .md map is read from the checkout and budgeted, never run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-mapfile-'));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs/REPO_MAP.md'), '# Map\n- apps/a\n');
  const [r] = await withRepoMaps([fileRepo(dir, 'docs/REPO_MAP.md')], 1000);
  assert.equal(r!.map, '# Map\n- apps/a');
  const long = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
  writeFileSync(join(dir, 'docs/REPO_MAP.md'), long);
  const [cut] = await withRepoMaps([fileRepo(dir, 'docs/REPO_MAP.md')], 100);
  assert.ok(cut!.map!.length <= 400);
  assert.match(cut!.map!, /lines cut to fit ship\.mapTokenBudget/);
});

test('a .md map that is missing or empty gives the absence note and does not fail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-mapfile-'));
  const [gone] = await withRepoMaps([fileRepo(dir, 'docs/NOPE.md')], 1000);
  assert.equal(gone!.map, undefined);
  assert.match(gone!.mapSkipped!, /docs\/NOPE\.md.*missing/);
  writeFileSync(join(dir, 'E.md'), '  \n');
  const [empty] = await withRepoMaps([fileRepo(dir, 'E.md')], 1000);
  assert.match(empty!.mapSkipped!, /E\.md.*empty/);
});

test('inspectMapFile counts lines and tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-mapfile-'));
  writeFileSync(join(dir, 'M.md'), 'abcd\nefgh\n');
  assert.deepEqual(inspectMapFile(dir, 'M.md'), { path: 'M.md', exists: true, lines: 2, tokens: 3 });
  assert.equal(inspectMapFile(dir, 'X.md').exists, false);
});

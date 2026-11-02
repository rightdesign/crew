import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { budgetMap, withRepoMaps } from '../src/repo-map.ts';
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

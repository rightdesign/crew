import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRouteBlock, planAppendToConfig, replaceFileKeepingMode } from '../src/connect-append.ts';
import { loadConfig } from '../src/config.ts';
import { renderConnection, type Discovered } from '../src/connect.ts';

const d: Discovered = { workspaceId: 'w', workspaceSlug: 'other', models: {}, seats: {}, holds: [], candidates: [], problems: [], provisioning: [] };
const block = renderConnection(d, 'other/issues', null, { keychainBacked: true });
const ship = 'ship:\n  name: x\n  platform: macos\n  agent:\n    bin: /bin/claude\n';

const loads = (text: string) => loadConfig(mkdtempSync(join(tmpdir(), 'crew-append-')), '/nowhere/crew.yaml', { text });

test('appends last under routes: with comments between and inside routes untouched', () => {
  const before = `# top comment\n${ship}routes:\n  # first route\n  - route: issues/issues\n    enabled: true   # live\n    # inner note\n    dir: /a\n\n  # second\n  - route: paradium:pauldb/issues\n    enabled: false\n    dir: /b\n`;
  const r = appendRouteBlock(before, block);
  assert.ok(r.ok);
  assert.ok(r.text.startsWith(before), 'every existing byte is kept, in place');
  assert.equal(r.text.slice(before.length), block);
  const cfg = loads(r.text);
  assert.deepEqual(cfg.routes.map((x) => x.route), ['issues/issues', 'paradium:pauldb/issues', 'other/issues']);
  assert.equal(cfg.routes[2]!.enabled, false);
});

test('inserts before a later top-level key and keeps what follows', () => {
  const before = `${ship}routes:\n  - route: issues/issues\n    dir: /a\n# trailing\n`;
  const r = appendRouteBlock(before, block);
  assert.ok(r.ok);
  assert.equal(r.text, `${before.slice(0, before.indexOf('# trailing'))}${block}# trailing\n`);
  assert.equal(loads(r.text).routes.length, 2);
});

test('an empty routes: [] list takes the block', () => {
  const r = appendRouteBlock(`${ship}routes: []\n`, block);
  assert.ok(r.ok);
  assert.equal(r.text, `${ship}routes:\n${block}`);
  assert.deepEqual(loads(r.text).routes.map((x) => x.route), ['other/issues']);
});

test('a file with no trailing newline still ends on one', () => {
  const r = appendRouteBlock(`${ship}routes:\n  - route: issues/issues\n    dir: /a`, block);
  assert.ok(r.ok);
  assert.ok(r.text.endsWith(block));
  assert.equal(loads(r.text).routes.length, 2);
});

test('routes at column 0 get the block at the same column', () => {
  const r = appendRouteBlock(`${ship}routes:\n- route: issues/issues\n  dir: /a\n`, block);
  assert.ok(r.ok);
  assert.match(r.text, /\n- route: other\/issues\n {2}enabled: false/);
  assert.equal(loads(r.text).routes.length, 2);
});

test('routes: missing, an inline list or invalid yaml is refused with a reason', () => {
  for (const t of [ship, `${ship}routes: [{route: a/b}]\n`, `${ship}routes: nope\n`, 'routes: [\n']) {
    const r = appendRouteBlock(t, block);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.reason.length > 0);
  }
});

test('replaceFileKeepingMode keeps the mode and leaves no temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-append-'));
  const f = join(dir, 'crew.yaml');
  writeFileSync(f, 'old');
  chmodSync(f, 0o640);
  replaceFileKeepingMode(f, 'new');
  assert.equal(readFileSync(f, 'utf8'), 'new');
  assert.equal(statSync(f).mode & 0o7777, 0o640);
  assert.deepEqual(readdirSync(dir), ['crew.yaml']);
  assert.ok(!existsSync(join(dir, '.crew.yaml.tmp')));
});

test('planAppendToConfig: a result the loader rejects, a missing routes: and no stored key all refuse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-append-'));
  const f = join(dir, 'crew.yaml');
  const bad = `${ship}routes:\n  - route: issues/issues\n    dir: /a\n`;
  writeFileSync(f, bad);
  const bogus = '  - route: other/issues\n    toolchain: nope\n';
  const rejected = planAppendToConfig(dir, f, 'other/issues', bogus, true);
  assert.ok(!rejected.ok && /config loader/.test(rejected.reason));
  assert.equal(readFileSync(f, 'utf8'), bad);
  const noKey = planAppendToConfig(dir, f, 'other/issues', block, false);
  assert.ok(!noKey.ok && /no stored key/.test(noKey.reason));
  writeFileSync(f, ship);
  const noRoutes = planAppendToConfig(dir, f, 'other/issues', block, true);
  assert.ok(!noRoutes.ok && /routes:/.test(noRoutes.reason));
  assert.equal(readFileSync(f, 'utf8'), ship);
});

test('planAppendToConfig: a second connect finds the route and the plan is not needed; a valid plan adds one block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-append-'));
  const f = join(dir, 'crew.yaml');
  writeFileSync(f, `${ship}routes:\n  - route: issues/issues\n    dir: /a\n`);
  const ok = planAppendToConfig(dir, f, 'other/issues', block, true);
  assert.ok(ok.ok);
  replaceFileKeepingMode(f, ok.text);
  assert.equal(loadConfig(dir, f).routes.filter((r) => r.route === 'other/issues').length, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureClaudeMcp, inspectClaudeMcp, mcpUrlFor } from '../src/claude-mcp.ts';

const KEY = 'sk_secretkey123';
const URL = 'https://app.example.test/api/mcp';

/** A stub `claude`: `mcp get` exits per $DIR/get-status, every call is logged to $DIR/calls. */
function fixture(getStatus: number, claudeJson?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-mcp-'));
  const bin = join(dir, 'claude');
  writeFileSync(join(dir, 'get-status'), String(getStatus));
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${dir}/calls"\nif [ "$2" = get ]; then exit $(cat "${dir}/get-status"); fi\nexit 0\n`);
  chmodSync(bin, 0o755);
  if (claudeJson !== undefined) writeFileSync(join(dir, '.claude.json'), JSON.stringify(claudeJson));
  const calls = () => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') : []);
  return { dir, bin, calls };
}
const entry = (url: string, key: string) => ({ mcpServers: { tablation: { type: 'http', url, headers: { Authorization: `Bearer ${key}` } } } });

test('mcpUrlFor trims trailing slashes', () => {
  assert.equal(mcpUrlFor('https://x.test/'), 'https://x.test/api/mcp');
});

test('missing server → one mcp add with the resolved key and URL', () => {
  const f = fixture(1);
  const msg = ensureClaudeMcp({ bin: f.bin, url: URL, key: KEY, home: f.dir });
  const adds = f.calls().filter((c) => c.startsWith('mcp add'));
  assert.equal(adds.length, 1);
  assert.match(adds[0]!, /--transport http tablation https:\/\/app\.example\.test\/api\/mcp --header Authorization: Bearer sk_secretkey123 --scope user/);
  assert.match(msg, /registered/);
  assert.ok(!msg.includes(KEY));
});

test('matching existing server → no mcp add', () => {
  const f = fixture(0, entry(URL, KEY));
  const msg = ensureClaudeMcp({ bin: f.bin, url: URL, key: KEY, home: f.dir });
  assert.equal(f.calls().filter((c) => c.startsWith('mcp add')).length, 0);
  assert.match(msg, /already registered/);
});

test('different URL → no write, difference printed; --mcp replace removes then adds', () => {
  const f = fixture(0, entry('http://localhost:3000/api/mcp', KEY));
  const msg = ensureClaudeMcp({ bin: f.bin, url: URL, key: KEY, home: f.dir });
  assert.deepEqual(f.calls().filter((c) => /^mcp (add|remove)/.test(c)), []);
  assert.match(msg, /localhost:3000/);
  assert.match(msg, /--mcp replace/);
  ensureClaudeMcp({ bin: f.bin, url: URL, key: KEY, home: f.dir, replace: true });
  const writes = f.calls().filter((c) => /^mcp (add|remove)/.test(c));
  assert.match(writes[0]!, /^mcp remove tablation/);
  assert.match(writes[1]!, /^mcp add/);
});

test('different key is reported without leaking either key', () => {
  const f = fixture(0, entry(URL, 'sk_other'));
  const st = inspectClaudeMcp({ bin: f.bin, url: URL, key: KEY, home: f.dir });
  assert.equal(st.state, 'different');
  const msg = ensureClaudeMcp({ bin: f.bin, url: URL, key: KEY, home: f.dir });
  assert.ok(!msg.includes(KEY) && !msg.includes('sk_other'));
});

test('server present only outside user scope is left alone', () => {
  const f = fixture(0, {});
  assert.equal(inspectClaudeMcp({ bin: f.bin, url: URL, key: KEY, home: f.dir }).state, 'different');
});

test('no claude binary → note with the manual command, no throw', () => {
  const msg = ensureClaudeMcp({ bin: '/nonexistent/claude-bin', url: URL, key: KEY });
  assert.match(msg, /not found/);
  assert.match(msg, /claude mcp add/);
  assert.ok(!msg.includes(KEY));
});

test('dry run does not write', () => {
  const f = fixture(1);
  const msg = ensureClaudeMcp({ bin: f.bin, url: URL, key: KEY, home: f.dir, dryRun: true });
  assert.equal(f.calls().filter((c) => c.startsWith('mcp add')).length, 0);
  assert.match(msg, /dry run/);
});

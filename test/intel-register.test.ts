import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeJsonServer, mergeTomlServer, registerCodeServer } from '../src/intel-register.ts';

const URL_ = 'http://127.0.0.1:50123/mcp';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });

function repoAndWorktree(): { dir: string; wt: string } {
  const dir = mkdtempSync(join(tmpdir(), 'crew-intel-reg-'));
  const main = join(dir, 'main');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const wt = join(dir, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'b', wt);
  return { dir, wt };
}

test('mergeJsonServer adds only the code entry and keeps the rest', () => {
  const old = JSON.stringify({ other: 1, mcpServers: { tracker: { type: 'http', url: 'http://t' } } });
  const out = JSON.parse(mergeJsonServer(old, { type: 'http', url: URL_ }, 'code'));
  assert.deepEqual(out, { other: 1, mcpServers: { tracker: { type: 'http', url: 'http://t' }, code: { type: 'http', url: URL_ } } });
  assert.deepEqual(JSON.parse(mergeJsonServer(undefined, { httpUrl: URL_ }, 'code')), { mcpServers: { code: { httpUrl: URL_ } } });
  assert.throws(() => mergeJsonServer('{nope', {}, 'code'));
  assert.throws(() => mergeJsonServer('[]', {}, 'code'), /not a JSON object/);
});

test('mergeTomlServer appends, replaces only its own table and is idempotent', () => {
  assert.equal(mergeTomlServer(undefined, URL_, 'code'), `[mcp_servers.code]\nurl = "${URL_}"\n`);
  const old = '# mine\nmodel = "x"\n\n[mcp_servers.code]\nurl = "http://old"\n\n[mcp_servers.other]\nurl = "http://o"\n';
  const out = mergeTomlServer(old, URL_, 'code');
  assert.equal(out, `# mine\nmodel = "x"\n\n[mcp_servers.code]\nurl = "${URL_}"\n\n[mcp_servers.other]\nurl = "http://o"\n`);
  assert.equal(mergeTomlServer(out, URL_, 'code'), out);
  assert.equal(mergeTomlServer('model = "x"', URL_, 'code'), `model = "x"\n\n[mcp_servers.code]\nurl = "${URL_}"\n`);
});

test('registerCodeServer writes the three files, merges an existing one and hides them from git', () => {
  const { dir, wt } = repoAndWorktree();
  try {
    writeFileSync(join(wt, '.mcp.json'), JSON.stringify({ mcpServers: { keep: { type: 'stdio', command: 'x' } } }));
    const r = registerCodeServer(wt, URL_);
    assert.deepEqual(r.skipped, []);
    assert.equal(r.written.length, 3);
    const claude = JSON.parse(readFileSync(join(wt, '.mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(claude.mcpServers).sort(), ['code', 'keep']);
    assert.deepEqual(JSON.parse(readFileSync(join(wt, '.gemini/settings.json'), 'utf8')).mcpServers.code, { httpUrl: URL_ });
    assert.match(readFileSync(join(wt, '.codex/config.toml'), 'utf8'), /\[mcp_servers\.code\]/);
    assert.equal(git(wt, 'status', '--porcelain').trim(), '', 'git sees nothing to commit');
    registerCodeServer(wt, URL_);   // idempotent, no duplicate exclude lines
    const ex = readFileSync(join(git(wt, 'rev-parse', '--git-path', 'info/exclude').trim().replace(/^(?!\/)/, `${wt}/`)), 'utf8');
    assert.equal(ex.split('\n').filter((l) => l === '.mcp.json').length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('registerCodeServer leaves an unparseable file untouched and keeps going', () => {
  const { dir, wt } = repoAndWorktree();
  try {
    writeFileSync(join(wt, '.mcp.json'), '{not json');
    const r = registerCodeServer(wt, URL_);
    assert.equal(readFileSync(join(wt, '.mcp.json'), 'utf8'), '{not json');
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0]!, /^\.mcp\.json left alone/);
    assert.deepEqual(r.written, ['.codex/config.toml', '.gemini/settings.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a tracked config file is merged but kept out of git status', () => {
  const { dir, wt } = repoAndWorktree();
  try {
    writeFileSync(join(wt, '.mcp.json'), '{"mcpServers":{}}\n');
    git(wt, 'add', '.mcp.json');
    git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'track');
    registerCodeServer(wt, URL_);
    assert.match(readFileSync(join(wt, '.mcp.json'), 'utf8'), /"code"/);
    assert.equal(git(wt, 'status', '--porcelain').trim(), '');
    assert.ok(existsSync(join(wt, '.mcp.json')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

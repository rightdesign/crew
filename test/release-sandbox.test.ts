import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitOk } from '../src/git.ts';
import { existsAt, readTextAt, registerRemoteDir, remoteOf, unregisterRemoteDir, writeTextAt } from '../src/remote-dir.ts';
import { releaseCloneScript, openReleaseSandbox, CREDENTIAL_HELPER } from '../src/release-sandbox.ts';
import { runScript } from '../src/shell.ts';
import { mirrorRelPath } from '../src/sandbox-cache.ts';

const sh = (cwd: string, cmd: string): string => execFileSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' });
const repo = { host: 'github.com', path: 'o/r' };

/** A fake `openshell`: `sandbox exec ... --workdir D -- argv` runs argv in D on this machine. */
function fakeOpenshell(dir: string): string {
  const bin = join(dir, 'openshell');
  writeFileSync(bin, `#!/bin/sh
[ "$1" = sandbox ] && [ "$2" = exec ] || exit 0
shift 2
wd=.
while [ "$1" != -- ]; do [ "$1" = --workdir ] && wd="$2"; shift; done
shift
cd "$wd" && exec "$@"
`);
  chmodSync(bin, 0o755);
  return bin;
}

/** A bare mirror of a 120-commit history with a tag at commit 100 and a ticket branch. */
function mirrorWithHistory(root: string): string {
  const src = join(root, 'src');
  mkdirSync(src);
  sh(src, 'git init -q -b main && git config user.email a@b && git config user.name n');
  for (let i = 1; i <= 120; i++) {
    sh(src, `echo ${i} > f && git add f && git commit -q -m c${i}`);
    if (i === 100) sh(src, 'git tag -a v1.0.0 -m rel');
    if (i === 110) sh(src, 'git branch ticket-1');
  }
  sh(src, 'git checkout -q ticket-1 && echo t > t && git add t && git commit -q -m ticket && git checkout -q main');
  const mirror = join(root, 'cache', mirrorRelPath(repo));
  mkdirSync(join(mirror, '..'), { recursive: true });
  sh(root, `git clone -q --mirror ${src} ${mirror}`);
  return mirror;
}

test('the release clone is shallow, reaches the latest release tag, and fetches only named branches', () => {
  const root = mkdtempSync(join(tmpdir(), 'rs-'));
  mirrorWithHistory(root);
  const work = join(root, 'work');
  const script = releaseCloneScript({
    mirrorDir: join(root, 'cache'), repo, workDir: work, origin: 'https://example.invalid/o/r.git',
    base: 'main', branches: ['ticket-1', 'not-there'], tagPattern: 'v*',
  }).replace("git config --global --add safe.directory '*'", 'true').replace(/git config --global credential.helper .*/, 'true');
  sh(root, script);
  assert.equal(git(work, ['rev-parse', '--is-shallow-repository']), 'true');
  const total = Number(git(work, ['rev-list', '--count', '--all']));
  assert.ok(total < 120, `shallow, not the whole history (${total})`);
  assert.equal(git(work, ['describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD']), 'v1.0.0');
  assert.equal(git(work, ['tag', '--list']), 'v1.0.0');
  assert.equal(git(work, ['remote', 'get-url', 'origin']), 'https://example.invalid/o/r.git');
  assert.ok(gitOk(work, ['rev-parse', '--verify', 'refs/remotes/origin/ticket-1']));
  assert.equal(gitOk(work, ['rev-parse', '--verify', 'refs/remotes/origin/not-there']), null);
  assert.deepEqual(git(work, ['branch', '-r']).split('\n').map((l) => l.trim()).filter((l) => !l.includes('->')).sort(), ['origin/main', 'origin/ticket-1']);
  assert.match(git(work, ['config', '--get', 'crew.releaseDepth']), /^\d+$/);
});

test('the credential helper reads the token from the environment, never a literal', () => {
  assert.match(CREDENTIAL_HELPER, /\$CREW_FORGE_TOKEN/);
  const script = releaseCloneScript({ mirrorDir: '/cache', repo, workDir: '/w', origin: 'https://x/o/r.git', base: 'main', branches: [], tagPattern: 'v*' });
  assert.doesNotMatch(script, /ghp_|password=[a-z0-9]{6,}/);
});

test('git, hooks and file edits on a registered sandbox directory run through openshell', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rs-'));
  const bin = fakeOpenshell(root);
  const work = join(root, 'inside');
  mkdirSync(work);
  sh(work, 'git init -q -b main && git config user.email a@b && git config user.name n && echo hi > a && git add a && git commit -q -m one');
  const dir = registerRemoteDir({ bin, sandbox: 'sbx', workDir: work, prelude: 'PRE=1; export PRE; ' });
  try {
    assert.equal(remoteOf(dir)?.path, work);
    assert.equal(remoteOf(join(dir, 'sub'))?.path, join(work, 'sub'));
    assert.equal(remoteOf('/tmp/elsewhere'), null);
    assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
    assert.equal(gitOk(dir, ['rev-parse', '--verify', 'nope']), null);
    assert.equal(existsAt(join(dir, 'a'), existsSync), true);
    assert.equal(existsAt(join(dir, 'b'), existsSync), false);
    writeTextAt(join(dir, 'b'), 'written\n', (p, t) => writeFileSync(p, t));
    assert.equal(readFileSync(join(work, 'b'), 'utf8'), 'written\n');
    assert.equal(readTextAt(join(dir, 'b'), (p) => readFileSync(p, 'utf8')), 'written\n');
    const r = await runScript('echo "$PRE $EXTRA $(pwd)"; exit 3', { cwd: dir, env: { EXTRA: "it's" } });
    assert.equal(r.code, 3);
    assert.equal(r.stdout.trim(), `1 it's ${work}`);
  } finally { unregisterRemoteDir(dir); }
  assert.equal(remoteOf(dir), null);
});

test('openReleaseSandbox creates, clones, registers, and deletes on close', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rs-'));
  const calls: string[][] = [];
  const events: string[] = [];
  const emit = { emit: (m: string) => events.push(m), warn: (m: string) => events.push(m), error: (m: string) => events.push(m) } as never;
  const sb = await openReleaseSandbox({
    sandbox: { bin: 'openshell', cacheVolume: 'vol', mirrorDir: '/cache', workDir: '/sandbox/work' },
    route: 'r', repoName: 'crew', policy: { forgeHosts: ['github.com'], tablationUrl: 'https://app.tablation.com', authMode: 'workspace', provider: 'anthropic', harnessBin: 'claude' },
    policyFile: join(root, 'p', 'policy.yaml'), repo, origin: 'https://github.com/o/r.git', base: 'main', branches: ['b1'], tagPattern: 'v*',
    token: 'sekret', username: 'x-access-token', emit,
    exec: async (_b, args, env) => { calls.push(args); if (args[0] === 'sandbox' && args[1] === 'create') assert.equal(env.CREW_FORGE_TOKEN, 'sekret'); return { stdout: '', stderr: '' }; },
  });
  const create = calls.find((a) => a[1] === 'create')!;
  assert.ok(create.includes('--env-from') && create.includes('CREW_FORGE_TOKEN'));
  assert.ok(!create.join(' ').includes('sekret'), 'the token is not in argv');
  assert.ok(existsSync(join(root, 'p', 'policy.yaml')));
  assert.match(readFileSync(join(root, 'p', 'policy.yaml'), 'utf8'), /github\.com/);
  assert.ok(remoteOf(sb.dir));
  assert.ok(calls.some((a) => a[1] === 'exec' && a.join(' ').includes('--depth')));
  await sb.close();
  await sb.close();
  assert.equal(remoteOf(sb.dir), null);
  assert.equal(calls.filter((a) => a[1] === 'delete').length, 1);
  assert.ok(events.some((e) => e.startsWith('sandbox_created')) && events.some((e) => e.startsWith('sandbox_deleted')));
});

test('a failed clone deletes the sandbox and says why', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rs-'));
  const calls: string[][] = [];
  const emit = { emit: () => {}, warn: () => {}, error: () => {} } as never;
  await assert.rejects(openReleaseSandbox({
    sandbox: { bin: 'openshell' }, route: 'r', repoName: 'crew', policy: { forgeHosts: [], tablationUrl: 'https://app.tablation.com', authMode: 'workspace', provider: 'anthropic', harnessBin: 'claude' },
    policyFile: join(root, 'policy.yaml'), repo, origin: 'https://github.com/o/r.git', base: 'main', branches: [], tagPattern: 'v*', emit,
    exec: async (_b, args) => { calls.push(args); if (args[1] === 'exec') throw new Error('fatal: no mirror'); return { stdout: '', stderr: '' }; },
  }), /could not make the release clone.*no mirror/);
  assert.equal(calls.filter((a) => a[1] === 'delete').length, 1);
});

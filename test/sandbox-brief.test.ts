import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  containerEngineStubScript, containerEngineUse, swapSandboxSkills, sandboxEnv, CONTAINER_ENGINE_MESSAGE,
} from '../src/sandbox-brief.ts';
import { renderEnvironment } from '../src/environment.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import { parseRepoConfig, resolveRepoConfig } from '../src/repo-config.ts';

test('the skill swap renames only the backticked worktree skill', () => {
  assert.equal(
    swapSandboxSkills('Details: the `Worktree Setup` skill. A Worktree Setup note.'),
    'Details: the `Sandbox Setup` skill. A Worktree Setup note.',
  );
  assert.equal(swapSandboxSkills('nothing here'), 'nothing here');
});

test('containerEngineUse finds a command word and ignores comments and arguments', () => {
  assert.equal(containerEngineUse('pnpm install\ndocker compose up -d db'), 'docker');
  assert.equal(containerEngineUse('x && sudo podman run foo'), 'podman');
  assert.equal(containerEngineUse('if true; then /usr/bin/docker ps; fi'), 'docker');
  assert.equal(containerEngineUse('# docker is not used\necho docker\npnpm test'), null);
  assert.equal(containerEngineUse('pg_ctl start'), null);
});

test('the stubs exit non-zero at once with the message naming the pattern', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stubs-'));
  try {
    execFileSync('sh', ['-c', containerEngineStubScript(dir)]);
    for (const engine of ['docker', 'podman']) {
      let err: { status?: number; stderr?: Buffer } = {};
      try { execFileSync(join(dir, engine), ['run', 'x'], { stdio: 'pipe' }); } catch (e) { err = e as typeof err; }
      assert.equal(err.status, 125);
      assert.equal(err.stderr!.toString().trim(), CONTAINER_ENGINE_MESSAGE);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sandboxEnv is empty for a host ship and names the work dir for a sandbox one', () => {
  assert.deepEqual(sandboxEnv({}), {});
  assert.deepEqual(sandboxEnv({ runner: 'host' }), {});
  assert.deepEqual(sandboxEnv({ runner: 'sandbox' }), { sandbox: { workDir: '/sandbox/work' } });
  assert.deepEqual(sandboxEnv({ runner: 'sandbox', sandbox: { workDir: '/w' } }), { sandbox: { workDir: '/w' } });
});

test('a sandboxed environment replaces the worktree section and keeps the hooks', () => {
  const route = { route: 'proj', baseUrl: 'https://x.test', resolved: undefined } as never;
  const repo = {
    name: 'r', dir: '/w/r',
    config: resolveRepoConfig(parseRepoConfig('version: 1\nrelease:\n  mode: integrate\nhooks:\n  test: pnpm test\n', 'x.yaml'), {}, '/w/r'),
  };
  const host = renderEnvironment({ route, userAgent: 'u', repos: [repo as never], contract: DEFAULT_CONTRACT });
  const box = renderEnvironment({ route, userAgent: 'u', repos: [repo as never], contract: DEFAULT_CONTRACT, ...sandboxEnv({ runner: 'sandbox' }) });
  assert.match(host, /## Your worktree/);
  assert.doesNotMatch(host, /Your checkout/);
  assert.match(box, /## Your checkout/);
  assert.match(box, /\/sandbox\/work/);
  assert.match(box, /`Sandbox Setup`/);
  assert.doesNotMatch(box, /## Your worktree/);
  assert.match(box, /## Hooks — the only commands you should run/);
  // Everything outside the checkout section is identical.
  const strip = (t: string, h: string) => t.replace(new RegExp(`\\n${h}[\\s\\S]*?(?=\\n## Hooks)`), '');
  assert.equal(strip(box, '## Your checkout'), strip(host, '## Your worktree'));
});

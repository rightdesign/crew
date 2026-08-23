import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveShell, defaultShell, runScript } from '../src/shell.ts';
import { tmpdir } from 'node:os';

test('a bare interpreter name gets its platform family argument form', () => {
  assert.deepEqual(resolveShell('bash'), { bin: 'bash', args: ['-c'] });
  assert.deepEqual(resolveShell('pwsh'),
    { bin: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command'] });
  assert.deepEqual(resolveShell('powershell.exe'),
    { bin: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command'] });
  assert.deepEqual(resolveShell('cmd.exe'), { bin: 'cmd.exe', args: ['/d', '/s', '/c'] });
});

test('an explicit spec is passed through untouched', () => {
  const spec = { bin: 'zsh', args: ['-lc'] };
  assert.deepEqual(resolveShell(spec), spec);
});

test('no configured shell falls back to the platform default', () => {
  assert.deepEqual(resolveShell(undefined), defaultShell());
});

test('exit status is the result, and output is captured', async () => {
  const ok = await runScript('echo hello', { cwd: tmpdir() });
  assert.equal(ok.code, 0);
  assert.match(ok.output, /hello/);

  const bad = await runScript('echo oops >&2; exit 3', { cwd: tmpdir() });
  assert.equal(bad.code, 3);           // does not throw — the caller decides
  assert.match(bad.output, /oops/);    // stderr is captured too
});

test('a missing interpreter reads as a config problem, not a hook failure', async () => {
  const r = await runScript('echo hi', {
    cwd: tmpdir(), shell: { bin: 'definitely-not-a-shell-xyz', args: ['-c'] },
  });
  assert.equal(r.code, 127);
  assert.match(r.output, /cannot run definitely-not-a-shell-xyz/);
});

test('onLine sees every line including one with no trailing newline', async () => {
  const lines: string[] = [];
  await runScript('printf "a\\nb\\nc"', { cwd: tmpdir(), onLine: (l) => lines.push(l) });
  assert.deepEqual(lines, ['a', 'b', 'c']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellFor, shellInitScript, SHELLS } from '../src/shell-init.ts';

test('shellFor: the requested shell, else $SHELL, else zsh', () => {
  assert.equal(shellFor('fish', '/bin/zsh'), 'fish');
  assert.equal(shellFor(undefined, '/usr/local/bin/bash'), 'bash');
  assert.equal(shellFor(undefined, '/bin/tcsh'), 'zsh');
  assert.equal(shellFor(undefined, undefined), 'zsh');
});

test('every shell gets a periscope function that wraps crew periscope', () => {
  for (const sh of SHELLS) {
    const script = shellInitScript(sh);
    assert.match(script, /periscope/);
    assert.match(script, /crew periscope up --json/);
    assert.match(script, /--git-common-dir/);
  }
});

// The function is exercised in a real bash against a stub `crew`, so what is checked is the
// directory change and the exit status, not the script's text.
test('periscope up lands in the worktree and down returns to the checkout (bash)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'shell-init-')));
  const bin = join(root, 'bin');
  const wt = join(root, 'wt');
  const co = join(root, 'co');
  mkdirSync(bin); mkdirSync(wt); mkdirSync(join(co, '.git'), { recursive: true });
  writeFileSync(join(bin, 'crew'), `#!/bin/sh
case "$2" in
  up) echo '{"event":"preview","message":"preview at http://x"}' >&2
      echo '{"event":"done","ticket":"T-1","worktree":"${wt}","url":"http://localhost:1/"}' ;;
  down) echo '{"event":"row","message":"row is kept"}' >&2 ;;
esac
`);
  chmodSync(join(bin, 'crew'), 0o755);
  // `git rev-parse` in the stubbed checkout: a stub git answers with the checkout's .git.
  writeFileSync(join(bin, 'git'), `#!/bin/sh\\necho '${join(co, '.git')}'\\n`.replace(/\\n/g, '\n'));
  chmodSync(join(bin, 'git'), 0o755);
  const script = `${shellInitScript('bash')}
cd "${root}"
periscope up --no-open || exit 11
pwd
periscope down --keep || exit 12
pwd
`;
  const r = spawnSync('bash', ['-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['http://localhost:1/', wt, wt, co]);
  assert.match(r.stderr, /preview at http:\/\/x/);
});

test('periscope up fails and stays put when crew prints no done object (bash)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'shell-init-')));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'crew'), '#!/bin/sh\necho "crew periscope: no" >&2\nexit 1\n');
  chmodSync(join(bin, 'crew'), 0o755);
  const r = spawnSync('bash', ['-c', `${shellInitScript('bash')}\ncd "${root}"\nperiscope up; echo "rc=$?"; pwd`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.deepEqual(r.stdout.trim().split('\n'), ['rc=1', root]);
  assert.match(r.stderr, /crew periscope: no/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleRepos, probePushAuth, toolChecks, isPrBased, isSshRemote, formatPushAuth } from '../src/doctor-checks.ts';

const fail = (msg: string) => () => { throw Object.assign(new Error('x'), { stderr: msg }); };

test('HTTPS remote without credentials fails with the gh hint', () => {
  const r = probePushAuth({ dir: '/x', remote: 'origin', remoteUrl: 'https://github.com/a/b.git' }, fail('fatal: could not read Username for https://github.com: terminal prompts disabled'));
  assert.equal(r.state, 'failed');
  if (r.state === 'failed') {
    assert.match(r.hint, /gh auth login.*gh auth setup-git/);
    assert.match(r.detail, /could not read Username/);
  }
});

test('SSH remote without a key fails with the ssh-add hint', () => {
  const r = probePushAuth({ dir: '/x', remote: 'origin', remoteUrl: 'git@github.com:a/b.git' }, fail('git@github.com: Permission denied (publickey).'));
  assert.equal(r.state, 'failed');
  if (r.state === 'failed') assert.match(r.hint, /ssh-add/);
});

test('success is ok, and the probe runs non-interactively', () => {
  let seen: NodeJS.ProcessEnv = {};
  let args: string[] = [];
  const r = probePushAuth({ dir: '/x', remote: 'origin', remoteUrl: 'https://h/a.git' }, (_c, a, env) => { seen = env; args = a; });
  assert.equal(r.state, 'ok');
  assert.equal(seen.GIT_TERMINAL_PROMPT, '0');
  assert.deepEqual(args.slice(0, 3), ['push', '--dry-run', 'origin']);
});

test('--offline makes no git call and is labeled', () => {
  const r = probePushAuth({ dir: '/x', remote: 'origin', remoteUrl: 'https://h/a.git', offline: true }, () => { throw new Error('called'); });
  assert.equal(r.state, 'skipped');
  assert.match(formatPushAuth('r', r), /skipped \(--offline\)/);
});

test('gh is required on a PR-based repo and optional otherwise', () => {
  const none = () => undefined;
  const pr = toolChecks({ prBased: true, hostPassengers: false, hooksMentionNode: false }, none);
  const plain = toolChecks({ prBased: false, hostPassengers: false, hooksMentionNode: false }, none);
  assert.equal(pr.find((t) => t.name === 'gh')!.need, 'required');
  assert.equal(plain.find((t) => t.name === 'gh')!.need, 'optional');
  assert.equal(toolChecks({ prBased: false, hostPassengers: true, hooksMentionNode: true }, none).find((t) => t.name === 'docker')!.need, 'required');
});

test('PR-based detection and remote shape', () => {
  assert.equal(isPrBased({ pr: 'gh pr create' }), true);
  assert.equal(isPrBased({ merged: 'gh pr list | grep -q n' }), true);
  assert.equal(isPrBased({}), false);
  assert.equal(isSshRemote('git@github.com:a/b.git'), true);
  assert.equal(isSshRemote('https://github.com/a/b.git'), false);
});

test('one repo failing to resolve is reported and does not drop its siblings', async () => {
  const { settled, errors } = await settleRepos(['good', 'bad', 'also-good'], (n) => n, async (n) => {
    if (n === 'bad') throw new Error('release.mode "local" needs hooks.deploy');
    return n.toUpperCase();
  });
  assert.deepEqual(settled, ['GOOD', 'ALSO-GOOD']);
  assert.deepEqual(errors, [{ repo: 'bad', detail: 'release.mode "local" needs hooks.deploy' }]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOOK_NAMES, TOP_LEVEL, MODES, SANDBOX_KEYS } from '../src/repo-config.ts';
import { TOOLCHAIN_HOSTS } from '../src/sandbox-policy.ts';
import { readRepoSetupPrompt } from '../src/repo-setup-prompt.ts';

const ROOT = join(import.meta.dirname, '..');
const PROMPT = readFileSync(join(ROOT, 'docs', 'repo-setup-prompt.md'), 'utf8');

/**
 * CREW-3310: the prompt a person hands a coding agent carries its own reference
 * of what `.crew.yaml` accepts. When the loader learns a key, the prompt must
 * learn it too, or the agent writes a file that leaves it out (or never offers
 * it). Every list is checked as a backticked word, so a key that only appears
 * inside another word does not count.
 */
const SANDBOX_DEFERRED = 'the sandbox feature is still being developed, so the prompt leaves the section to the spec';
const DEFERRED_TO_SPEC = {
  // Keys the prompt deliberately does not reference table for, each with why.
  topLevel: new Set<string>([]),
  hooks: new Set<string>([]),
  sandboxKeys: new Map<string, string>(['image', 'packages', 'setup', 'warm', 'hosts', 'toolchains'].map((k) => [k, SANDBOX_DEFERRED])),
  sandboxToolchains: SANDBOX_DEFERRED,
};

/** Names `list` entries that do not appear in the prompt as a backticked word, minus the allow-list. */
function missingFrom(prompt: string, list: Iterable<string>, deferred: Set<string>): string[] {
  return [...list].filter((k) => !deferred.has(k) && !new RegExp(`\`${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\`.]`).test(prompt));
}

test('the prompt names every hook the loader accepts', () => {
  assert.deepEqual(missingFrom(PROMPT, HOOK_NAMES, DEFERRED_TO_SPEC.hooks), []);
});

test('the prompt names every top-level key the loader accepts', () => {
  assert.deepEqual(missingFrom(PROMPT, TOP_LEVEL, DEFERRED_TO_SPEC.topLevel), []);
});

test('the prompt names every release mode', () => {
  assert.deepEqual(missingFrom(PROMPT, MODES, new Set()), []);
});

test('the prompt names every sandbox key', () => {
  assert.deepEqual(missingFrom(PROMPT, SANDBOX_KEYS, new Set(DEFERRED_TO_SPEC.sandboxKeys.keys())), []);
});

test('the prompt names every sandbox toolchain', () => {
  assert.ok(DEFERRED_TO_SPEC.sandboxToolchains);
  assert.deepEqual(missingFrom(PROMPT, Object.keys(TOOLCHAIN_HOSTS), new Set(Object.keys(TOOLCHAIN_HOSTS))), []);
});

test('the check fails, naming the key, for a key the prompt lacks', () => {
  assert.deepEqual(missingFrom(PROMPT, [...HOOK_NAMES, 'made_up_hook'], new Set()), ['made_up_hook']);
});

test('readRepoSetupPrompt returns the file as it reads', () => {
  assert.equal(readRepoSetupPrompt(ROOT), PROMPT);
});

test('`crew repos prompt` prints the file exactly, with no config present', () => {
  const env = { ...process.env, CREW_CONFIG: join(ROOT, 'does-not-exist.yaml'), XDG_CONFIG_HOME: join(ROOT, 'no-xdg'), HOME: join(ROOT, 'no-home') };
  const out = spawnSync(process.execPath, ['--experimental-strip-types', join(ROOT, 'src', 'cli.ts'), 'repos', 'prompt'], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, PROMPT);
  const json = spawnSync(process.execPath, ['--experimental-strip-types', join(ROOT, 'src', 'cli.ts'), 'repos', 'prompt', '--json'], { env, encoding: 'utf8' });
  const parsed = JSON.parse(json.stdout) as { prompt: string; version: string };
  assert.equal(parsed.prompt, PROMPT);
  assert.equal(parsed.version, (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CREW, CREW_ENV } from './helpers/crew-bin.ts';

const run = promisify(execFile);

/**
 * ISSUE-980: a session running with `CREW_LANE_ROLE` set (every
 * crew-launched agent session has it — see `agent.ts`'s `planAgentRun`)
 * must be refused outright before it can run a command that writes to this
 * ship's real `crew.yaml`/`stateDir`, regardless of whether a real config
 * even exists — CREW-978's incident was exactly this class of command run
 * "as a manual sanity check".
 *
 * `CREW_CONFIG` is deliberately left unset/pointed at nothing real: the
 * refusal must happen before config loading, not because loading failed.
 */
async function attempt(args: string[], env: Record<string, string | undefined> = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CREW, ...args], {
      env: { ...process.env, ...CREW_ENV, CREW_CONFIG: '/nonexistent/crew.yaml', ...env },
      timeout: 15_000,
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

for (const args of [
  ['connect'],
  ['agents', 'sync'],
  ['skills', 'sync'],
  ['install'],
  ['uninstall'],
  ['release'],
  ['merge'],
  ['deploy'],
]) {
  test(`refuses "crew ${args.join(' ')}" inside an agent session`, async () => {
    const { code, out } = await attempt(args, { CREW_LANE_ROLE: 'qa' });
    assert.equal(code, 2);
    assert.match(out, /refusing to run/);
    assert.match(out, new RegExp(args.join(' ')));
  });
}

test('the same commands are NOT refused outside an agent session (no CREW_LANE_ROLE)', async () => {
  const { out } = await attempt(['connect'], { CREW_LANE_ROLE: undefined });
  assert.doesNotMatch(out, /refusing to run/);
});

test('"crew sync" — a session\'s own legitimate per-ticket call — is never refused', async () => {
  const { out } = await attempt(['sync'], { CREW_LANE_ROLE: 'dev' });
  assert.doesNotMatch(out, /refusing to run/);
});

test('read-only commands (poll, status, doctor) are never refused', async () => {
  for (const args of [['poll'], ['status'], ['doctor']]) {
    const { out } = await attempt(args, { CREW_LANE_ROLE: 'dev' });
    assert.doesNotMatch(out, /refusing to run/, `crew ${args.join(' ')} must not be refused`);
  }
});

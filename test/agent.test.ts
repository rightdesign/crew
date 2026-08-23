import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  allowedTools, scrubbedEnv, BILLING_VARS_TO_UNSET, assemblePrompt,
  planAgentRun, describePlan, AgentError, DIGEST_MAX_AGE_SECONDS,
} from '../src/agent.ts';

function rig() {
  const home = mkdtempSync(join(tmpdir(), 'crew-home-'));
  mkdirSync(join(home, 'prompts'), { recursive: true });
  writeFileSync(join(home, 'prompts', 'common.md'), 'SHARED POLICY\n');
  for (const r of ['dev', 'design', 'qa']) {
    writeFileSync(join(home, 'prompts', `lane-${r}.md`), `BRIEF ${r}\n`);
  }
  const state = mkdtempSync(join(tmpdir(), 'crew-state-'));
  const conn = { name: 'proj', dir: '/tmp/proj' } as any;
  const ship = { agent: { bin: '/bin/echo', model: 'claude-sonnet-5' } } as any;
  return { home, state, conn, ship };
}

test('QA gets no Edit — bouncing back is the path of least resistance', () => {
  assert.ok(!allowedTools('qa').includes('Edit'));
  assert.ok(allowedTools('qa').includes('Write'));   // throwaway verification scripts
  assert.ok(allowedTools('qa').includes('Bash'));    // git, dev servers, Playwright
  assert.ok(allowedTools('dev').includes('Edit'));
});

test('only the design role gets Skill and Artifact', () => {
  assert.ok(allowedTools('design').includes('Skill'));
  assert.ok(allowedTools('design').includes('Artifact'));
  for (const r of ['dev', 'qa'] as const) {
    assert.ok(!allowedTools(r).includes('Artifact'), `${r} should not publish canvases`);
  }
});

test('every billing variable is removed, not merely unset in config', () => {
  const dirty = {
    PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-leak', ANTHROPIC_AUTH_TOKEN: 't',
    CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_MODEL: 'other', HOME: '/home/x',
  };
  const clean = scrubbedEnv(dirty);
  for (const v of BILLING_VARS_TO_UNSET) assert.ok(!(v in clean), `${v} survived`);
  assert.equal(clean.PATH, '/usr/bin');   // everything else is preserved
  assert.equal(clean.HOME, '/home/x');
});

test('the roster leads the prompt, then policy, then brief, then queue', () => {
  const p = assemblePrompt({ roster: 'ROSTER', common: 'POLICY\n', brief: 'BRIEF', digest: 'QUEUE' });
  assert.ok(p.indexOf('ROSTER') < p.indexOf('POLICY'));
  assert.ok(p.indexOf('POLICY') < p.indexOf('BRIEF'));
  assert.ok(p.indexOf('BRIEF') < p.indexOf('QUEUE'));
});

test('a plan is fully decided without running anything', () => {
  const { home, state, conn, ship } = rig();
  const plan = planAgentRun({ role: 'dev', conn, ship, crewHome: home, stateDir: state, roster: 'R' });
  assert.equal(plan.cwd, '/tmp/proj');
  assert.equal(plan.bin, '/bin/echo');
  assert.deepEqual(plan.args, ['-p', '--allowedTools', 'Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', '--model', 'claude-sonnet-5']);
  assert.match(plan.prompt, /R[\s\S]*SHARED POLICY[\s\S]*BRIEF dev/);
  assert.equal(plan.digestAttached, false);
  assert.match(describePlan(plan), /prompt:\s+\d+ bytes on stdin \(never argv\)/);
});

test('a fresh digest is attached; a stale one is ignored', () => {
  const { home, state, conn, ship } = rig();
  const digest = join(state, 'digest-proj-dev.md');
  writeFileSync(digest, '## Current queue\n');

  const fresh = planAgentRun({ role: 'dev', conn, ship, crewHome: home, stateDir: state, roster: 'R' });
  assert.equal(fresh.digestAttached, true);
  assert.match(fresh.prompt, /## Current queue/);

  // age it past the cutoff — acting on a stale queue is worse than rebuilding
  const old = (Date.now() - (DIGEST_MAX_AGE_SECONDS + 60) * 1000) / 1000;
  utimesSync(digest, old, old);
  const stale = planAgentRun({ role: 'dev', conn, ship, crewHome: home, stateDir: state, roster: 'R' });
  assert.equal(stale.digestAttached, false);
  assert.doesNotMatch(stale.prompt, /## Current queue/);
  assert.ok(stale.digestAgeSeconds! > DIGEST_MAX_AGE_SECONDS);
});

test('digests are per connection AND per role — one ship, several projects', () => {
  const { home, state, conn, ship } = rig();
  writeFileSync(join(state, 'digest-proj-qa.md'), 'QA QUEUE\n');
  const qa = planAgentRun({ role: 'qa', conn, ship, crewHome: home, stateDir: state, roster: 'R' });
  const dev = planAgentRun({ role: 'dev', conn, ship, crewHome: home, stateDir: state, roster: 'R' });
  assert.equal(qa.digestAttached, true);
  assert.equal(dev.digestAttached, false);   // not the other role's queue
});

test('a missing brief refuses the run rather than running unscoped', () => {
  const { home, state, conn, ship } = rig();
  assert.throws(
    () => planAgentRun({ role: 'triage', conn, ship, crewHome: home, stateDir: state, roster: 'R' }),
    (e: Error) => {
      assert.ok(e instanceof AgentError);
      assert.match(e.message, /refusing to run an unscoped session/);
      return true;
    },
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  allowedTools, DISALLOWED_TOOLS, scrubbedEnv, BILLING_VARS_TO_UNSET, assemblePrompt,
  planAgentRun, describePlan, spawnAgent, AgentError, DIGEST_MAX_AGE_SECONDS,
} from '../src/agent.ts';
import { Emitter } from '../src/events.ts';

const FAKE_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude-stream.mjs');

function rig() {
  const home = mkdtempSync(join(tmpdir(), 'crew-home-'));
  mkdirSync(join(home, 'prompts'), { recursive: true });
  writeFileSync(join(home, 'prompts', 'common.md'), 'SHARED POLICY\n');
  for (const r of ['dev', 'design', 'qa']) {
    writeFileSync(join(home, 'prompts', `lane-${r}.md`), `BRIEF ${r}\n`);
  }
  const state = mkdtempSync(join(tmpdir(), 'crew-state-'));
  const route = { route: 'test/proj', dir: '/tmp/proj' } as any;
  const ship = { agent: { bin: '/bin/echo', model: 'claude-sonnet-5' } } as any;
  return { home, state, route, ship };
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

test('the deny list blocks the obvious destructive/exfiltration shapes', () => {
  assert.ok(DISALLOWED_TOOLS.some((p) => p.startsWith('Bash(rm -rf')));
  assert.ok(DISALLOWED_TOOLS.some((p) => p.includes('git push --force')));
  assert.ok(DISALLOWED_TOOLS.some((p) => p.includes('| sh')));
  assert.ok(DISALLOWED_TOOLS.some((p) => p.includes('sudo')));
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

test('the roster leads, then environment, then policy, then brief, then queue', () => {
  const p = assemblePrompt({
    roster: 'ROSTER', environment: 'ENVIRONMENT', common: 'POLICY\n', brief: 'BRIEF', digest: 'QUEUE',
  });
  assert.ok(p.indexOf('ROSTER') < p.indexOf('ENVIRONMENT'));
  assert.ok(p.indexOf('ENVIRONMENT') < p.indexOf('POLICY'));
  assert.ok(p.indexOf('POLICY') < p.indexOf('BRIEF'));
  assert.ok(p.indexOf('BRIEF') < p.indexOf('QUEUE'));
});

test('a plan is fully decided without running anything', () => {
  const { home, state, route, ship } = rig();
  const plan = planAgentRun({ role: 'dev', route, ship, crewHome: home, stateDir: state, roster: 'R', environment: 'ENV', cycle: 'c1' });
  assert.equal(plan.cwd, '/tmp/proj');
  assert.equal(plan.bin, '/bin/echo');
  assert.deepEqual(plan.args, [
    '-p', '--allowedTools', 'Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob',
    '--disallowedTools', ...DISALLOWED_TOOLS,
    '--model', 'claude-sonnet-5',
    '--output-format', 'stream-json', '--verbose',
  ]);
  assert.match(plan.prompt, /R[\s\S]*SHARED POLICY[\s\S]*BRIEF dev/);
  assert.equal(plan.digestAttached, false);
  assert.match(describePlan(plan), /prompt:\s+\d+ bytes on stdin \(never argv\)/);
});

test('a diverged prompt replaces common+brief wholesale, rather than being appended alongside them', () => {
  const { home, state, route, ship } = rig();
  const plan = planAgentRun({
    role: 'dev', route, ship, crewHome: home, stateDir: state, roster: 'R', environment: 'ENV', cycle: 'c1',
    divergedPrompt: 'CUSTOM ADMIN PROMPT',
  });
  assert.match(plan.prompt, /R[\s\S]*ENV[\s\S]*CUSTOM ADMIN PROMPT/);
  assert.ok(!plan.prompt.includes('SHARED POLICY'), 'the local common.md must not survive alongside a diverged prompt');
  assert.ok(!plan.prompt.includes('BRIEF dev'), 'the local lane brief must not survive alongside a diverged prompt');
});

test('the stream path is derived from route, role and cycle, and shown by --dry-run', () => {
  const { home, state, route, ship } = rig();
  const plan = planAgentRun({
    role: 'dev', route, ship, crewHome: home, stateDir: state, roster: 'R', environment: 'ENV',
    cycle: '20260825120000', ticket: 'ISSUE-401',
  });
  assert.equal(plan.streamPath, join(state, 'streams', 'test-proj-dev-20260825120000.jsonl'));
  assert.equal(plan.eventsPath, join(state, 'streams', 'test-proj-dev-20260825120000.events.jsonl'));
  assert.equal(plan.route, 'test-proj');
  assert.equal(plan.ticket, 'ISSUE-401');
  assert.equal(plan.model, 'claude-sonnet-5');
  assert.match(describePlan(plan), /stream:\s+.*test-proj-dev-20260825120000\.jsonl/);
});

test('a fresh digest is attached; a stale one is ignored', () => {
  const { home, state, route, ship } = rig();
  const digest = join(state, 'digest-test-proj-dev.md');
  writeFileSync(digest, '## Current queue\n');

  const fresh = planAgentRun({ role: 'dev', route, ship, crewHome: home, stateDir: state, roster: 'R', environment: 'ENV', cycle: 'c1' });
  assert.equal(fresh.digestAttached, true);
  assert.match(fresh.prompt, /## Current queue/);

  // age it past the cutoff — acting on a stale queue is worse than rebuilding
  const old = (Date.now() - (DIGEST_MAX_AGE_SECONDS + 60) * 1000) / 1000;
  utimesSync(digest, old, old);
  const stale = planAgentRun({ role: 'dev', route, ship, crewHome: home, stateDir: state, roster: 'R', environment: 'ENV', cycle: 'c1' });
  assert.equal(stale.digestAttached, false);
  assert.doesNotMatch(stale.prompt, /## Current queue/);
  assert.ok(stale.digestAgeSeconds! > DIGEST_MAX_AGE_SECONDS);
});

test('digests are per route AND per role — one ship, several projects', () => {
  const { home, state, route, ship } = rig();
  writeFileSync(join(state, 'digest-test-proj-qa.md'), 'QA QUEUE\n');
  const qa = planAgentRun({ role: 'qa', route, ship, crewHome: home, stateDir: state, roster: 'R', environment: 'ENV', cycle: 'c1' });
  const dev = planAgentRun({ role: 'dev', route, ship, crewHome: home, stateDir: state, roster: 'R', environment: 'ENV', cycle: 'c1' });
  assert.equal(qa.digestAttached, true);
  assert.equal(dev.digestAttached, false);   // not the other role's queue
});

test('a plan carries no agentLog target when the route has never been connected', () => {
  const { home, state, route, ship } = rig();
  const plan = planAgentRun({
    role: 'dev', route, ship, crewHome: home, stateDir: state, roster: 'R', environment: 'ENV',
    apiKey: 'k', cycle: 'c1',
  });
  assert.equal(plan.agentLog, undefined);
});

test('a resolved route with a synced persona carries a full agentLog target', () => {
  const { home, state, ship } = rig();
  const route = {
    route: 'test/proj', dir: '/tmp/proj', baseUrl: 'https://example.test',
    resolved: { workspaceId: 'ws-1', agentPersonas: { dev: { agentId: 'agent-9', lastSyncedUpdatedAt: 't' } } },
  } as any;
  const plan = planAgentRun({
    role: 'dev', route, ship: { ...ship, userAgent: 'crew-test' }, crewHome: home, stateDir: state,
    roster: 'R', environment: 'ENV', apiKey: 'k', cycle: 'c1',
  });
  assert.deepEqual(plan.agentLog, {
    baseUrl: 'https://example.test', workspaceId: 'ws-1', apiKey: 'k', userAgent: 'crew-test', agentId: 'agent-9',
  });
});

test('a resolved route with no synced persona for this role still reports, with no agentId', () => {
  const { home, state, ship } = rig();
  const route = {
    route: 'test/proj', dir: '/tmp/proj', baseUrl: 'https://example.test',
    resolved: { workspaceId: 'ws-1' },
  } as any;
  const plan = planAgentRun({
    role: 'dev', route, ship: { ...ship, userAgent: 'crew-test' }, crewHome: home, stateDir: state,
    roster: 'R', environment: 'ENV', apiKey: 'k', cycle: 'c1',
  });
  assert.equal(plan.agentLog?.agentId, undefined);
  assert.equal(plan.agentLog?.workspaceId, 'ws-1');
});

test('a missing brief refuses the run rather than running unscoped', () => {
  const { home, state, route, ship } = rig();
  assert.throws(
    () => planAgentRun({ role: 'triage', route, ship, crewHome: home, stateDir: state, roster: 'R', environment: 'ENV', cycle: 'c1' }),
    (e: Error) => {
      assert.ok(e instanceof AgentError);
      assert.match(e.message, /refusing to run an unscoped session/);
      return true;
    },
  );
});

test('spawnAgent saves the raw stream verbatim, maps blocks onto their own sink, and folds the result into the finish event', async () => {
  const { home, state, route, ship } = rig();
  const plan = planAgentRun({
    role: 'dev', route, ship: { agent: { bin: 'node', model: 'claude-sonnet-5' } } as any,
    crewHome: home, stateDir: state, roster: 'R', environment: 'ENV', cycle: 'c1', ticket: 'ISSUE-401',
  });
  plan.bin = process.execPath;
  plan.args = [FAKE_CLAUDE];
  plan.cwd = state;   // real directory — /tmp/proj (from rig()) does not exist

  const lines: string[] = [];
  const emit = new Emitter({ route: 'proj', cycleId: 'c1', console: (l) => lines.push(l) });
  emit.enter('agent', 'dev');

  const result = await spawnAgent(plan, emit);
  assert.equal(result.code, 0);

  // The raw NDJSON is saved unmodified, malformed line included — it is
  // the post-mortem artifact, not a filtered view.
  const raw = readFileSync(plan.streamPath, 'utf8').trim().split('\n');
  assert.equal(raw.length, 6);
  assert.ok(raw.includes('not valid json — must not kill the run'));

  // Thought/tool/text blocks landed on their OWN sink, not the shared one —
  // a long session is thousands of these and events.jsonl is not the place.
  // A `thought` block also gets a paired `cycle` event (ISSUE-481) — the
  // same text, correlated with its Agent Log Cycle index, for a live
  // consumer (crew-macos) that wants "which numbered cycle" alongside the
  // raw thinking text `thought` already carries.
  const mapped = readFileSync(plan.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(mapped.map((e) => e.data.kind), ['thought', 'cycle', 'tool', 'text']);
  // The thought/text blocks must carry their actual content verbatim, not
  // just a bare kind marker — a client tailing eventsPath live otherwise
  // has to fall back to parsing the whole raw transcript.
  assert.equal(mapped[0].data.text, 'let me look');
  assert.equal(mapped[1].data.text, 'let me look');
  assert.equal(mapped[1].data.cycleIndex, 0);
  assert.equal(mapped[2].data.tool, 'Bash');
  assert.equal(mapped[2].data.target, 'ls');
  assert.equal(mapped[3].data.text, 'All done.');
  for (const e of mapped) {
    assert.equal(e.step, 'agent');
    assert.equal(e.role, 'dev');
    assert.equal(e.ticket, 'ISSUE-401');
  }
  assert.ok(!lines.some((l) => l.includes('let me look')), 'a thought must not reach the shared console/log sink');

  // The sidecar is cheap to read without parsing the whole transcript.
  const meta = JSON.parse(readFileSync(`${plan.streamPath}.meta.json`, 'utf8'));
  assert.equal(meta.route, 'test-proj');
  assert.equal(meta.role, 'dev');
  assert.equal(meta.ticket, 'ISSUE-401');
  assert.equal(meta.exitCode, 0);
  assert.equal(meta.sessionId, 'sess-1');
  assert.equal(meta.numTurns, 2);

  // The one shared, low-volume event this run does write carries the result.
  const finish = lines.find((l) => l.includes('agent run finished'));
  assert.ok(finish);
});

/** Same mockFetch shape as connect.test.ts / agent-log.test.ts, keyed by method+pathname. */
function mockFetch(routes: Record<string, unknown>) {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ key: string; body: unknown }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    calls.push({ key, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (!(key in routes)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = originalFetch; }, calls };
}

test('spawnAgent reports the run as one Agent Log row, and its one thinking block as one cycle', async (t) => {
  const { home, state, ship } = rig();
  const route = {
    route: 'test/proj', dir: '/tmp/proj', baseUrl: 'https://example.test',
    resolved: { workspaceId: 'ws-1', agentPersonas: { dev: { agentId: 'agent-9', lastSyncedUpdatedAt: 't' } } },
  } as any;
  const plan = planAgentRun({
    role: 'dev', route, ship: { agent: { bin: 'node', model: 'claude-sonnet-5' }, userAgent: 'crew-test' } as any,
    crewHome: home, stateDir: state, roster: 'R', environment: 'ENV', apiKey: 'k', cycle: 'c1', ticket: 'ISSUE-401',
  });
  plan.bin = process.execPath;
  plan.args = [FAKE_CLAUDE];
  plan.cwd = state;

  const { restore, calls } = mockFetch({
    'POST /api/workspaces/ws-1/agents/log': { id: 'log-1' },
    'POST /api/workspaces/ws-1/agents/log/log-1/cycles': { id: 'cycle-1' },
  });
  t.after(restore);

  const emit = new Emitter({ route: 'proj', cycleId: 'c1', console: () => {} });
  emit.enter('agent', 'dev');
  const result = await spawnAgent(plan, emit);
  assert.equal(result.code, 0);

  assert.equal(calls.length, 2);
  const logCall = calls[0]!;
  assert.equal(logCall.key, 'POST /api/workspaces/ws-1/agents/log');
  assert.deepEqual(logCall.body, {
    agentId: 'agent-9', ticketReference: 'ISSUE-401', outcome: 'success',
    startedAt: (logCall.body as any).startedAt, finishedAt: (logCall.body as any).finishedAt,
    source: 'client', client: 'crew', model: 'claude-sonnet-5', costUsd: 0.0042,
  });
  const cycleCall = calls[1]!;
  assert.equal(cycleCall.key, 'POST /api/workspaces/ws-1/agents/log/log-1/cycles');
  assert.deepEqual(cycleCall.body, {
    cycleIndex: 0, occurredAt: (cycleCall.body as any).occurredAt, thinking: 'let me look',
  });
});

test('spawnAgent warns but still resolves when reporting the agent log fails', async (t) => {
  const { home, state, ship } = rig();
  const route = {
    route: 'test/proj', dir: '/tmp/proj', baseUrl: 'https://example.test',
    resolved: { workspaceId: 'ws-1' },
  } as any;
  const plan = planAgentRun({
    role: 'dev', route, ship: { agent: { bin: 'node', model: 'claude-sonnet-5' }, userAgent: 'crew-test' } as any,
    crewHome: home, stateDir: state, roster: 'R', environment: 'ENV', apiKey: 'k', cycle: 'c2',
  });
  plan.bin = process.execPath;
  plan.args = [FAKE_CLAUDE];
  plan.cwd = state;

  const { restore } = mockFetch({});   // every call 404s
  t.after(restore);

  const lines: string[] = [];
  const emit = new Emitter({ route: 'proj', cycleId: 'c2', console: (l) => lines.push(l) });
  emit.enter('agent', 'dev');
  const result = await spawnAgent(plan, emit);
  assert.equal(result.code, 0);
  assert.ok(lines.some((l) => l.includes('could not report agent log')));
});

test('spawnAgent never dies on a malformed line, and closes cleanly', async () => {
  const { home, state, route, ship } = rig();
  const plan = planAgentRun({
    role: 'dev', route, ship, crewHome: home, stateDir: state, roster: 'R', environment: 'ENV', cycle: 'c2',
  });
  plan.bin = process.execPath;
  plan.args = [FAKE_CLAUDE];
  plan.cwd = state;   // real directory — /tmp/proj (from rig()) does not exist
  const emit = new Emitter({ route: 'proj', cycleId: 'c2', console: () => {} });
  emit.enter('agent', 'dev');
  const result = await spawnAgent(plan, emit);
  assert.equal(result.code, 0);
  assert.ok(existsSync(plan.streamPath));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import { resolveRepoConfig } from '../src/repo-config.ts';
import { HandoffTranscriptTracker } from '../src/handoff-transcript.ts';
import { planAgentRun, spawnAgent } from '../src/agent.ts';
import { Emitter } from '../src/events.ts';
import { listPendingHandoffs, replayPendingHandoffs, writePendingHandoff, type PendingHandoff, type PendingWriter } from '../src/pending-handoff.ts';
import { buildingDigest } from '../src/digest.ts';
import type { Ticket } from '../src/tracker.ts';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude-handoff-502.mjs');
const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function lines(fixtureOut: string) { return fixtureOut.trim().split('\n').map((l) => JSON.parse(l)); }
const use = (id: string, name: string, input: unknown) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id: string, content: string, is_error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content }] } });
const STATUS = 'mcp__tablation__records_controller_update';

test('transcript: a status write that got a 502 and never succeeded is a pending hand-off', () => {
  const t = new HandoffTranscriptTracker();
  for (const l of [use('a', STATUS, { recordId: 'r1', body: { status: 'fixed' } }), res('a', 'HTTP 502 Bad Gateway')]) t.feed(l);
  assert.equal(t.pending()?.ticketRecordId, 'r1');
  assert.deepEqual(t.pending()?.patch, { status: 'fixed' });
});

test('transcript: a later success, or a 4xx refusal, is not pending', () => {
  const ok = new HandoffTranscriptTracker();
  for (const l of [use('a', STATUS, { recordId: 'r1', body: { status: 'fixed' } }), res('a', '502'), use('b', STATUS, { recordId: 'r1', body: { status: 'fixed' } }), res('b', '{"id":"r1"}')]) ok.feed(l);
  assert.equal(ok.pending(), null);
  const refused = new HandoffTranscriptTracker();
  for (const l of [use('a', STATUS, { recordId: 'r1', body: { status: 'fixed' } }), res('a', '422 resolution note required', true)]) refused.feed(l);
  assert.equal(refused.pending(), null);
});

function rig() {
  const home = mkdtempSync(join(tmpdir(), 'crew-home-'));
  const personas = join(home, 'prompts', 'personas');
  mkdirSync(personas, { recursive: true });
  writeFileSync(join(personas, 'common.md'), 'SHARED\n');
  for (const r of ['dev', 'design', 'qa', 'triage']) writeFileSync(join(personas, `lane-${r}.md`), `BRIEF ${r}\n`);
  const state = mkdtempSync(join(tmpdir(), 'crew-state-'));
  return { state, route: { route: 'test/proj', dir: '/tmp/proj', promptsDir: join(home, 'prompts') } as any };
}

test('a run whose hand-off write 502s leaves a pending record, handoff: pending in the meta, and says so in the finish event', async () => {
  const { state, route } = rig();
  const plan = planAgentRun({
    role: 'dev', route, ship: { agent: { bin: 'node', model: 'm' } } as any, stateDir: state, roster: 'R', environment: 'E', cycle: 'c1', ticket: 'ISSUE-9',
  });
  plan.bin = process.execPath; plan.args = [FAKE]; plan.cwd = state;
  const out: string[] = [];
  const emit = new Emitter({ route: 'proj', cycleId: 'c1', console: (l) => out.push(l) });
  emit.enter('agent', 'dev');
  const r = await spawnAgent(plan, emit);
  assert.equal(r.code, 0);
  assert.equal(r.handoffPending, true);
  assert.ok(out.some((l) => l.includes('agent run finished (hand-off pending)')));
  assert.equal(JSON.parse(readFileSync(`${plan.streamPath}.meta.json`, 'utf8')).handoff, 'pending');
  const [rec] = listPendingHandoffs(state);
  assert.equal(rec!.ticketRecordId, 'row-9');
  assert.equal(rec!.comment, 'Hand-off: built and pushed.');
  assert.match(rec!.finalText, /board returned 502/);
});

/** A repo with an origin and a worktree on `crew-9`, pushed at its tip. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'pend-'));
  const dir = join(root, 'repo'); const bare = join(root, 'o.git');
  sh(root, 'init', '-q', '-b', 'main', dir);
  sh(dir, 'config', 'user.email', 't@e.c'); sh(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a'), 'a'); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'base');
  sh(root, 'init', '-q', '--bare', bare); sh(dir, 'remote', 'add', 'origin', bare); sh(dir, 'push', '-q', 'origin', 'main');
  const wt = join(root, 'repo-crew-9');
  sh(dir, 'worktree', 'add', '-q', wt, '-b', 'crew-9');
  writeFileSync(join(wt, 'b'), 'b'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'work');
  sh(wt, 'push', '-q', '--set-upstream', 'origin', 'crew-9');
  return { dir, wt };
}
const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'row-9', issue_id: 'ISSUE-9', issue_tag: 'CREW-9', project_issue_prefix: 'CREW', status: 'in_progress', assignee_id: 'seat-dev', updated_at: '2026-01-01T00:00:00Z', ...over,
});
const record = (over: Partial<PendingHandoff> = {}): PendingHandoff => ({
  version: 1, route: 'proj', role: 'dev', ticket: 'CREW-9', ticketRecordId: 'row-9', patch: { status: 'fixed', assignee_id: null },
  comment: 'Hand-off: built and pushed.', finalText: 'final', streamPath: '/x', createdAt: '2026-10-23T06:00:00.000Z', attempts: 0, nextAttemptAt: '2026-10-23T06:00:00.000Z', ...over,
});
function writer(state: { down: boolean; t: Ticket; calls: string[] }): PendingWriter {
  return {
    async ticket() { if (state.down) throw new Error('HTTP 502'); return state.t; },
    async updateTicket(_id, patch) { state.calls.push(`update ${JSON.stringify(patch)}`); return state.t; },
    async postEvent(_id, body, _m, type) { state.calls.push(`event ${type} ${body}`); },
    async postComment(_id, body) { state.calls.push(`comment ${body}`); },
    async comments() { return []; },
  } as PendingWriter;
}

test('replay: still down leaves the record and warns once; answering replays comment, pushed event and status, then deletes it', async () => {
  const { dir } = repo();
  const stateDir = mkdtempSync(join(tmpdir(), 'pend-state-'));
  writePendingHandoff(stateDir, record());
  const st = { down: true, t: ticket(), calls: [] as string[] };
  const warns: string[] = [];
  const log = { emit: () => {}, warn: (m: string) => { warns.push(m); } };
  const base = { writer: writer(st), contract: DEFAULT_CONTRACT, stateDir, route: 'proj', seats: { dev: 'seat-dev' }, log, checkout: () => ({ dir, cfg: resolveRepoConfig(null, undefined, dir) }) };

  assert.deepEqual(await replayPendingHandoffs({ ...base, now: new Date('2026-10-23T07:00:00Z') }), []);
  assert.equal(listPendingHandoffs(stateDir).length, 1);
  assert.equal(warns.length, 1);
  // Inside the backoff window nothing is attempted; a second failure later does not warn again.
  await replayPendingHandoffs({ ...base, now: new Date('2026-10-23T07:00:10Z') });
  await replayPendingHandoffs({ ...base, now: new Date('2026-10-23T08:00:00Z') });
  assert.equal(warns.length, 1);
  assert.equal(listPendingHandoffs(stateDir).length, 1);

  st.down = false;
  assert.deepEqual(await replayPendingHandoffs({ ...base, now: new Date('2026-10-23T09:00:00Z') }), ['row-9']);
  assert.equal(listPendingHandoffs(stateDir).length, 0);
  assert.equal(st.calls.length, 3);
  assert.match(st.calls[0]!, /^comment Hand-off: built and pushed\./);
  assert.match(st.calls[1]!, /^event pushed pushed [0-9a-f]{40} to origin\/crew-9$/);
  assert.match(st.calls[2]!, /^update .*"status":"fixed"/);
});

test('replay: a ticket that moved on drops the record without writing', async () => {
  const { dir } = repo();
  const stateDir = mkdtempSync(join(tmpdir(), 'pend-state-'));
  writePendingHandoff(stateDir, record());
  const st = { down: false, t: ticket({ status: 'fixed' }), calls: [] as string[] };
  await replayPendingHandoffs({ writer: writer(st), contract: DEFAULT_CONTRACT, stateDir, route: 'proj', seats: { dev: 'seat-dev' }, log: { emit: () => {}, warn: () => {} }, checkout: () => ({ dir, cfg: resolveRepoConfig(null, undefined, dir) }) });
  assert.equal(st.calls.length, 0);
  assert.equal(existsSync(join(stateDir, 'pending-handoffs', 'row-9.json')), false);
});

test('digest: a ticket held by this seat with a pending hand-off carries the previous run\'s final text', () => {
  const t = { id: 'row-9', issue_id: 'ISSUE-9', issue_tag: 'CREW-9', project_issue_prefix: 'CREW', status: 'in_progress', assignee_id: 'seat-dev', updated_at: '2026-10-23T07:00:00Z' } as any;
  const base = { tickets: [t], comments: [], me: 'seat-dev', roster: [], ships: [], myShipId: null, watermark: '', blocked: new Set(), blockerInfo: {} } as any;
  const withPrev = buildingDigest({ ...base, previousRun: () => ({ finalText: 'Built and pushed.', at: '2026-10-23T06:30:00Z' }) });
  assert.match(withPrev, /Your previous run/);
  assert.match(withPrev, /> Built and pushed\./);
  assert.doesNotMatch(buildingDigest(base), /Your previous run/);
});

test('transcript: a successful write that echoes a record mentioning 502 or timeouts is not pending', () => {
  const t = new HandoffTranscriptTracker();
  const echo = JSON.stringify({ id: 'r1', status: 'fixed', description: "the tracker answered 502 ... Unexpected token '<' ... request timed out <html>" });
  for (const l of [use('a', STATUS, { recordId: 'r1', body: { status: 'fixed', assignee_id: null } }), res('a', echo)]) t.feed(l);
  assert.equal(t.pending(), null);
  const envelope = new HandoffTranscriptTracker();
  for (const l of [use('a', STATUS, { recordId: 'r1', body: { status: 'fixed' } }), res('a', '{"message":"Bad Gateway","statusCode":502}')]) envelope.feed(l);
  assert.equal(envelope.pending()?.ticketRecordId, 'r1');
});

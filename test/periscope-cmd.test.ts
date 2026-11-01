import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPeriscopeSidecars, writePeriscopeSidecar, removePeriscopeSidecar } from '../src/periscope-state.ts';
import { readPeriscopePrior, writePeriscopePrior, removePeriscopePrior } from '../src/periscope-cmd.ts';
import {
  parsePeriscopeUpArgs, parseEnvLines, previewUrlFrom, periscopeCaps, runPeriscopeUp, PeriscopeError,
  upOutput, shouldOpen, openerFor, defaultTopic, rowForCwd, type PeriscopeDeps, type PeriscopeUpArgs, type HookResult,
} from '../src/periscope-cmd.ts';

const flags = { isolate: false, json: false };

test('parsePeriscopeUpArgs: one positional is the repo, two are route then repo', () => {
  assert.deepEqual(parsePeriscopeUpArgs(['periscope', 'up', 'synthesis'], { ...flags, topic: ' nav ' }),
    { repo: 'synthesis', topic: 'nav', isolate: false, json: false });
  const a = parsePeriscopeUpArgs(['periscope', 'start', 'issues/issues', 'synthesis'], { ...flags, host: 'h', assignee: 'x', isolate: true });
  assert.equal(a.route, 'issues/issues');
  assert.equal(a.repo, 'synthesis');
  assert.equal(a.host, 'h');
  assert.equal(a.assignee, 'x');
  assert.equal(a.isolate, true);
  assert.throws(() => parsePeriscopeUpArgs(['periscope', 'up', 'a', 'b', 'c'], flags), PeriscopeError);
});

test('parsePeriscopeUpArgs: no positional leaves the repo to the working directory', () => {
  const a = parsePeriscopeUpArgs(['periscope', 'up'], flags);
  assert.equal(a.repo, undefined);
  assert.equal(a.route, undefined);
});

test('parseEnvLines keeps KEY=value lines and drops the rest', () => {
  assert.deepEqual(parseEnvLines('hello\nPORT=3000\n DATABASE_URL="pg://x/y" \nnot a var=1'), { PORT: '3000', DATABASE_URL: 'pg://x/y' });
});

test('previewUrlFrom takes the last line and requires a URL', () => {
  assert.equal(previewUrlFrom('starting\nhttp://box.local:4000/\n\n'), 'http://box.local:4000/');
  assert.equal(previewUrlFrom('http://a\nready'), undefined);
  assert.equal(previewUrlFrom(''), undefined);
});

test('periscopeCaps defaults to 3 and 120 minutes', () => {
  assert.deepEqual(periscopeCaps({}), { max: 3, idleMinutes: 120 });
  assert.deepEqual(periscopeCaps({ maxPeriscopes: 1, periscopeIdleMinutes: 5 }), { max: 1, idleMinutes: 5 });
});

const ARGS: PeriscopeUpArgs = { repo: 'synthesis', topic: 'navigation spacing', isolate: false, json: false };

function harness(over: Partial<PeriscopeDeps> = {}, hooks: Partial<Record<string, HookResult | null>> = {}) {
  const calls: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const comments: string[] = [];
  const envs: Record<string, Record<string, string>> = {};
  const deps: PeriscopeDeps = {
    previewHook: 'start-it',
    hasPeriscopesTable: true,
    liveCount: async () => 0,
    caps: { max: 3, idleMinutes: 120 },
    baseProblem: () => undefined,
    askTopic: async () => undefined,
    fileDraft: async (title) => { calls.push(`file:${title}`); return { id: 'rec1', tag: 'TABL-900', issueId: 'ISSUE-900' }; },
    cutWorktree: () => { calls.push('cut'); return { path: '/w/tablation-tabl-900', branch: 'tabl-900' }; },
    prepare: async () => { calls.push('prepare'); return { code: 0, output: '' }; },
    runHook: async (name, _cwd, env) => {
      calls.push(`hook:${name}`);
      envs[name] = env;
      if (name in hooks) return hooks[name] ?? null;
      if (name === 'ports') return { code: 0, output: 'BACKEND_PORT=30900\n' };
      if (name === 'isolate') return { code: 0, output: 'DATABASE_URL=pg://iso\n' };
      if (name === 'handoff') return { code: 0, output: 'Sign in as a@b' };
      return { code: 0, output: 'booting\nhttp://localhost:40900\n' };
    },
    createRow: async (f) => { rows.push(f); return { id: 'per1' }; },
    comment: async (_id, body) => { comments.push(body); },
    teardown: async () => { calls.push('teardown'); },
    closeDraft: async (_id, note) => { calls.push(`close:${note.split('\n')[0]}`); },
    now: () => new Date('2026-11-01T12:00:00Z'),
    host: 'localhost',
    say: () => {},
    ...over,
  };
  return { deps, calls, rows, comments, envs };
}

test('runPeriscopeUp: files, cuts, prepares, runs hooks in order and records a live row', async () => {
  const h = harness();
  const res = await runPeriscopeUp(h.deps, ARGS);
  assert.deepEqual(h.calls, ['file:Periscope: navigation spacing', 'cut', 'prepare', 'hook:ports', 'hook:handoff', 'hook:preview']);
  assert.deepEqual(res, { ticket: 'TABL-900', ticketRecordId: 'rec1', worktree: '/w/tablation-tabl-900', branch: 'tabl-900', url: 'http://localhost:40900', periscopeRecordId: 'per1' });
  assert.equal(h.rows[0]!.state, 'live');
  assert.equal(h.rows[0]!.isolated, false);
  assert.equal(h.rows[0]!.expires_at, '2026-11-01T14:00:00.000Z');
  assert.equal(h.envs.preview!.CREW_PREVIEW_HOST, 'localhost');
  assert.equal(h.envs.preview!.BACKEND_PORT, '30900');
  assert.equal(h.envs.handoff!.CREW_TICKET, 'TABL-900');
  assert.match(h.comments[0]!, /http:\/\/localhost:40900/);
  assert.match(h.comments[0]!, /Sign in as a@b/);
});

test('runPeriscopeUp: --isolate runs isolate before handoff and records isolated: true', async () => {
  const h = harness();
  await runPeriscopeUp(h.deps, { ...ARGS, isolate: true });
  assert.deepEqual(h.calls.filter((c) => c.startsWith('hook:')), ['hook:ports', 'hook:isolate', 'hook:handoff', 'hook:preview']);
  assert.equal(h.rows[0]!.isolated, true);
  assert.equal(h.envs.handoff!.DATABASE_URL, 'pg://iso');
});

test('runPeriscopeUp: no preview hook refuses before filing anything', async () => {
  const h = harness({ previewHook: undefined });
  await assert.rejects(runPeriscopeUp(h.deps, ARGS), /declares no `preview` hook/);
  assert.deepEqual(h.calls, []);
});

test('runPeriscopeUp: refuses without a Periscopes table, at the cap, without a topic, or on an unsafe base', async () => {
  for (const [over, re] of [
    [{ hasPeriscopesTable: false }, /no Periscopes table/],
    [{ liveCount: async () => 3 }, /maxPeriscopes is 3/],
    [{ baseProblem: () => 'diverged' }, /DO NOT CUT A WORKTREE FROM THIS BASE — diverged/],
  ] as const) {
    const h = harness(over);
    await assert.rejects(runPeriscopeUp(h.deps, ARGS), re);
    assert.deepEqual(h.calls, []);
  }
});

test('runPeriscopeUp: no topic and no prompt defaults to the repo and the date; a prompted topic wins', async () => {
  const h = harness();
  await runPeriscopeUp(h.deps, { ...ARGS, topic: undefined });
  assert.equal(h.calls[0], 'file:Periscope: synthesis, 2026-11-01');
  const p = harness({ askTopic: async () => ' spacing ' });
  await runPeriscopeUp(p.deps, { ...ARGS, topic: undefined });
  assert.equal(p.calls[0], 'file:Periscope: spacing');
});

test('upOutput, shouldOpen, openerFor, defaultTopic', () => {
  const res = { ticket: 'TABL-9', ticketRecordId: 'r', worktree: '/w', branch: 'b', url: 'http://u', periscopeRecordId: 'p' };
  assert.equal(upOutput(res, false), 'TABL-9\n/w\nhttp://u\n');
  assert.equal(upOutput(res, true), 'TABL-9\nhttp://u\n/w\n');
  const base = { open: false, noOpen: false, json: false, terminal: false };
  assert.equal(shouldOpen(base), false);
  assert.equal(shouldOpen({ ...base, terminal: true }), true);
  assert.equal(shouldOpen({ ...base, terminal: true, noOpen: true }), false);
  assert.equal(shouldOpen({ ...base, open: true }), true);
  assert.equal(shouldOpen({ ...base, open: true, json: true }), false);
  assert.equal(openerFor('darwin'), 'open');
  assert.equal(openerFor('linux'), 'xdg-open');
  assert.equal(openerFor('win32'), undefined);
  assert.equal(defaultTopic('crew', new Date('2026-11-01T23:00:00Z')), 'crew, 2026-11-01');
});

test('runPeriscopeUp: a failing preview tears down and closes the draft, writing no row', async () => {
  const h = harness({}, { preview: { code: 3, output: 'boom\n' } });
  await assert.rejects(runPeriscopeUp(h.deps, ARGS), /preview exited 3\nboom/);
  assert.deepEqual(h.calls.slice(-2), ['teardown', 'close:Periscope abandoned: preview exited 3']);
  assert.equal(h.rows.length, 0);
});

test('runPeriscopeUp: a preview that prints no URL is abandoned the same way', async () => {
  const h = harness({}, { preview: { code: 0, output: 'ready\n' } });
  await assert.rejects(runPeriscopeUp(h.deps, ARGS), /printed no URL/);
  assert.ok(h.calls.includes('teardown'));
  assert.equal(h.rows.length, 0);
});

test('runPeriscopeUp: an unusable worktree closes the draft without a teardown', async () => {
  const h = harness({ cutWorktree: () => { throw new PeriscopeError('dirty'); } });
  await assert.rejects(runPeriscopeUp(h.deps, ARGS), /dirty/);
  assert.ok(!h.calls.includes('teardown'));
  assert.ok(h.calls.some((c) => c.startsWith('close:')));
});

test('runPeriscopeUp: a failed progress comment does not undo the periscope', async () => {
  const h = harness({ comment: async () => { throw new Error('403'); } });
  const res = await runPeriscopeUp(h.deps, ARGS);
  assert.equal(res.periscopeRecordId, 'per1');
  assert.ok(!h.calls.includes('teardown'));
});

test('runPeriscopeUp: leaves the local record status reads, and a failure to write it does not undo the periscope', async () => {
  const saved: unknown[] = [];
  const ok = await runPeriscopeUp(harness({ recordLocal: (sc) => { saved.push(sc); } }).deps, ARGS);
  assert.deepEqual(saved, [{
    ticket: 'TABL-900', ticketRecordId: 'rec1', periscopeRecordId: 'per1', repo: 'synthesis',
    worktree: '/w/tablation-tabl-900', branch: 'tabl-900', url: 'http://localhost:40900', host: 'localhost',
    state: 'live', isolated: false, startedAt: '2026-11-01T12:00:00.000Z', lastActivityAt: '2026-11-01T12:00:00.000Z',
    expiresAt: '2026-11-01T14:00:00.000Z',
  }]);
  assert.equal(ok.periscopeRecordId, 'per1');
  const h = harness({ recordLocal: () => { throw new Error('disk full'); } });
  assert.equal((await runPeriscopeUp(h.deps, ARGS)).periscopeRecordId, 'per1');
  assert.ok(!h.calls.includes('teardown'));
});

import {
  parsePeriscopeDownArgs, runPeriscopeDown, prototypeSection, periscopeListEntries, formatPeriscopeList,
  type PeriscopeDownDeps, type PeriscopeRowInfo,
} from '../src/periscope-cmd.ts';

const dflags = { keep: false, discard: false, allowEmpty: false, json: false };
const ROW: PeriscopeRowInfo = {
  id: 'per1', ticketRecordId: 'rec1', ticket: 'TABL-900', number: '900', repo: 'synthesis', state: 'live',
  url: 'http://localhost:40900', worktree: '/w/tablation-tabl-900', branch: 'tabl-900', lastActivityAt: '2026-11-01T11:30:00Z',
};

test('parsePeriscopeDownArgs: needs exactly one of --keep and --discard and a ticket number', () => {
  assert.throws(() => parsePeriscopeDownArgs(['periscope', 'down', '900'], dflags), /exactly one/);
  assert.throws(() => parsePeriscopeDownArgs(['periscope', 'down', '900'], { ...dflags, keep: true, discard: true }), /exactly one/);
  assert.throws(() => parsePeriscopeDownArgs(['periscope', 'down', 'a', 'b', 'c'], { ...dflags, keep: true }), PeriscopeError);
  assert.throws(() => parsePeriscopeDownArgs(['periscope', 'down', 'abc'], { ...dflags, keep: true }), /not a ticket number/);
  assert.deepEqual(parsePeriscopeDownArgs(['periscope', 'end', 'TABL-900'], { ...dflags, discard: true }),
    { number: '900', mode: 'discard', allowEmpty: false, json: false });
  assert.equal(parsePeriscopeDownArgs(['periscope', 'down', 'issues/issues', '900'], { ...dflags, keep: true }).route, 'issues/issues');
});

function downHarness(over: Partial<PeriscopeDownDeps> = {}, rows: PeriscopeRowInfo[] = [ROW]) {
  const calls: string[] = [];
  const patches: Record<string, unknown>[] = [];
  const deps: PeriscopeDownDeps = {
    rowsForTicket: async () => rows,
    hasChanges: () => true,
    commitAll: (_w, m) => { calls.push(`commit:${m}`); },
    push: () => { calls.push('push'); return { sha: 'abc123', remote: 'origin' }; },
    changedFiles: () => [{ path: 'src/a.ts', added: 3, removed: 1 }],
    readTicket: async () => ({ description: 'A periscope.', hasProject: false, hasRepo: true }),
    updateTicket: async (_id, p) => { calls.push(`ticket:${p.status}`); patches.push(p); },
    postPushed: async (_id, sha, rem, br) => { calls.push(`pushed:${sha}:${rem}/${br}`); },
    stopServer: async () => { calls.push('stop'); return 2; },
    removeWorktree: (_w, _b, del) => { calls.push(`remove:${del}`); },
    setRowState: async (_id, s) => { calls.push(`row:${s}`); },
    say: () => {},
    ...over,
  };
  return { deps, calls, patches };
}

test('runPeriscopeDown --keep: commits, pushes, updates the ticket, then tears down and marks the row kept', async () => {
  const h = downHarness();
  const res = await runPeriscopeDown(h.deps, { number: '900', mode: 'keep', allowEmpty: false, json: false });
  assert.deepEqual(h.calls, ['commit:TABL-900 Periscope prototype', 'push', 'ticket:new', 'pushed:abc123:origin/tabl-900', 'stop', 'remove:false', 'row:kept']);
  assert.deepEqual(res, { ticket: 'TABL-900', mode: 'keep', outcome: 'done', state: 'kept', sha: 'abc123' });
  const p = h.patches[0] as { description: string; fillProjectAndRepo: boolean };
  assert.match(p.description, /^A periscope\.\n\n## Prototype/);
  assert.match(p.description, /`src\/a\.ts` \(\+3 −1\)/);
  assert.match(p.description, /may be rewritten/);
  assert.equal(p.fillProjectAndRepo, true);
});

test('runPeriscopeDown --keep: nothing to commit refuses and changes nothing; --allow-empty proceeds without a commit', async () => {
  const h = downHarness({ hasChanges: () => false });
  await assert.rejects(runPeriscopeDown(h.deps, { number: '900', mode: 'keep', allowEmpty: false, json: false }), /nothing to commit/);
  assert.equal(h.calls.length, 0);
  await runPeriscopeDown(h.deps, { number: '900', mode: 'keep', allowEmpty: true, json: false });
  assert.ok(!h.calls.some((c) => c.startsWith('commit')));
  assert.ok(h.calls.includes('push'));
});

test('runPeriscopeDown --keep: a rejected push leaves the ticket, server, worktree and row alone', async () => {
  const h = downHarness({ push: () => { throw new Error('rejected'); } });
  await assert.rejects(runPeriscopeDown(h.deps, { number: '900', mode: 'keep', allowEmpty: false, json: false }), /rejected/);
  assert.ok(!h.calls.some((c) => /^(ticket|stop|remove|row)/.test(c)));
});

test('runPeriscopeDown --keep does not append a second Prototype section', async () => {
  const h = downHarness({ readTicket: async () => ({ description: 'x\n\n## Prototype\nold', hasProject: true, hasRepo: true }) });
  await runPeriscopeDown(h.deps, { number: '900', mode: 'keep', allowEmpty: false, json: false });
  assert.equal((h.patches[0] as { description: string }).description, 'x\n\n## Prototype\nold');
});

test('runPeriscopeDown --discard: stops, removes worktree and branch, closes the ticket, pushes nothing', async () => {
  const h = downHarness();
  const res = await runPeriscopeDown(h.deps, { number: '900', mode: 'discard', allowEmpty: false, json: false });
  assert.deepEqual(h.calls, ['stop', 'remove:true', 'ticket:discarded', 'row:discarded']);
  assert.equal(res.state, 'discarded');
});

test('runPeriscopeDown: an already kept or discarded row is reported and nothing changes', async () => {
  const h = downHarness({}, [{ ...ROW, state: 'kept' }]);
  const res = await runPeriscopeDown(h.deps, { number: '900', mode: 'discard', allowEmpty: false, json: false });
  assert.equal(res.outcome, 'unchanged');
  assert.deepEqual(h.calls, []);
  await assert.rejects(runPeriscopeDown(downHarness({}, []).deps, { number: '900', mode: 'keep', allowEmpty: false, json: false }), /no periscope for ticket 900/);
});

test('runPeriscopeDown removes the local record on keep and on discard, and a failure there does not undo the end', async () => {
  for (const mode of ['keep', 'discard'] as const) {
    const gone: string[] = [];
    const h = downHarness({ forgetLocal: (id) => { gone.push(id); } });
    await runPeriscopeDown(h.deps, { number: '900', mode, allowEmpty: false, json: false });
    assert.deepEqual(gone, ['rec1']);
  }
  const h = downHarness({ forgetLocal: () => { throw new Error('EPERM'); } });
  assert.equal((await runPeriscopeDown(h.deps, { number: '900', mode: 'discard', allowEmpty: false, json: false })).state, 'discarded');
});

test('prototypeSection counts files and lines', () => {
  assert.match(prototypeSection([{ path: 'a', added: 1, removed: 0 }]), /1 file changed, 1 insertion\(\+\), 0 deletions\(−\)/);
});

test('list shows live periscopes with idle minutes and listening, hiding kept and discarded', () => {
  const rows = [ROW, { ...ROW, ticket: 'TABL-901', state: 'kept' }, { ...ROW, ticket: 'TABL-902', state: 'discarded' }];
  const entries = periscopeListEntries(rows, new Date('2026-11-01T12:00:00Z'), () => true);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.idleMinutes, 30);
  assert.equal(entries[0]!.listening, true);
  assert.match(formatPeriscopeList(entries), /TABL-900 {2}synthesis .*idle 30 min {2}listening/);
  assert.equal(formatPeriscopeList([]), 'no live periscopes on this ship');
});

test('parsePeriscopeDownArgs: no ticket number leaves it to the working directory', () => {
  const a = parsePeriscopeDownArgs(['periscope', 'down'], { ...dflags, discard: true });
  assert.equal(a.number, undefined);
  assert.equal(a.mode, 'discard');
});

test('rowForCwd: the live periscope whose worktree holds the directory', () => {
  const other = { ...ROW, id: 'p2', number: '901', worktree: '/w/tablation-tabl-90' };
  assert.equal(rowForCwd([other, ROW], '/w/tablation-tabl-900/apps/x')?.number, '900');
  assert.equal(rowForCwd([other, ROW], '/w/tablation-tabl-900')?.number, '900');
  assert.equal(rowForCwd([ROW], '/w/tablation-tabl-9000'), undefined);
  assert.equal(rowForCwd([{ ...ROW, state: 'kept' }], '/w/tablation-tabl-900'), undefined);
});

// ---------------------------------------------------------------------------
// `--issue NNN` (CREW-2865)
// ---------------------------------------------------------------------------

import type { ExistingDeps, ExistingTicket } from '../src/periscope-cmd.ts';

const EXISTING: ExistingTicket = {
  id: 'rec7', tag: 'TABL-700', issueId: 'ISSUE-700', status: 'needs_info', closed: false,
  repoId: 'repo1', assignee: 'operator', heldByShipId: null,
};

function existingHarness(t: Partial<ExistingTicket> = {}, e: Partial<ExistingDeps> = {}, over: Partial<PeriscopeDeps> = {}) {
  const log: string[] = [];
  const existing: ExistingDeps = {
    load: async () => ({ ...EXISTING, ...t }),
    repoId: 'repo1', repoName: 'synthesis', pairId: 'pair', shipId: 'ship1',
    agentHolder: async (id) => (id === 'dev-seat' ? 'Developer agent (Studio)' : undefined),
    hasLiveRun: () => false,
    hold: async (id) => { log.push(`hold:${id}`); },
    restore: async (id, a) => { log.push(`restore:${id}:${a}`); },
    remember: (id, p) => { log.push(`remember:${id}:${p.assignee}:${p.status}`); },
    ...e,
  };
  const h = harness({ existing, fileDraft: async () => { throw new Error('must not file'); }, ...over });
  return { ...h, log };
}

const ISSUE_ARGS: PeriscopeUpArgs = { repo: 'synthesis', issue: '700', isolate: false, json: false };

test('parsePeriscopeUpArgs: --issue takes a number, and is refused with --topic', () => {
  assert.equal(parsePeriscopeUpArgs(['periscope', 'up', 'synthesis'], { ...flags, issue: 'TABL-0700' }).issue, '700');
  assert.throws(() => parsePeriscopeUpArgs(['periscope', 'up', 'synthesis'], { ...flags, issue: '700', topic: 'x' }), /cannot be combined/);
  assert.throws(() => parsePeriscopeUpArgs(['periscope', 'up', 'synthesis'], { ...flags, issue: 'abc' }), /not a ticket number/);
});

test('runPeriscopeUp --issue: holds the ticket, files nothing, and reports the prior status', async () => {
  const h = existingHarness();
  const res = await runPeriscopeUp(h.deps, ISSUE_ARGS);
  assert.deepEqual(h.log, ['hold:rec7', 'remember:rec7:operator:needs_info']);
  assert.equal(res.ticket, 'TABL-700');
  assert.equal(res.existing, true);
  assert.equal(res.priorStatus, 'needs_info');
  assert.ok(!h.calls.some((c) => c.startsWith('file:') || c.startsWith('close:')));
  assert.equal(h.rows[0]!.issue_id, 'rec7');
});

test('runPeriscopeUp --issue: refuses a closed ticket, another repo, an agent holder, another ship and a live run, writing nothing', async () => {
  for (const [t, e, re] of [
    [{ closed: true, status: 'closed_deployed' }, {}, /closed_deployed/],
    [{ repoId: 'other' }, {}, /different repository/],
    [{ assignee: 'dev-seat' }, {}, /held by Developer agent \(Studio\)/],
    [{ heldByShipId: 'ship2' }, {}, /held by another ship \(ship2\)/],
    [{}, { hasLiveRun: () => true }, /run in flight/],
  ] as const) {
    const h = existingHarness(t, e);
    await assert.rejects(runPeriscopeUp(h.deps, ISSUE_ARGS), re);
    assert.deepEqual(h.log, []);
    assert.deepEqual(h.calls, []);
  }
});

test('runPeriscopeUp --issue: the Pair row may already hold it; an unknown number is refused', async () => {
  await runPeriscopeUp(existingHarness({ assignee: 'pair', heldByShipId: 'ship1' }).deps, ISSUE_ARGS);
  await assert.rejects(runPeriscopeUp(existingHarness({}, { load: async () => undefined }).deps, ISSUE_ARGS), /no ticket numbered 700/);
});

test('runPeriscopeUp --issue: a failed preview restores the assignee, tears down and does not close the ticket', async () => {
  const bad = existingHarness({}, {}, {});
  const res = runPeriscopeUp({ ...bad.deps, runHook: async (n) => (n === 'preview' ? { code: 1, output: 'boom' } : { code: 0, output: '' }) }, ISSUE_ARGS);
  await assert.rejects(res, /preview exited 1/);
  assert.deepEqual(bad.log, ['hold:rec7', 'remember:rec7:operator:needs_info', 'restore:rec7:operator']);
  assert.ok(bad.calls.includes('teardown'));
  assert.ok(!bad.calls.some((c) => c.startsWith('close:')));
});

test('runPeriscopeDown --keep on an existing ticket: pushes, adds the section, releases the hold, leaves status', async () => {
  const h = downHarness({ readTicket: async () => ({ description: 'D', hasProject: true, hasRepo: true, isDraft: false }), priorHold: () => ({ assignee: 'operator', status: 'needs_info' }) });
  const res = await runPeriscopeDown(h.deps, { number: '900', mode: 'keep', allowEmpty: false, json: false });
  assert.deepEqual(h.calls, ['commit:TABL-900 Periscope prototype', 'push', 'ticket:released', 'pushed:abc123:origin/tabl-900', 'stop', 'remove:false', 'row:kept']);
  assert.equal(res.existing, true);
  assert.equal(res.status, 'needs_info');
  assert.equal((h.patches[0] as { fillProjectAndRepo: boolean }).fillProjectAndRepo, false);
});

test('runPeriscopeDown --discard on an existing ticket: releases the hold, keeps the local branch when the remote has it', async () => {
  const mk = (onRemote: boolean) => downHarness({ readTicket: async () => ({ description: 'D', hasProject: true, hasRepo: true, isDraft: false }), remoteHasBranch: () => onRemote });
  const a = mk(true);
  await runPeriscopeDown(a.deps, { number: '900', mode: 'discard', allowEmpty: false, json: false });
  assert.deepEqual(a.calls, ['stop', 'remove:false', 'ticket:released', 'row:discarded']);
  const b = mk(false);
  await runPeriscopeDown(b.deps, { number: '900', mode: 'discard', allowEmpty: false, json: false });
  assert.deepEqual(b.calls, ['stop', 'remove:true', 'ticket:released', 'row:discarded']);
});

test('runPeriscopeDown on an existing ticket removes the local record on keep and on discard', async () => {
  for (const mode of ['keep', 'discard'] as const) {
    const gone: string[] = [];
    const h = downHarness({ readTicket: async () => ({ description: 'D', hasProject: true, hasRepo: true, isDraft: false }), forgetLocal: (id) => { gone.push(id); } });
    await runPeriscopeDown(h.deps, { number: '900', mode, allowEmpty: false, json: false });
    assert.equal(gone.length, 1, mode);
  }
});

test('the prior-hold file round-trips outside the sidecar directory crew status reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prior-'));
  try {
    writePeriscopePrior(dir, 'rec1', { assignee: 'op', status: 'needs_info' });
    assert.deepEqual(readPeriscopePrior(dir, 'rec1'), { assignee: 'op', status: 'needs_info' });
    assert.deepEqual(readPeriscopeSidecars(dir), []);
    writePeriscopeSidecar(dir, { ticket: 'T-1', ticketRecordId: 'rec1', periscopeRecordId: 'p', repo: 'r', worktree: 'w', branch: 'b', url: 'http://h:1/', host: 'h', state: 'live', isolated: false, startedAt: '', lastActivityAt: '', expiresAt: '' });
    assert.deepEqual(readPeriscopePrior(dir, 'rec1'), { assignee: 'op', status: 'needs_info' });
    assert.equal(readPeriscopeSidecars(dir).length, 1);
    removePeriscopeSidecar(dir, 'rec1');
    removePeriscopePrior(dir, 'rec1');
    assert.equal(readPeriscopePrior(dir, 'rec1'), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parsePeriscopeUpArgs carries --requested-by, trimmed, and omits it when blank', () => {
  const base = { isolate: false, json: true };
  assert.equal(parsePeriscopeUpArgs(['periscope', 'up', 'app'], { ...base, requestedBy: ' mem-1 ' }).requestedBy, 'mem-1');
  assert.equal('requestedBy' in parsePeriscopeUpArgs(['periscope', 'up', 'app'], { ...base, requestedBy: ' ' }), false);
});

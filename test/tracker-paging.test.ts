import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Tracker, scopedTicketQueries, resetOpenSetCache, type TicketScope } from '../src/tracker.ts';
import type { Route } from '../src/config.ts';
import type { WorkMode } from '../src/work-mode.ts';
import { State } from '../src/state.ts';
import { Emitter, eventFileFor } from '../src/events.ts';
import { openShipAttention } from '../src/ship-attention.ts';
import { reportTruncated } from '../src/poll.ts';
import { FakeTracker, MODELS, SEATS, crewRows, ticket, type Row } from './helpers/fake-tracker.ts';

/** CREW-3453: a board past the page size must still show every ticket a lane can act on. */

function trackerFor(fake: FakeTracker): Tracker {
  const home = mkdtempSync(join(tmpdir(), 'crew-paging-'));
  writeFileSync(join(home, '.env'), 'KEY=test-key\n');
  const route = {
    route: 'test/proj', enabled: true, dir: home, repos: {}, baseUrl: fake.baseUrl, apiKeyFile: join(home, '.env'), apiKeyVar: 'KEY',
    hooks: {}, labels: {}, release: {},
    resolved: { workspaceId: 'ws-1', models: MODELS, seats: SEATS, operator: 'op', holds: [] },
  } as unknown as Route;
  return new Tracker(route, { userAgent: 'crew-test', name: 'test-ship' });
}

const many = (n: number, mk: (i: number) => Partial<Row> & { status: string }, prefix = 'n'): Row[] =>
  Array.from({ length: n }, (_, i) => ticket({ id: `${prefix}${i}`, issue_id: `ISSUE-${prefix}${i}`, ...mk(i) }));

async function board(rows: Row[], extra: (f: FakeTracker) => void = () => {}): Promise<FakeTracker> {
  const f = new FakeTracker().table(MODELS.crew, crewRows()).table(MODELS.comments, []).table(MODELS.issues, rows);
  f.pageCap = 500;
  extra(f);
  return f.start();
}

test('every open ticket comes back when the board is past the page size, however old the actionable ones are', async () => {
  const f = await board([
    ...many(60, () => ({ status: 'accepted' }), 'old'),
    ...many(1100, () => ({ status: 'new' }), 'imp'),
  ]);
  try {
    const open = await trackerFor(f).openTickets();
    assert.equal(open.length, 1160);
    assert.equal(new Set(open.map((t) => t.id)).size, 1160, 'no row repeated across pages');
    assert.equal(f.listCalls.filter((c) => c.model === MODELS.issues).length, 3);
  } finally { await f.stop(); }
});

test('more than a page of actionable tickets are all considered', async () => {
  const f = await board(many(1200, () => ({ status: 'accepted', project_id: 'auto' })));
  try {
    const scope: TicketScope = { modes: new Map<string, WorkMode>([['auto', 'automatic']]), agentAssignees: new Set() };
    assert.equal((await trackerFor(f).openTickets(scope)).length, 1200);
  } finally { await f.stop(); }
});

test('a board under one page is still one request', async () => {
  const f = await board(many(40, () => ({ status: 'accepted' })));
  try {
    await trackerFor(f).openTickets();
    assert.equal(f.listCalls.filter((c) => c.model === MODELS.issues).length, 1);
  } finally { await f.stop(); }
});

test('the scoped query never fetches new, manual, project-less or person-assigned hybrid tickets', async () => {
  const modes = new Map<string, WorkMode>([['auto', 'automatic'], ['man', 'manual'], ['hyb', 'hybrid']]);
  const f = await board([
    ...many(1500, () => ({ status: 'new', project_id: 'man' }), 'bulk'),
    ...many(700, () => ({ status: 'new', project_id: 'auto' }), 'newauto'),
    ticket({ id: 'a', issue_id: 'ISSUE-a', status: 'accepted', project_id: 'auto' }),
    ticket({ id: 'unknown', issue_id: 'ISSUE-u', status: 'accepted', project_id: 'not-in-projects' }),
    ticket({ id: 'm', issue_id: 'ISSUE-m', status: 'accepted', project_id: 'man' }),
    ticket({ id: 'np', issue_id: 'ISSUE-np', status: 'accepted' }),
    ticket({ id: 'h-agent', issue_id: 'ISSUE-ha', status: 'accepted', project_id: 'hyb', assignee_id: SEATS.dev }),
    ticket({ id: 'h-person', issue_id: 'ISSUE-hp', status: 'accepted', project_id: 'hyb', assignee_id: 'a-person' }),
    ticket({ id: 'h-ver', issue_id: 'ISSUE-hv', status: 'verified', project_id: 'hyb', assignee_id: 'a-person' }),
    ticket({ id: 'tri', issue_id: 'ISSUE-tri', status: 'new', project_id: 'auto', assignee_id: SEATS.triage }),
  ]);
  try {
    const tracker = trackerFor(f);
    const agents = new Set([SEATS.dev]);
    const ids = async (triageSeat?: string) =>
      (await tracker.openTickets({ modes, agentAssignees: agents, triageSeat })).map((t) => t.id).sort();
    assert.deepEqual(await ids(), ['a', 'h-agent', 'h-ver', 'unknown']);
    f.listCalls.length = 0;
    assert.deepEqual(await ids(SEATS.triage), ['a', 'h-agent', 'h-ver', 'tri', 'unknown']);
    assert.ok(f.listCalls.length <= 4, `a fixed number of requests, got ${f.listCalls.length}`);
  } finally { await f.stop(); }
});

test('with no hybrid project and no triage seat the query set is the automatic one alone', () => {
  const tracker = trackerFor(new FakeTracker());
  const q = scopedTicketQueries(tracker.contract, { modes: new Map<string, WorkMode>([['auto', 'automatic']]), agentAssignees: new Set() });
  assert.equal(q.length, 1);
});

test('countOpenTickets counts matching open tickets without listing them', async () => {
  const f = await board([
    ...many(30, () => ({ status: 'new', project_id: 'man' })),
    ticket({ id: 'a', issue_id: 'ISSUE-a', status: 'accepted', project_id: 'auto' }),
    ticket({ id: 'c', issue_id: 'ISSUE-c', status: 'closed_deployed', project_id: 'man' }),
  ]);
  try {
    const tracker = trackerFor(f);
    assert.equal(await tracker.countOpenTickets([{ columnName: 'project_id', operator: 'IN', value: ['man'] }]), 30);
    assert.equal(f.listCalls.length, 0);
  } finally { await f.stop(); }
});

test('a list that outruns the page backstop is recorded as cut off, by name, and a full read is not', async (t) => {
  const f = await board(many(1200, () => ({ status: 'accepted' })));
  const was = Tracker.maxPages;
  t.after(() => { Tracker.maxPages = was; });
  try {
    Tracker.maxPages = 2;
    const cut = trackerFor(f);
    assert.equal((await cut.openTickets()).length, 1000);
    assert.equal(cut.truncated.get('open tickets'), 1000);
    Tracker.maxPages = 3;
    const whole = trackerFor(f);
    assert.equal((await whole.openTickets()).length, 1200);
    assert.equal(whole.truncated.size, 0);
  } finally { await f.stop(); }
});

test('reportTruncated raises an event and a ship attention item naming the list and cap, and clears it once the list is whole', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-trunc-'));
  const state = new State(dir);
  const emit = new Emitter({ route: 'test/proj', eventFile: eventFileFor(dir), console: () => {} });
  const f = await board([]);
  try {
    const tracker = trackerFor(f);
    tracker.noteTruncated('Crew rows', 100000);
    await reportTruncated(tracker, 'test/proj', state, emit);
    const items = openShipAttention(state);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.kind, 'list_truncated');
    assert.match(items[0]!.message, /Crew rows list came back full at 100000 rows/);
    const events = readFileSync(eventFileFor(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(events[0].data.attention, ['ship:list_truncated']);

    await reportTruncated(trackerFor(f), 'test/proj', state, emit);
    assert.deepEqual(openShipAttention(state), []);
  } finally { await f.stop(); }
});

test('a blocker outside the narrowed query is found by id, never read as resolved', async () => {
  const f = await board([
    ticket({ id: 'blocker', issue_id: 'ISSUE-b', status: 'new', project_id: 'man' }),
    ticket({ id: 'blocked', issue_id: 'ISSUE-x', status: 'accepted', project_id: 'auto', blocked_by: ['blocker'] }),
  ]);
  try {
    const tracker = trackerFor(f);
    const open = await tracker.openTickets({ modes: new Map<string, WorkMode>([['auto', 'automatic'], ['man', 'manual']]), agentAssignees: new Set() });
    assert.deepEqual(open.map((t) => t.id), ['blocked']);
    const [blocker] = await tracker.ticketsByIds(['blocker']);
    assert.equal(blocker?.status, 'new');
  } finally { await f.stop(); }
});

test('a hold answer on an old ticket is found though newer comments outnumber a page', async () => {
  const f = await board(many(2, () => ({ status: 'needs_info' }), 'k'), (fk) => {
    fk.table(MODELS.comments, [
      { id: 'c-old', ticket_id: 'k0', body: 'the answer' },
      ...Array.from({ length: 1100 }, (_, i) => ({ id: `c-${String(i).padStart(4, '0')}`, ticket_id: 'k1', body: `n${i}` })),
    ]);
  });
  try {
    const got = await trackerFor(f).commentsForTickets(['k0', 'k1']);
    assert.equal(got.length, 1101);
    assert.ok(got.some((c) => c.id === 'c-old'));
    assert.equal(trackerFor(f).truncated.size, 0);
  } finally { await f.stop(); }
});

/** CREW-4016: a poll reads the whole open set once a minute and only what changed in between. */
test('a poll rereads only changed tickets inside the reconcile window', async () => {
  resetOpenSetCache();
  const scope: TicketScope = { modes: new Map<string, WorkMode>([['auto', 'automatic']]), agentAssignees: new Set() };
  const stamp = new Date().toISOString();
  const f = await board(many(30, () => ({ status: 'accepted', project_id: 'auto', updated_at: '2026-08-01T00:00:00.000Z' })));
  try {
    const t = trackerFor(f);
    assert.equal((await t.openTickets(scope)).length, 30);
    const full = f.listCalls.filter((c) => c.model === MODELS.issues).length;
    // One ticket leaves the open set, one joins it, both with a fresh updated_at.
    const rows = f.tables.get(MODELS.issues)!;
    Object.assign(rows[0]!, { status: 'closed_deployed', updated_at: stamp });
    rows.push(ticket({ id: 'added', issue_id: 'ISSUE-added', status: 'accepted', project_id: 'auto', updated_at: stamp }));
    const again = await t.openTickets(scope);
    assert.equal(again.length, 30);
    assert.ok(again.some((x) => x.id === 'added'));
    assert.ok(!again.some((x) => x.id === rows[0]!.id));
    const delta = f.listCalls.filter((c) => c.model === MODELS.issues).slice(full);
    assert.ok(delta.every((c) => String(c.filters).includes('updated_at')), 'no full read inside the window');
    Tracker.openSetReconcileMs = 0;
    f.listCalls.length = 0;
    await t.openTickets(scope);
    assert.ok(!String(f.listCalls[0]?.filters).includes('updated_at'), 'a full read once the window is up');
  } finally { Tracker.openSetReconcileMs = 60_000; await f.stop(); }
});

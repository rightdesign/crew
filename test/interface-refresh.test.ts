import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolvedPathFor, type Route, type Ship } from '../src/config.ts';
import { refreshForRoute } from '../src/interface-refresh.ts';
import { interfaceReport, mappingKey, readInterfaceState } from '../src/tracker-interface-read.ts';
import { Tracker } from '../src/tracker.ts';
import { FIELD_ENTRIES, type InterfaceMapping } from '../src/tracker-interface.ts';

const withPart = (): InterfaceMapping => {
  const fields: Record<string, string> = {};
  for (const e of FIELD_ENTRIES) if (!e.optional || e.table === 'questions' || e.table === 'answers') fields[e.role] = `x_${e.defaultColumn}`;
  return { tables: { issues: 'Tickets', comments: 'Notes', crew: 'People', questions: 'Asks', answers: 'Options' }, fields, values: {} };
};
const withoutPart = (): InterfaceMapping => {
  const m = withPart();
  delete m.tables['questions']; delete m.tables['answers'];
  m.fields = Object.fromEntries(Object.entries(m.fields).filter(([k]) => !k.startsWith('questions.') && !k.startsWith('answers.')));
  return m;
};
const MODELS = [
  { id: 'm-t', name: 'Tickets' }, { id: 'm-n', name: 'Notes' }, { id: 'm-p', name: 'People' },
  { id: 'm-q', name: 'Asks' }, { id: 'm-a', name: 'Options' },
];

/** Counts every request so a test can say how many reads a refresh made. */
function platform(mapping: InterfaceMapping | null, models = MODELS) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${url.pathname}${url.search}`;
    calls.push(`${init?.method ?? 'GET'} ${key}`);
    const table: Record<string, unknown> = {
      '/api/app-interfaces/implementers?workspaceId=ws-1&name=work-tracker':
        mapping ? [{ project: { id: 'proj-1' }, interfaceName: 'work-tracker', version: { major: 1, minor: 1 }, mapping }] : [],
      '/api/projects/proj-1/interfaces': [{ name: 'work-tracker', conforms: true, unmet: [] }],
      '/api/data-models?projectId=proj-1': models,
    };
    return key in table ? new Response(JSON.stringify(table[key]), { status: 200 }) : new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const STALE_FILE = {
  workspaceId: 'ws-1', projectId: 'proj-1',
  models: { issues: 'm-t', comments: 'm-n', crew: 'm-p' },
  seats: { dev: 'seat-dev', qa: 'seat-qa' }, holds: [{ id: 'h1', role: 'Brad' }], releaseSeat: 'seat-rel',
  agentPersonas: { dev: 'abc' }, shipName: 'Mac', connectedAt: '2026-01-01T00:00:00.000Z',
};

function setup(file: object = STALE_FILE) {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-refresh-'));
  const route = { route: 'issues/issues', baseUrl: 'https://example.test', apiKey: 'k' } as Route;
  const path = resolvedPathFor(stateDir, route.route);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  route.resolved = file as Route['resolved'];
  const ship = { userAgent: 'crew-test', stateDir } as Ship;
  return { route, ship, path, stateDir };
}

test('a file with no questions ids or trackerInterface is refreshed, and everything else in it is untouched', async (t) => {
  const p = platform(withPart()); t.after(p.restore);
  const { route, ship, path } = setup();
  assert.equal(await refreshForRoute(route, ship, true), true);
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.questionsModelId, 'm-q');
  assert.equal(after.answersModelId, 'm-a');
  assert.equal(after.trackerInterface.declared, true);
  assert.equal(after.trackerInterface.mappingKey, mappingKey(withPart()));
  assert.ok(after.contract);
  for (const k of ['workspaceId', 'projectId', 'models', 'seats', 'holds', 'releaseSeat', 'agentPersonas', 'shipName', 'connectedAt']) {
    assert.equal(JSON.stringify(after[k]), JSON.stringify((STALE_FILE as Record<string, unknown>)[k]), k);
  }
  assert.ok(existsSync(`${path}.bak`));
  // the running process sees it too: this is what `crew ask` reads
  assert.deepEqual(new Tracker(route, ship as never).questionsPart(), { questionsModelId: 'm-q', answersModelId: 'm-a' });
});

test('--dry-run resolves in memory and writes nothing', async (t) => {
  const p = platform(withPart()); t.after(p.restore);
  const { route, ship, path } = setup();
  const before = readFileSync(path, 'utf8');
  assert.equal(await refreshForRoute(route, ship, false), true);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(route.resolved?.questionsModelId, 'm-q');
});

test('an app that maps no questions part writes nothing but the interface fields, and keeps saying so', async (t) => {
  const p = platform(withoutPart()); t.after(p.restore);
  const { route, ship, path } = setup();
  await refreshForRoute(route, ship, true);
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.questionsModelId, undefined);
  assert.equal(new Tracker(route, ship as never).questionsPart(), null);
});

test('an app with no declaration is left alone', async (t) => {
  const p = platform(null); t.after(p.restore);
  const { route, ship, path } = setup();
  const before = readFileSync(path, 'utf8');
  assert.equal(await refreshForRoute(route, ship, true), false);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(route.resolved?.trackerInterface, undefined);
});

test('a current snapshot costs no read beyond the declaration, and no write at all', async (t) => {
  const p = platform(withPart()); t.after(p.restore);
  const { route, ship } = setup();
  await refreshForRoute(route, ship, true);
  p.calls.length = 0;
  const state = await readInterfaceState((await import('../src/tracker-interface-read.ts')).getterFor(route, ship), 'ws-1', 'proj-1');
  const reads = p.calls.length;
  assert.equal(await refreshForRoute(route, ship, true, state), false);
  assert.equal(p.calls.length, reads, 'no model listing when nothing is stale');
  assert.ok(p.calls.every((c) => c.startsWith('GET ')), 'the refresh never writes to the tracker');
});

test('a mapping change (a new optional table) is picked up without a connect', async (t) => {
  let p = platform(withoutPart()); 
  const { route, ship, path } = setup();
  await refreshForRoute(route, ship, true);
  p.restore();
  p = platform(withPart()); t.after(p.restore);
  assert.equal(await refreshForRoute(route, ship, true), true);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).questionsModelId, 'm-q');
});

test('doctor names the mismatch on a stale file and is quiet after the refresh', async (t) => {
  const p = platform(withPart()); t.after(p.restore);
  const { route, ship } = setup();
  const state = await readInterfaceState((await import('../src/tracker-interface-read.ts')).getterFor(route, ship), 'ws-1', 'proj-1');
  const stale = interfaceReport(state, { stored: route.resolved });
  assert.ok(stale.some((l) => l.problem && /connected before the app declared/.test(l.line)));
  await refreshForRoute(route, ship, true, state);
  assert.ok(interfaceReport(state, { stored: route.resolved, storedMappingKey: route.resolved?.trackerInterface?.mappingKey }).every((l) => !l.problem));
  // a file that has the interface but not the questions ids says so specifically
  const half = { ...route.resolved!, questionsModelId: undefined, answersModelId: undefined };
  assert.ok(interfaceReport(state, { stored: half, storedMappingKey: half.trackerInterface?.mappingKey }).some((l) => l.problem && /questions part is declared by the app/.test(l.line)));
});

test('a mapped part whose tables are missing is settled after one refresh: no second listing, no second write', async (t) => {
  const missing = MODELS.filter((m) => m.id !== 'm-q' && m.id !== 'm-a');
  const p = platform(withPart(), missing); t.after(p.restore);
  const { route, ship, path } = setup();
  assert.equal(await refreshForRoute(route, ship, true), true);
  const first = readFileSync(path, 'utf8');
  const listings = () => p.calls.filter((c) => c.includes('/data-models')).length;
  assert.equal(listings(), 1);
  assert.equal(await refreshForRoute(route, ship, true), false);
  assert.equal(listings(), 1);
  assert.equal(readFileSync(path, 'utf8'), first);
  const report = interfaceReport(
    await readInterfaceState((await import('../src/tracker-interface-read.ts')).getterFor(route, ship), 'ws-1', 'proj-1'),
    { stored: route.resolved, storedMappingKey: route.resolved?.trackerInterface?.mappingKey },
  ).map((l) => l.line).join('\n');
  assert.doesNotMatch(report, /refreshes it on its next poll/);
  assert.match(report, /not found in this project/);
});

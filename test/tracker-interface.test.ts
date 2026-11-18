import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { discover } from '../src/connect.ts';
import { DEFAULT_CONTRACT } from '../src/contract.ts';
import {
  contractFromMapping, renderReferencePage, trackerInterfaceDefinition, FIELD_ENTRIES, TABLE_ENTRIES, versionAccepted,
  type InterfaceMapping,
} from '../src/tracker-interface.ts';
import {
  checkTrackerInterface, INTERFACE_MISMATCH_KEY, INTERFACE_UNDECLARED_KEY, mappingKey, type InterfaceState,
} from '../src/tracker-interface-read.ts';
import { openShipAttention } from '../src/ship-attention.ts';
import { Emitter } from '../src/events.ts';
import { State } from '../src/state.ts';
import type { Route, Ship } from '../src/config.ts';

const BASE = { baseUrl: 'https://example.test', apiKey: 'k', userAgent: 'crew-test' };

/** Fetch mock keyed by pathname+query; unknown paths 404, like the platform's absent routes. */
function mockFetch(routes: Record<string, unknown>) {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${url.pathname}${url.search}`;
    seen.push(key);
    if (!(key in routes)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, seen };
}

/** A mapping where every table has a renamed display name and one status is renamed. */
function renamedMapping(): InterfaceMapping {
  return {
    tables: { issues: 'Tickets', comments: 'Notes', crew: 'People' },
    fields: Object.fromEntries(FIELD_ENTRIES.filter((e) => !e.optional).map((e) => [e.role, `x_${e.defaultColumn}`])),
    values: { status: { approved: 'ready', new: 'new' } },
  };
}

const IMPL = '/api/app-interfaces/implementers?workspaceId=ws-1&name=work-tracker';

function declaredRoutes(version: { major: number; minor: number }, mapping: InterfaceMapping, conformance?: unknown) {
  return {
    '/api/workspaces/app': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/tracker?workspaceId=ws-1': { id: 'proj-1', name: 'Tracker' },
    // Only the renamed tables exist: finding "Issues" by display name would fail.
    '/api/data-models?projectId=proj-1': [
      { id: 'm-tickets', name: 'Tickets' }, { id: 'm-notes', name: 'Notes' }, { id: 'm-people', name: 'People' },
    ],
    '/api/data-models/m-people/records?limit=200': [],
    [IMPL]: [{ project: { id: 'proj-1' }, interfaceName: 'work-tracker', version, mapping }],
    ...(conformance ? { '/api/projects/proj-1/interfaces': conformance } : {}),
  };
}

test('a declared, conforming app connects through its mapping with no display-name lookups', async (t) => {
  const { restore } = mockFetch(declaredRoutes({ major: 1, minor: 0 }, renamedMapping(), [
    { name: 'work-tracker', conforms: true, unmet: [] },
  ]));
  t.after(restore);
  const found = await discover({ ...BASE, workspace: 'app', project: 'tracker' });
  assert.deepEqual(found.models, { issues: 'm-tickets', comments: 'm-notes', crew: 'm-people' });
  assert.equal(found.problems.some((p) => /no ".*" table/.test(p)), false);
  assert.equal(found.declaredContract?.columns.status, 'x_status');
  assert.equal(found.declaredContract?.statuses.approved, 'ready');
  assert.ok(found.declaredContract?.statuses.open.includes('ready'));
  assert.equal(found.declaredMappingKey, mappingKey(renamedMapping()));
});

test('a declared app missing a required field: connect lists the role, the expected shape and what was found', async (t) => {
  const unmet = [{ roleId: 'issues.status', label: 'Status', reason: 'missing_field', message: '"Status": the table has no column "x_status".' }];
  const { restore } = mockFetch(declaredRoutes({ major: 1, minor: 0 }, renamedMapping(), [{ name: 'work-tracker', conforms: false, unmet }]));
  t.after(restore);
  const found = await discover({ ...BASE, workspace: 'app', project: 'tracker' });
  const line = found.problems.find((p) => p.includes('does not conform'))!;
  assert.match(line, /issues\.status/);
  assert.match(line, /expected a choice field on the issues table/);
  assert.match(line, /x_status/);
});

test('an undeclared app is found by display name, unchanged', async (t) => {
  const { restore } = mockFetch({
    '/api/workspaces/app': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/tracker?workspaceId=ws-1': { id: 'proj-1', name: 'Tracker' },
    '/api/data-models?projectId=proj-1': [{ id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'p', name: 'Crew' }],
    '/api/data-models/p/records?limit=200': [],
  });
  t.after(restore);
  const found = await discover({ ...BASE, workspace: 'app', project: 'tracker' });
  assert.deepEqual(found.models, { issues: 'i', comments: 'c', crew: 'p' });
  assert.equal(found.interface?.kind, 'undeclared');
  assert.equal(found.declaredContract, undefined);
});

// ---- the per-cycle check ---------------------------------------------------

const ship = { userAgent: 'Mozilla/5.0 CrewAgent/0.159.3' } as Ship;
const mkRoute = (extra: Partial<Route> = {}, mk = mappingKey(renamedMapping())) =>
  ({
    route: 'r', hooks: {},
    resolved: { workspaceId: 'ws-1', projectId: 'proj-1', trackerInterface: { declared: true, version: '1.0', mappingKey: mk } },
    ...extra,
  }) as unknown as Route;
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-iface-'));
  return { state: new State(dir), emit: new Emitter({ file: join(dir, 'events.jsonl'), cycle: 'c' } as never) };
};
const declared = (over: Partial<Extract<InterfaceState, { kind: 'declared' }>> = {}): InterfaceState => ({
  kind: 'declared', version: { major: 1, minor: 0 }, accepted: true, mapping: renamedMapping(), conforms: true, unmet: [], ...over,
});
const items = (state: State, key: string) => openShipAttention(state).filter((i) => i.key === key);

test('a nonconforming app stops claiming, raises one item, and clears itself once it conforms', async () => {
  const { state, emit } = fresh();
  const o = { state, emit, route: mkRoute(), ship };
  const unmet = [{ roleId: 'issues.status', message: 'no column "x_status"' }];
  const stop = await checkTrackerInterface(o, { read: async () => declared({ conforms: false, unmet }) });
  assert.match(stop!, /issues\.status/);
  assert.match(stop!, /expected a choice field/);
  await checkTrackerInterface(o, { read: async () => declared({ conforms: false, unmet }) });
  assert.equal(items(state, INTERFACE_MISMATCH_KEY).length, 1);
  // an unreadable platform keeps the stop
  assert.ok(await checkTrackerInterface(o, { read: async () => ({ kind: 'unreadable' }) }));
  assert.equal(await checkTrackerInterface(o, { read: async () => declared() }), null);
  assert.equal(items(state, INTERFACE_MISMATCH_KEY).length, 0);
});

test('an unaccepted version names both versions and which side updates', async () => {
  const newer = fresh();
  const stopNewer = await checkTrackerInterface({ ...newer, route: mkRoute(), ship }, {
    read: async () => declared({ version: { major: 2, minor: 0 }, accepted: false }),
  });
  assert.match(stopNewer!, /2\.0/);
  assert.match(stopNewer!, /1\.0 or a later 1\.x/);
  assert.match(stopNewer!, /Update crew/);
  const older = fresh();
  const stopOlder = await checkTrackerInterface({ ...older, route: mkRoute(), ship }, {
    read: async () => declared({ version: { major: 0, minor: 9 }, accepted: false }),
  });
  assert.match(stopOlder!, /0\.9/);
  assert.match(stopOlder!, /Update the app/);
});

test('an undeclared app keeps working and only raises the non-blocking item', async () => {
  const { state, emit } = fresh();
  const o = { state, emit, route: mkRoute(), ship };
  assert.equal(await checkTrackerInterface(o, { read: async () => ({ kind: 'undeclared' }) }), null);
  assert.equal(items(state, INTERFACE_UNDECLARED_KEY).length, 1);
  assert.equal(items(state, INTERFACE_MISMATCH_KEY).length, 0);
  await checkTrackerInterface(o, { read: async () => ({ kind: 'undeclared' }) });
  assert.equal(items(state, INTERFACE_UNDECLARED_KEY).length, 1);
  // declaring clears it
  await checkTrackerInterface(o, { read: async () => declared() });
  assert.equal(items(state, INTERFACE_UNDECLARED_KEY).length, 0);
});

test('a crew.yaml contract override is reported ignored once the app declares', async () => {
  const { state, emit } = fresh();
  const o = { state, emit, route: mkRoute({ contractAuthored: true }), ship };
  assert.equal(await checkTrackerInterface(o, { read: async () => declared() }), null);
  assert.match(items(state, `${INTERFACE_MISMATCH_KEY}_override`)[0]!.message, /ignored/);
});

test('a mapping changed since connect stops claiming until connect reruns', async () => {
  const { state, emit } = fresh();
  const o = { state, emit, route: mkRoute({}, 'stale'), ship };
  assert.match((await checkTrackerInterface(o, { read: async () => declared() }))!, /rerun `crew connect`/);
});

// ---- the definition ----------------------------------------------------------

test('the default contract is built from the definition and is unchanged', () => {
  assert.equal(DEFAULT_CONTRACT.columns.status, 'status');
  assert.equal(DEFAULT_CONTRACT.columns.heldBy, 'held_by_ship_id');
  assert.equal(DEFAULT_CONTRACT.comments.publicReply, 'is_public_reply');
  assert.equal(DEFAULT_CONTRACT.statuses.approved, 'accepted');
  assert.equal(DEFAULT_CONTRACT.statuses.reviewing, null);
  assert.deepEqual(DEFAULT_CONTRACT.statuses.resolved, [
    'verified', 'closed_deployed', 'closed_wont_fix', 'closed_duplicate', 'closed_completed', 'closed_cant_reproduce',
  ]);
  // An app that maps nothing of the questions part gets blank question columns, so none is ever written.
  const empty = contractFromMapping(DEFAULT_CONTRACT, { tables: {}, fields: {}, values: {} });
  assert.deepEqual({ ...empty, questions: DEFAULT_CONTRACT.questions, answers: DEFAULT_CONTRACT.answers }, DEFAULT_CONTRACT);
  assert.ok(Object.values(empty.questions).every((c) => c === '') && Object.values(empty.answers).every((c) => c === ''));
});

test('role ids are unique and every field role names a table role', () => {
  const def = trackerInterfaceDefinition();
  const ids = def.roles.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  const tables = new Set(TABLE_ENTRIES.map((t) => t.role));
  for (const e of FIELD_ENTRIES) assert.ok(tables.has(e.table), e.role);
  assert.deepEqual(def.version, { major: 1, minor: 3 });
});

test('docs/WORK_TRACKER.md matches the definition (regenerate with `node --experimental-strip-types scripts/gen-tracker-reference.ts`)', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'WORK_TRACKER.md');
  assert.equal(readFileSync(file, 'utf8'), renderReferencePage());
});

test('the 1.2 roles the platform reads are all optional, so a 1.0 app that maps none still conforms', () => {
  const roles = ['issues.description', 'issues.needsPlanning', 'repos.name', 'repos.remote', 'repos.enabled', 'repos.ciProvider', 'repos.appUrl', 'repos.project', 'crew.userId'];
  const def = trackerInterfaceDefinition();
  for (const id of roles) {
    const r = def.roles.find((x) => x.id === id);
    assert.ok(r, id);
    assert.equal(r.optional, true, id);
    assert.ok(r.whatBreaks.length > 0, id);
  }
  assert.ok(versionAccepted({ major: 1, minor: 0 }));
  assert.equal(DEFAULT_CONTRACT.repos.remote, 'remote');
  assert.equal(DEFAULT_CONTRACT.crew.userId, 'user_id');
});

interface TemplateShape { kind: string; computed: boolean; multiple?: boolean }

/** Whether a column shape satisfies a field role, by the platform's rules: no `computed` setting means must not be computed. */
function shapeMeets(role: (typeof FIELD_ENTRIES)[number], shape: TemplateShape): string | null {
  if (role.kind !== 'any' && role.kind !== shape.kind) return `expected ${role.kind}, found ${shape.kind}`;
  if ((role.computed ?? false) !== 'either' && (role.computed ?? false) !== shape.computed) return shape.computed ? 'is computed' : 'is not computed';
  if (role.multiple !== 'either' && role.multiple !== undefined && role.multiple !== !!shape.multiple) return 'wrong multiplicity';
  return null;
}

test('the default mapping conforms to the published definition on a snapshot of the Issues template (CREW-3638)', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'issues-template-shapes.json');
  const snap = JSON.parse(readFileSync(file, 'utf8')) as { tables: Record<string, Record<string, TemplateShape>> };
  const problems: string[] = [];
  const unmapped: string[] = [];
  for (const e of FIELD_ENTRIES) {
    const table = snap.tables[e.table];
    if (!table || e.builtin) continue;
    const shape = table[e.defaultColumn];
    // The snapshot of a table other than Issues holds only the columns this check is about.
    if (!shape) { if (e.table === 'issues') unmapped.push(e.role); continue; }
    const why = shapeMeets(e, shape);
    if (why) problems.push(`${e.role} (${e.defaultColumn}): ${why}`);
  }
  assert.deepEqual(problems, []);
  // The Issues app has no pull request reference column; nothing else on Issues is missing.
  assert.deepEqual(unmapped, ['issues.prRef']);
});

test('only the roles crew reads accept a computed field; the key roles do', () => {
  const either = FIELD_ENTRIES.filter((e) => e.computed === 'either').map((e) => e.role).sort();
  assert.deepEqual(either, ['epics.key', 'issues.key', 'issues.tag', 'maps.version']);
  const attachments = trackerInterfaceDefinition().roles.find((r) => r.id === 'issues.attachments');
  assert.equal(attachments?.type === 'field' && attachments.fieldKind, 'file');
});

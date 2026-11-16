import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  citedSections, sectionText, activeMap, mapBriefSection, briefMapFor, MAP_INLINE_LIMIT,
  type MapRow, type MapSource,
} from '../src/map-brief.ts';
import { ownRunBanner } from '../src/poll.ts';
import { DEFAULT_CONTRACT as C } from '../src/contract.ts';
import type { Ticket } from '../src/tracker.ts';

const DOC = '# Shell\n\n## 1. Purpose\n\nWhy.\n\n## 11. Inbox\n\nThe inbox text.\n\n### 11.1 Waiting lists\n\nLists.\n\n## 12. Rail\n\nRail text.\n';
const map = (o: Partial<MapRow> = {}): MapRow =>
  ({ id: 'm1', title: 'Shell', status: 'active', version: 1, content: DOC, conversation: 'SECRET INTERVIEW', updated_at: '2026-11-16T00:00:00Z', ...o });
const ticket = (o: Record<string, unknown> = {}): Ticket =>
  ({ id: 't', issue_id: 'ISSUE-1', title: 'T', description: 'Context: EPIC-087, Map v1 §11', epic_id: 'e1', ...o }) as unknown as Ticket;
const epic = { id: 'e1', epic_id: 'EPIC-087', label: 'EPIC-087 — Shell' };
const section = (maps: Parameters<typeof mapBriefSection>[0]['maps'], o: Partial<Parameters<typeof mapBriefSection>[0]> = {}) =>
  mapBriefSection({ ticket: ticket(), epic, mapsModelId: 'maps-model', maps, contract: C, ...o });

test('citations are read from "Map v1 §11" and lists and ranges', () => {
  assert.deepEqual(citedSections('EPIC-087, Map v1 §11'), ['11']);
  assert.deepEqual(citedSections('§3.2 and §§4, 6 and 8', '§5-7'), ['3.2', '4', '6', '8', '5', '6', '7'].filter((v, i, a) => a.indexOf(v) === i));
  assert.deepEqual(citedSections('no citation here', null), []);
});

test('a section runs to the next heading of the same or higher level', () => {
  const t = sectionText(DOC, '11')!;
  assert.match(t, /The inbox text/);
  assert.match(t, /Waiting lists/);
  assert.doesNotMatch(t, /Rail text/);
  assert.equal(sectionText(DOC, '99'), null);
  assert.match(sectionText('## §3 Thing\n\nbody', '3')!, /body/);
});

test('the active Map is supplied whole, with the interview left out and the ticket winning', () => {
  const s = section({ rows: [map()] })!;
  assert.match(s, /Map for EPIC-087 — Shell/);
  assert.match(s, /The inbox text/);
  assert.match(s, /§11 is the section headed "11\. Inbox"/);
  assert.match(s, /not a file in the repository/);
  assert.match(s, /the ticket and its comments win/);
  assert.match(s, /records_controller_find_one/);
  assert.doesNotMatch(s, /SECRET INTERVIEW/);
});

test('a superseded or draft Map is never supplied in place of the active one', () => {
  const s = section({ rows: [map({ id: 'old', status: 'superseded', version: 1, content: 'OLD PLAN' }), map({ id: 'new', version: 2, content: DOC })] })!;
  assert.doesNotMatch(s, /OLD PLAN/);
  assert.match(s, /version 2/);
  assert.match(s, /"recordId" ?|`new`/);
  assert.equal(activeMap([map({ id: 'a', version: 1 }), map({ id: 'b', version: 3 })], C)!.id, 'b');
});

test('an epic with only draft or superseded Maps is told there is no active Map', () => {
  const s = section({ rows: [map({ status: 'draft', content: 'DRAFT TEXT' }), map({ status: 'superseded', content: 'OLD' })] })!;
  assert.match(s, /has no active Map/);
  assert.match(s, /do not search the checkout/);
  assert.doesNotMatch(s, /DRAFT TEXT|OLD/);
  assert.match(section({ rows: [] })!, /has no active Map\. It has no Map/);
});

test('a seat the tracker refuses is told so; another failure is named', () => {
  assert.match(section({ forbidden: true })!, /not allowed to read the Maps table/);
  const f = section({ failed: 'ECONNRESET' })!;
  assert.match(f, /failed this run \(ECONNRESET\)/);
  assert.match(f, /do not search the checkout/);
});

test('a ticket with no epic, or a workspace with no Maps table, gets no section', () => {
  assert.equal(section({ rows: [map()] }, { ticket: ticket({ epic_id: null }) }), null);
  assert.equal(section({ rows: [map()] }, { mapsModelId: undefined }), null);
});

test('a document too long to include whole gives the cited sections in full, an outline and the way to read the rest', () => {
  const big = DOC + '\n## 13. Bulk\n\n' + 'x'.repeat(MAP_INLINE_LIMIT);
  const s = section({ rows: [map({ content: big })] })!;
  assert.match(s, /too long to include whole/);
  assert.match(s, /§11, in full/);
  assert.match(s, /The inbox text/);
  assert.doesNotMatch(s, /Rail text/);
  assert.match(s, /Outline of the whole document/);
  assert.match(s, /12\. Rail/);
  assert.match(s, /records_controller_find_one/);
  assert.doesNotMatch(s, /x{200}/);
});

test('briefMapFor reads the rows, prefers the full row, and classifies a 403', async () => {
  const src = (over: Partial<MapSource> = {}): MapSource => ({
    epicRow: async () => epic, mapRows: async () => [map({ content: 'truncated' })], mapRow: async () => map(), ...over,
  });
  const ok = await briefMapFor(src(), ticket(), 'maps-model', C);
  assert.match(ok!, /The inbox text/);
  const denied = await briefMapFor(src({ mapRows: async () => { throw Object.assign(new Error('No READ access'), { status: 403 }); } }), ticket(), 'maps-model', C);
  assert.match(denied!, /not allowed to read/);
  const down = await briefMapFor(src({ mapRows: async () => { throw new Error('boom\nstack'); } }), ticket(), 'maps-model', C);
  assert.match(down!, /failed this run \(boom\)/);
  assert.equal(await briefMapFor(src(), ticket({ epic_id: null }), 'maps-model', C), null);
});

test('the banner carries the Map section after the ticket line, and is unchanged without one', () => {
  const own = (mapBrief?: string | null) => ({ ticket: { id: 't', issue_id: 'ISSUE-1', description: 'x' }, inFlight: () => false, mapBrief });
  const plain = ownRunBanner(own());
  assert.equal(ownRunBanner(own(null)), plain);
  const withMap = ownRunBanner(own('### Map for E\n\nbody'));
  assert.ok(withMap.startsWith(plain));
  assert.match(withMap, /### Map for E/);
});

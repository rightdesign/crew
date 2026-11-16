/**
 * The Map behind a ticket, handed to the lane in its brief (CREW-3444).
 *
 * A ticket filed from an epic's Map cites it ("Map v1 §11"). The Map is a row
 * of the tracker's `Maps` table linked to the epic, not a file in any
 * repository, so a lane that goes looking for it in the checkout finds
 * nothing and stalls. This module renders the section of the run's brief that
 * puts the document in front of the lane, or says plainly why it cannot.
 *
 * Rules, all pure so they are tested without a tracker:
 *   - **No epic, or no Maps table: nothing.** The brief is byte-for-byte what
 *     it was, so a workspace that never adopted Maps sees no change.
 *   - **Only the active Map is ever supplied.** A draft is not a settled
 *     plan and a superseded one is a retired plan; handing either over in
 *     place of the active one would send a lane to build the wrong thing, so
 *     an epic with only those is told there is no active Map. With several
 *     active rows the highest version wins.
 *   - **A document too long to include whole** gets the sections the ticket
 *     cites, in full, an outline of every heading, and the way to fetch the
 *     rest. A citation is a `§` followed by a heading number; a Map's own
 *     headings carry those numbers (`## 11. Title`, `## §11 Title`).
 *   - **The interview record is never included**, only pointed at.
 *   - **An unreadable Map is named, not hidden**: a seat refused by the
 *     tracker is told so, and so is a fetch that failed for another reason.
 */

import type { Contract } from './contract.ts';
import type { EpicRow } from './epics.ts';
import { epicLabel } from './epics.ts';
import { isForbiddenError } from './seat-read-probe.ts';
import type { Ticket } from './tracker.ts';

export interface MapRow {
  id: string;
  updated_at?: string;
  [k: string]: unknown;
}

/** What the brief may inline whole; a longer document is cut down to what the ticket cites. */
export const MAP_INLINE_LIMIT = 20_000;

/** How the Map's rows came back: the rows, or why they did not. */
export type MapsRead = { rows: MapRow[] } | { forbidden: true } | { failed: string };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Section numbers a text cites: `§11`, `§ 3.2`, `§§4, 6 and 8`, `§5-7`, in first-seen order. */
export function citedSections(...texts: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const add = (n: string) => { if (n && !out.includes(n)) out.push(n); };
  const re = /§+\s*(\d+(?:\.\d+)*)((?:\s*(?:,|and|&|–|-|to)\s*§?\s*\d+(?:\.\d+)*)*)/g;
  for (const text of texts) {
    for (const m of (text ?? '').matchAll(re)) {
      const nums = [m[1]!];
      const tail = m[2] ?? '';
      const parts = tail.split(/\s*(?:,|and|&|–|-|to)\s*/).map((p) => p.replace(/^§\s*/, '').trim()).filter(Boolean);
      const isRange = /^\s*(?:–|-|to)\s*/.test(tail) && parts.length === 1;
      if (isRange && /^\d+$/.test(m[1]!) && /^\d+$/.test(parts[0]!)) {
        const lo = Number(m[1]), hi = Number(parts[0]);
        if (hi > lo && hi - lo <= 20) for (let n = lo + 1; n <= hi; n++) nums.push(String(n));
      } else nums.push(...parts);
      nums.forEach(add);
    }
  }
  return out;
}

interface Heading { line: number; level: number; number: string | null; text: string }

/** The Markdown headings of a document, with the section number each one carries, if any. */
export function headingsOf(doc: string): Heading[] {
  const out: Heading[] = [];
  let fenced = false;
  doc.split('\n').forEach((raw, line) => {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; return; }
    if (fenced) return;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (!m) return;
    const num = /^§?\s*(\d+(?:\.\d+)*)\.?(?=\s|$)/.exec(m[2]!);
    out.push({ line, level: m[1]!.length, number: num ? num[1]! : null, text: m[2]! });
  });
  return out;
}

/** The text of section `n`: its heading down to the next heading of the same or a higher level. */
export function sectionText(doc: string, n: string): string | null {
  const hs = headingsOf(doc);
  const i = hs.findIndex((h) => h.number === n);
  if (i < 0) return null;
  const lines = doc.split('\n');
  const end = hs.slice(i + 1).find((h) => h.level <= hs[i]!.level)?.line ?? lines.length;
  return lines.slice(hs[i]!.line, end).join('\n').trimEnd();
}

/** The active Map of an epic: the highest version among the rows at the active status. */
export function activeMap(rows: MapRow[], c: Contract): MapRow | null {
  const m = c.maps;
  const active = rows.filter((r) => str(r[m.statusColumn]) === m.activeStatus);
  if (!active.length) return null;
  const ver = (r: MapRow) => (typeof r[m.versionColumn] === 'number' ? (r[m.versionColumn] as number) : 0);
  return [...active].sort((a, b) => ver(b) - ver(a) || str(b.updated_at).localeCompare(str(a.updated_at)))[0]!;
}

export interface MapBriefInput {
  ticket: Ticket;
  epic: EpicRow | undefined;
  /** Absent when this workspace has no Maps table: the section is then not rendered at all. */
  mapsModelId: string | undefined;
  maps: MapsRead;
  /** The active Map's own row, read in full; absent when it could not be. */
  full?: MapRow | null;
  contract: Contract;
}

const fence = (s: string): string => {
  let ticks = '````';
  while (s.includes(ticks)) ticks += '`';
  return `${ticks}markdown\n${s}\n${ticks}`;
};

const NO_SEARCH = 'It is not in the repository, so do not search the checkout for it.';

/** How to read a Map in full, naming the row, never a path. */
function howToRead(modelId: string, row: MapRow, c: Contract): string {
  return `Read the whole Map with the tracker MCP tool \`records_controller_find_one\` ` +
    `(\`dataModelId\` \`${modelId}\`, \`recordId\` \`${row.id}\`): its \`${c.maps.contentColumn}\` field is the document` +
    `, and its \`${c.maps.conversationColumn}\` field is the interview record behind the decisions, which you read only when you need the reasoning.`;
}

const PRECEDENCE = 'The Map is the planning decision this ticket was derived from. Where it differs from the ' +
  'ticket\'s own text or a later comment on the ticket, the ticket and its comments win.';

/**
 * The brief section for one ticket, or `null` when the ticket has no epic or
 * the workspace no Maps table (the brief is then unchanged).
 */
export function mapBriefSection(i: MapBriefInput): string | null {
  const c = i.contract;
  const epicId = i.ticket[c.columns.epic];
  if (typeof epicId !== 'string' || !epicId || !i.mapsModelId) return null;
  const label = i.epic ? (str(i.epic.label) || epicLabel(i.epic, c)) : String(epicId);
  const head = `### Map for ${label}`;

  if ('forbidden' in i.maps) {
    return `${head}\n\nThis ticket belongs to ${label}, whose Map holds the planning decisions behind it. Your seat is not allowed to read the Maps table, so ` +
      `the Map is not supplied. It lives in the tracker. ${NO_SEARCH} Work from the ticket and its comments; if you need something only the Map would say, ask on the ticket.`;
  }
  if ('failed' in i.maps) {
    return `${head}\n\nThis ticket belongs to ${label}, whose Map holds the planning decisions behind it. Reading it failed this run (${i.maps.failed}), so it is not supplied. ` +
      `It lives in the tracker's Maps table (\`${i.mapsModelId}\`), filtered to the epic's row \`${epicId}\`. ${NO_SEARCH}`;
  }
  const row = activeMap(i.maps.rows, c);
  if (!row) {
    const others = i.maps.rows.map((r) => `v${r[c.maps.versionColumn] ?? '?'} ${str(r[c.maps.statusColumn]) || 'no status'}`);
    const have = others.length ? ` Its Maps are not active (${others.join(', ')}), and a Map that is not active is not a settled plan, so none is supplied.` : ' It has no Map.';
    return `${head}\n\n${label} has no active Map.${have} ${NO_SEARCH} Work from the ticket and its comments.`;
  }

  // Prefer the full row (the list call may not return a long document intact).
  const doc = str((i.full ?? row)[c.maps.contentColumn]);
  const title = str(row[c.maps.titleColumn]);
  const version = row[c.maps.versionColumn];
  const intro = `This ticket belongs to ${label}. Its active Map${title ? `, "${title}"` : ''}${version != null ? ` (version ${version})` : ''}, ` +
    `is below. It is a record in the tracker's Maps table, not a file in the repository, so a citation such as "Map v1 §11" in the ticket refers to this document. ${PRECEDENCE} ` +
    `The interview record is not included.`;
  if (!doc.trim()) {
    return `${head}\n\n${intro}\n\nThe document is empty. ${howToRead(i.mapsModelId, row, c)}`;
  }

  const cited = citedSections(i.ticket.title as string | undefined, i.ticket.description as string | undefined);
  const hs = headingsOf(doc);
  const where = cited.map((n) => {
    const h = hs.find((x) => x.number === n);
    return h ? `§${n} is the section headed "${h.text}"` : `§${n} has no section of that number in this document`;
  });
  const cites = where.length ? `\n\nThe ticket cites: ${where.join('; ')}.` : '';

  if (doc.length <= MAP_INLINE_LIMIT) {
    return `${head}\n\n${intro}${cites}\n\n${fence(doc)}\n\n${howToRead(i.mapsModelId, row, c)}`;
  }

  const parts = cited.map((n) => ({ n, text: sectionText(doc, n) })).filter((p): p is { n: string; text: string } => p.text != null);
  const outline = hs.map((h) => `${'  '.repeat(Math.max(0, h.level - 1))}- ${h.text}`).join('\n');
  const body = parts.length
    ? parts.map((p) => `#### §${p.n}, in full\n\n${fence(p.text)}`).join('\n\n')
    : 'The ticket cites no section that could be found, so none is included.';
  return `${head}\n\n${intro}${cites}\n\n` +
    `The document is ${doc.length.toLocaleString('en-US')} characters, too long to include whole. The sections the ticket cites follow in full; the outline lists every heading.\n\n` +
    `${body}\n\n#### Outline of the whole document\n\n${outline}\n\n${howToRead(i.mapsModelId, row, c)}`;
}

/** The slice of the tracker this needs; a test stands in for it. */
export interface MapSource {
  epicRow(id: string): Promise<EpicRow | undefined>;
  mapRows(epicId: string): Promise<MapRow[]>;
  mapRow(id: string): Promise<MapRow>;
}

/**
 * Reads what the section needs, and renders it. Never throws: a failure here
 * must not stop a run, so it becomes the section that says the Map could not
 * be read. Returns `null` for a ticket the section does not apply to.
 */
export async function briefMapFor(
  src: MapSource, ticket: Ticket, mapsModelId: string | undefined, contract: Contract,
): Promise<string | null> {
  const epicId = ticket[contract.columns.epic];
  if (typeof epicId !== 'string' || !epicId || !mapsModelId) return null;
  const epic = await src.epicRow(epicId).catch(() => undefined);
  let maps: MapsRead;
  try {
    maps = { rows: await src.mapRows(epicId) };
  } catch (e) {
    maps = isForbiddenError(e) ? { forbidden: true } : { failed: (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 160) };
  }
  let full: MapRow | null = null;
  if ('rows' in maps) {
    const row = activeMap(maps.rows, contract);
    if (row) {
      try { full = await src.mapRow(row.id); } catch (e) {
        if (isForbiddenError(e)) maps = { forbidden: true };
      }
    }
  }
  return mapBriefSection({ ticket, epic, mapsModelId, maps, full, contract });
}

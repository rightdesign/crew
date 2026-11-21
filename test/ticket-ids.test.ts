// Guard: a ticket id (CREW-123, TABL-123, ISSUE-123 ...) cited as provenance in
// text crew shows an operator, writes into a repo or publishes as documentation
// means nothing to the reader. Ids stay in code comments. This test scans string
// literals under src/ and the published docs pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ID = /\b(?:TABL|CREW|CMAC|EPIC|ISSUE)-\d+\b/;
// Ids that are examples of the accepted ticket-number format, not provenance.
const EXAMPLE_NUMBERS = new Set(['0', '000', '57', '123', '204', '326']);
// Histories whose subject is the tickets themselves.
const DOCS_SKIPPED = new Set(['prompt-rationale.md', 'MIGRATION.md']);

function provenanceIds(text: string): string[] {
  return [...text.matchAll(new RegExp(ID.source, 'g'))]
    .map((m) => m[0])
    .filter((id) => !EXAMPLE_NUMBERS.has(id.split('-')[1]!));
}

/** The string-literal text of a source line, with `//` and block comments removed. */
function stringText(line: string): string {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
  let out = '';
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '\\') { out += line[i + 1] ?? ''; i++; continue; }
      if (c === q) { q = null; out += ' '; continue; }
      out += c;
    } else if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '/' && (line[i + 1] === '/' || line[i + 1] === '*')) break;
  }
  return out;
}

test('no ticket id appears in a string literal under src/', () => {
  const found: string[] = [];
  for (const f of readdirSync('src').filter((n) => n.endsWith('.ts'))) {
    readFileSync(join('src', f), 'utf8').split('\n').forEach((line, i) => {
      if (/ticket-id-ok/.test(line)) return;
      const ids = provenanceIds(stringText(line));
      if (ids.length) found.push(`src/${f}:${i + 1}: ${ids.join(', ')}`);
    });
  }
  assert.deepEqual(found, [], 'reword the message without the id (or mark a format example with ticket-id-ok)');
});

test('published docs pages cite ticket ids only as format examples', () => {
  const found: string[] = [];
  for (const f of readdirSync('docs').filter((n) => n.endsWith('.md') && !DOCS_SKIPPED.has(n))) {
    readFileSync(join('docs', f), 'utf8').split('\n').forEach((line, i) => {
      const ids = provenanceIds(line);
      if (ids.length) found.push(`docs/${f}:${i + 1}: ${ids.join(', ')}`);
    });
  }
  assert.deepEqual(found, []);
});

/**
 * The file-editing primitives the Pair installers share (CREW-1517, CREW-1520):
 * the managed instructions block and the one-table TOML editor. Separate from
 * `pair-install.ts` so an adapter can own its installer without an import cycle
 * through the installer registry.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PairVerdict } from './pair-install.ts';

export type McpFileState = { state: 'missing' } | { state: 'registered' } | { state: 'different'; detail: string };

export const PAIR_BLOCK_START = '<!-- crew:pair start -->';
export const PAIR_BLOCK_END = '<!-- crew:pair end -->';
export const PAIR_KEY_VAR = 'CREW_API_KEY';
export const SERVER = 'tablation';

// ── Managed instructions block ──────────────────────────────────────────────

/** What the block tells the agent. `harness` lets `crew agents prompt pair` say which CLI it serves. */
export function pairBlock(harness: string): string {
  return [
    PAIR_BLOCK_START,
    '## Tablation Pair (managed by `crew connect` — edit nothing between the markers)',
    '',
    'At the start of every session, run `crew agents prompt pair --harness ' + harness + '` and follow what it prints.',
    `The Tablation tracker tools come from the \`${SERVER}\` MCP server; its key is read from \`$${PAIR_KEY_VAR}\`.`,
    PAIR_BLOCK_END,
  ].join('\n');
}

const BLOCK_RE = new RegExp(`${escapeRe(PAIR_BLOCK_START)}[\\s\\S]*?${escapeRe(PAIR_BLOCK_END)}\\n?`);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function hasPairBlock(text: string): boolean {
  return BLOCK_RE.test(text);
}

/** A start marker with no end (or the reverse) is not ours to guess about; callers refuse to write. */
export function pairBlockIsBroken(text: string): boolean {
  return !hasPairBlock(text) && (text.includes(PAIR_BLOCK_START) || text.includes(PAIR_BLOCK_END));
}

/** Insert the block, or replace the existing one in place. Foreign content is preserved. */
export function upsertPairBlock(text: string, block: string): string {
  if (hasPairBlock(text)) return text.replace(BLOCK_RE, () => `${block}\n`);
  if (text.trim() === '') return `${block}\n`;
  return `${text.replace(/\n*$/, '')}\n\n${block}\n`;
}

/** Remove the block and the blank line that separated it from what precedes it. */
export function removePairBlock(text: string): string {
  if (!hasPairBlock(text)) return text;
  return text.replace(new RegExp(`\\n*${BLOCK_RE.source}`), '\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

export function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

export function writeFileMkdir(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Install the block into `path`; returns what happened. */
export function installBlockFile(path: string, harness: string, dryRun?: boolean): { changed: boolean; error?: string } {
  const before = readIfExists(path) ?? '';
  if (pairBlockIsBroken(before)) return { changed: false, error: `${path} has an unmatched ${PAIR_BLOCK_START}/${PAIR_BLOCK_END} marker — fix it by hand` };
  const after = upsertPairBlock(before, pairBlock(harness));
  if (after === before) return { changed: false };
  if (!dryRun) writeFileMkdir(path, after);
  return { changed: true };
}

export function removeBlockFile(path: string, dryRun?: boolean): boolean {
  const before = readIfExists(path);
  if (before === undefined || !hasPairBlock(before)) return false;
  if (dryRun) return true;
  const after = removePairBlock(before);
  if (after.trim() === '') rmSync(path);
  else writeFileSync(path, after);
  return true;
}

export function blockVerdict(path: string, harness: string): PairVerdict {
  const text = readIfExists(path);
  if (text === undefined || !hasPairBlock(text)) return { ok: false, detail: `no managed block in ${path}` };
  if (!text.includes(pairBlock(harness))) return { ok: false, detail: `the managed block in ${path} is out of date — run crew connect` };
  return { ok: true, detail: '' };
}

// ── TOML (Codex): edit one table, leave every other byte alone ─────────────

const HEADER_RE = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;

/** Normalizes `mcp_servers."tablation"` and `mcp_servers.tablation` to one spelling. */
const tableName = (raw: string): string => raw.replace(/["']/g, '').replace(/\s*\.\s*/g, '.');

/** Line range [start, end) of the named table, header included, or undefined. */
export function tomlTableRange(lines: string[], name: string): [number, number] | undefined {
  const start = lines.findIndex((l) => {
    const m = HEADER_RE.exec(l);
    return m !== null && tableName(m[1]!) === name;
  });
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (HEADER_RE.test(lines[i]!)) { end = i; break; }
  }
  // Trailing blank lines belong to the gap before the next table, not to this one.
  while (end > start + 1 && lines[end - 1]!.trim() === '') end--;
  return [start, end];
}

export const tomlString = (v: string): string => JSON.stringify(v);

export function upsertTomlTable(text: string, name: string, table: string[]): string {
  const lines = text.split('\n');
  const r = tomlTableRange(lines, name);
  if (r) {
    lines.splice(r[0], r[1] - r[0], ...table);
    return lines.join('\n');
  }
  const body = text.replace(/\n*$/, '');
  return body === '' ? `${table.join('\n')}\n` : `${body}\n\n${table.join('\n')}\n`;
}

/** Removes the named table and any `name.child` sub-tables (e.g. `[mcp_servers.x.env]`). */
export function removeTomlTable(text: string, name: string): string {
  const lines = text.split('\n');
  let r = tomlTableRange(lines, name);
  if (!r) return text;
  while (r) {
    let [start, end] = r;
    // Swallow the blank line that separated this table from what precedes it.
    if (start > 0 && lines[start - 1]!.trim() === '') start--;
    lines.splice(start, end - start);
    const childName = lines
      .map((l) => HEADER_RE.exec(l))
      .map((m) => (m ? tableName(m[1]!) : undefined))
      .find((n) => n !== undefined && n.startsWith(`${name}.`));
    r = childName === undefined ? undefined : tomlTableRange(lines, childName);
  }
  const out = lines.join('\n').replace(/^\n+/, '');
  return out.trim() === '' ? '' : out.replace(/\n*$/, '\n');
}

export function tomlValue(lines: string[], range: [number, number], key: string): string | undefined {
  for (let i = range[0] + 1; i < range[1]; i++) {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(lines[i]!);
    if (m) return m[1];
  }
  return undefined;
}


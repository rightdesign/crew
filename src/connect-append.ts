/**
 * CREW-3914: `crew connect` adds a route to a `crew.yaml` that already exists.
 *
 * The edit is textual, not a parse-and-stringify: the file is hand-maintained,
 * so every byte outside the inserted block (comments included) is preserved.
 * The yaml document is read only to find where the `routes:` sequence ends.
 * Anything that cannot be extended safely is reported as a reason, and the
 * caller keeps the print-and-paste path.
 */

import { chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isMap, isSeq, parseDocument } from 'yaml';
import { loadConfig } from './config.ts';

export type AppendResult = { ok: true; text: string } | { ok: false; reason: string };

/** The text of `config` with `block` (one `  - route:` entry) added last under `routes:`. */
export function appendRouteBlock(config: string, block: string): AppendResult {
  const doc = parseDocument(config);
  if (doc.errors.length > 0) return { ok: false, reason: 'crew.yaml is not valid YAML' };
  if (!isMap(doc.contents)) return { ok: false, reason: 'crew.yaml has no routes: list' };
  const routes = doc.contents.get('routes', true);
  if (!isSeq(routes) || !routes.range) return { ok: false, reason: 'crew.yaml has no routes: list to extend' };
  const body = block.replace(/\n+$/, '');

  if (routes.items.length === 0) {
    // `routes: []` — the flow brackets are replaced by the block.
    if (!routes.flow) return { ok: false, reason: 'routes: is written in a form that cannot be extended' };
    let start = routes.range[0];
    while (start > 0 && (config[start - 1] === ' ' || config[start - 1] === '\t')) start--;
    return { ok: true, text: `${config.slice(0, start)}\n${body}${config.slice(routes.range[1])}` };
  }
  if (routes.flow) return { ok: false, reason: 'routes: is written as an inline list that cannot be extended' };

  const first = routes.items[0];
  if (!isMap(first) || !first.range) return { ok: false, reason: 'routes: holds an entry that is not a mapping' };
  // The dash of the first entry sets the column the new entry uses.
  const lineStart = config.lastIndexOf('\n', first.range[0] - 1) + 1;
  const dashCol = config.slice(lineStart, first.range[0]).indexOf('-');
  if (dashCol < 0) return { ok: false, reason: 'routes: is written in a form that cannot be extended' };
  const shift = dashCol - 2;
  const lines = body.split('\n').map((l) => (shift >= 0 ? ' '.repeat(shift) + l : l.slice(Math.min(-shift, l.length - l.trimStart().length))));
  const indented = lines.join('\n');

  // After the last entry's own text, at the end of its line.
  const lastEnd = routes.range[1];
  let eol = config.indexOf('\n', Math.max(0, lastEnd - 1));
  if (eol < 0) return { ok: true, text: `${config}\n${indented}\n` };
  eol += 1;
  return { ok: true, text: `${config.slice(0, eol)}${indented}\n${config.slice(eol)}` };
}

/**
 * Replace `path` with `text` atomically (a sibling temp file, then rename),
 * keeping the original's mode. The temp file is removed when anything fails.
 */
export function replaceFileKeepingMode(path: string, text: string): void {
  const mode = statSync(path).mode & 0o7777;
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, text, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (e) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw e;
  }
}

/**
 * The text of `configFile` with `block` appended under `routes:`, or why it cannot be.
 * The result must pass the config loader before anything replaces the file.
 */
export function planAppendToConfig(crewHome: string, configFile: string, route: string, block: string, keyPersisted: boolean): AppendResult {
  if (!keyPersisted) return { ok: false, reason: 'no stored key to name' };
  let current: string;
  try { current = readFileSync(configFile, 'utf8'); } catch (e) { return { ok: false, reason: `could not read the file: ${(e as Error).message}` }; }
  const r = appendRouteBlock(current, block);
  if (!r.ok) return r;
  try {
    // The loader drops a route it cannot parse when others load, so the new one must be among the survivors.
    const loaded = loadConfig(crewHome, configFile, { text: r.text });
    if (!loaded.routes.some((x) => x.route === route)) return { ok: false, reason: 'the config loader dropped the new route' };
  } catch (e) {
    return { ok: false, reason: `the config loader rejected the result: ${(e as Error).message.split('\n')[0]}` };
  }
  return r;
}

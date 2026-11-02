/**
 * The "Repository map" of a brief (EPIC-078 Map v1 §4): what a repository's
 * `map` hook printed, capped so it can never crowd out the ticket.
 *
 * The repository owns the content; the crew owns the budget. Nothing here
 * knows what a good map looks like.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runScript, resolveShell } from './shell.ts';
import type { EnvironmentRepo } from './environment.ts';

/** Characters per token: the estimate the budget is written in. */
const CHARS_PER_TOKEN = 4;
/** A map is a quick outline; a hook that takes longer than this is reported, not waited on. */
const MAP_TIMEOUT_MS = 60_000;

/**
 * Trims `text` to `tokenBudget` tokens (characters divided by four) by
 * dropping whole lines from the bottom, ending with one line saying how much
 * was cut. Text within budget is returned as it came, trailing whitespace
 * aside.
 */
export function budgetMap(text: string, tokenBudget: number): string {
  const body = text.replace(/\s+$/, '');
  const limit = tokenBudget * CHARS_PER_TOKEN;
  if (body.length <= limit) return body;

  const lines = body.split('\n');
  const noteFor = (kept: number) => `… ${lines.length - kept} of ${lines.length} lines cut to fit ship.mapTokenBudget (${tokenBudget} tokens)`;
  // The note counts against the budget too, so the section never exceeds it.
  let kept = lines.length;
  let size = body.length;
  while (kept > 0 && size + 1 + noteFor(kept).length > limit) {
    kept--;
    size -= lines[kept]!.length + 1;
  }
  return [...lines.slice(0, kept), noteFor(kept)].join('\n');
}

/**
 * The repo-relative path a `map` value names when it is a file rather than a
 * command (CREW-2919): a single relative path ending in `.md`, made only of
 * path characters, with no `..` segment. The extension is the whole rule; any
 * other value (spaces, quotes, `$`, `|`, `;`, an absolute path) stays a
 * command for the shell. Null when the value is a command.
 */
export function mapFilePath(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!/^[A-Za-z0-9_.+@-]+(?:\/[A-Za-z0-9_.+@-]+)*\.md$/i.test(v)) return null;
  if (v.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  return v;
}

/** What `crew repos check` and `crew doctor` say about a file-form `map`. */
export interface MapFileReport { path: string; exists: boolean; lines: number; tokens: number }

/** Reads the file-form map under `dir` without budgeting it. */
export function inspectMapFile(dir: string, path: string): MapFileReport {
  try {
    const text = readFileSync(join(dir, path), 'utf8').replace(/\s+$/, '');
    return { path, exists: true, lines: text ? text.split('\n').length : 0, tokens: Math.ceil(text.length / CHARS_PER_TOKEN) };
  } catch {
    return { path, exists: false, lines: 0, tokens: 0 };
  }
}

/** What a repository's `map` hook came to: text for the brief, or one line saying why there is none. */
export type MapOutcome = { text: string } | { skipped: string };

/**
 * Runs the repository's `map` hook (or reads its `.md` file) from `dir` and budgets its output. Never
 * throws: a hook that exits non-zero or prints nothing is `skipped` with the
 * reason, and the brief simply has no map.
 */
export function loadRepoMap(repo: EnvironmentRepo, tokenBudget: number, shellFallback?: string): Promise<MapOutcome> {
  const script = repo.config.hooks.map;
  if (!script) return Promise.resolve({ skipped: '' });
  // CREW-2919: a `.md` path is the map itself, read from the checkout; never run.
  const file = mapFilePath(script);
  if (file) {
    const m = inspectMapFile(repo.dir, file);
    if (!m.exists) return Promise.resolve({ skipped: `the \`map\` file ${file} for ${repo.name} is missing or unreadable, so the brief has no repository map` });
    let text = '';
    try { text = readFileSync(join(repo.dir, file), 'utf8'); } catch { /* raced away: treated as empty */ }
    if (!text.trim()) return Promise.resolve({ skipped: `the \`map\` file ${file} for ${repo.name} is empty, so the brief has no repository map` });
    return Promise.resolve({ text: budgetMap(text, tokenBudget) });
  }
  // Not cached: the daemon is long-lived, so a cache here would pin a stale
  // map (or a transient failure) until restart. One run per brief assembly.
  return runScript(script, {
    cwd: repo.dir,
    shell: resolveShell(repo.config.shell ?? shellFallback),
    env: { CREW_REPO: repo.name },
    timeoutMs: MAP_TIMEOUT_MS,
  }).then(
      (r): MapOutcome => {
        if (r.code !== 0) return { skipped: `the \`map\` hook for ${repo.name} exited ${r.code}, so the brief has no repository map` };
        if (!r.stdout.trim()) return { skipped: `the \`map\` hook for ${repo.name} printed nothing, so the brief has no repository map` };
        return { text: budgetMap(r.stdout, tokenBudget) };
      },
    (e: unknown): MapOutcome => ({ skipped: `the \`map\` hook for ${repo.name} could not run (${e instanceof Error ? e.message : String(e)}), so the brief has no repository map` }),
  );
}

/**
 * Fills `map` on every repo that declares the hook. A skipped hook leaves the
 * repo without a map and sets `mapSkipped`, which the brief turns into one
 * line for the progress comment.
 */
export async function withRepoMaps(
  repos: EnvironmentRepo[], tokenBudget: number, shellFallback?: string,
): Promise<EnvironmentRepo[]> {
  return Promise.all(repos.map(async (r) => {
    if (!r.config.hooks.map) return r;
    const out = await loadRepoMap(r, tokenBudget, shellFallback);
    if ('skipped' in out) return out.skipped ? { ...r, mapSkipped: out.skipped } : r;
    return { ...r, map: out.text };
  }));
}

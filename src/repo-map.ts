/**
 * The "Repository map" of a brief (EPIC-078 Map v1 §4): what a repository's
 * `map` hook printed, capped so it can never crowd out the ticket.
 *
 * The repository owns the content; the crew owns the budget. Nothing here
 * knows what a good map looks like.
 */

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

/** What a repository's `map` hook came to: text for the brief, or one line saying why there is none. */
export type MapOutcome = { text: string } | { skipped: string };

/**
 * Runs the repository's `map` hook from `dir` and budgets its output. Never
 * throws: a hook that exits non-zero or prints nothing is `skipped` with the
 * reason, and the brief simply has no map.
 */
export function loadRepoMap(repo: EnvironmentRepo, tokenBudget: number, shellFallback?: string): Promise<MapOutcome> {
  const script = repo.config.hooks.map;
  if (!script) return Promise.resolve({ skipped: '' });
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

import { existsSync } from 'node:fs';

/**
 * The base-branch part of `crew doctor`'s per-repo report (CREW-1796).
 *
 * A nonexistent directory reaches `execFileSync` as a bad `cwd`, which Node
 * reports as `spawnSync git ENOENT` — the same message as a missing git
 * binary — so a route copied from an example read as "git is not installed".
 * Check the directory first, with the wording `routeProblems` uses, and keep
 * any other git failure (not a repository, permissions) from aborting the
 * whole report.
 */
export function doctorBaseReport(
  r: { dir: string },
  base: string,
  health: (r: never) => { action: string; unsafe: boolean; detail: string },
): { text: string; failed: boolean; skipRest: boolean } {
  const pad = '                   ';
  if (!existsSync(r.dir)) {
    return {
      text: `${pad}- ${r.dir} is missing on disk — no .crew.yaml read, settings above are defaults\n`,
      failed: true,
      skipRest: true,
    };
  }
  try {
    const bh = health(r as never);
    if (bh.action === 'not-applicable') return { text: '', failed: false, skipRest: false };
    return {
      text: `${pad}base ${base}: ${bh.unsafe ? 'ERROR — ' : ''}${bh.detail}\n`,
      failed: bh.unsafe,
      skipRest: false,
    };
  } catch (e) {
    return {
      text: `${pad}base ${base}: could not check — ${e instanceof Error ? e.message : String(e)}\n`,
      failed: true,
      skipRest: false,
    };
  }
}

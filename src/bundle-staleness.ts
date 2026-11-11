import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CREW-3236: a checkout whose `dist/cli.js` predates its source runs old code
 * while `crew --version` (read from `package.json` at run time) names the new
 * release. The build injects the version it was built from as
 * `__CREW_BUILT_VERSION__` (tsup.config.ts `define`); nothing defines it when
 * running from source, from an npm install's own bundle (no `src/` beside it)
 * or a compiled binary, and those can't drift, so the check is silent there.
 */
declare const __CREW_BUILT_VERSION__: string | undefined;

/** The version this bundle was built from, or null when not running a built bundle. */
export function builtVersion(): string | null {
  return typeof __CREW_BUILT_VERSION__ === 'string' ? __CREW_BUILT_VERSION__ : null;
}

export const REBUILD_HINT = 'rebuild with npm run build';

export interface Staleness {
  /** `version` = built from another release than package.json names; `source` = same version, source edited since. */
  kind: 'version' | 'source';
  builtVersion: string;
  message: string;
}

/** Newest mtime (ms) of any file under `path`; 0 when it does not exist. */
export function newestMtime(path: string): number {
  let stat;
  try { stat = statSync(path); } catch { return 0; }
  if (stat.isFile()) return stat.mtimeMs;
  if (!stat.isDirectory()) return 0;
  let latest = stat.mtimeMs;
  for (const e of readdirSync(path, { withFileTypes: true })) latest = Math.max(latest, newestMtime(join(path, e.name)));
  return latest;
}

export interface StalenessInput {
  /** The version injected at build time; null when this is not a built bundle. */
  built: string | null;
  /** `package.json`'s version in the checkout. */
  current: string;
  /** The checkout root. */
  home: string;
  compiled: boolean;
}

/**
 * Null when the bundle is current or the question does not apply. Cheap: one
 * `stat` for the bundle and a walk of `src/` only when the versions match.
 */
export function bundleStaleness(i: StalenessInput): Staleness | null {
  if (i.built === null || i.compiled) return null;
  const src = join(i.home, 'src');
  if (!existsSync(src)) return null; // an npm install: no source beside the bundle
  if (i.built !== i.current) {
    return { kind: 'version', builtVersion: i.built, message: `running a bundle built from ${i.built} (package.json names ${i.current}); ${REBUILD_HINT}` };
  }
  const bundle = statSafe(join(i.home, 'dist', 'cli.js'));
  if (bundle === null) return null;
  if (newestMtime(src) > bundle) {
    return { kind: 'source', builtVersion: i.built, message: `running a bundle older than the source in src/ (both ${i.current}); ${REBUILD_HINT}` };
  }
  return null;
}

function statSafe(p: string): number | null {
  try { return statSync(p).mtimeMs; } catch { return null; }
}

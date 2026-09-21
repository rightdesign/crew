import { resolve } from 'node:path';

/** The launcher every CLI-level test spawns. */
export const CREW = resolve(import.meta.dirname, '..', '..', 'bin', 'crew');

/**
 * Spread into the env of every spawned `bin/crew` (CREW-988).
 *
 * The launcher prefers `dist/cli.js`, and `dist/` is rebuilt by the release's
 * build hook — AFTER the test gate. Without this a CLI-level test exercises
 * the previous release's bundle: new CLI behaviour fails its own tests on
 * main (and the red gate then blocks the very build that would fix it), while
 * a change that breaks the CLI sails through. A fresh worktree has no `dist/`
 * at all, which is why such a test is green for dev and QA and red at release.
 */
export const CREW_ENV = { CREW_FROM_SOURCE: '1' } as const;

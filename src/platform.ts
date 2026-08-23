/**
 * Which ships can run which projects.
 *
 * Two vocabularies, deliberately not the same one:
 *
 *   - A **ship** declares what it IS — a concrete host: macos, linux, windows.
 *   - A **project** declares what it NEEDS — which may be broader than any one
 *     host ("unix" is fine for a repo whose hooks are POSIX shell) or narrower
 *     than a family ("macos" for a project that builds with Xcode).
 *
 * Matching is therefore satisfaction, not equality: `unix` is satisfied by
 * either macOS or Linux, while `macos` is satisfied only by macOS. Collapsing
 * the two into one field is the mistake this module exists to prevent — it
 * would force every POSIX project to either name both hosts or lie.
 *
 * See ISSUE-328. The runner is single-ship today, so the only consumer is
 * `doctor`'s preflight; the same predicate is what cross-ship dispatch will
 * rank with once ships exist (CREW_PRD §8.5).
 */

/** What a ship is. Mirrors the values a Ship record would carry. */
export const SHIP_PLATFORMS = ['macos', 'linux', 'windows'] as const;
export type ShipPlatform = (typeof SHIP_PLATFORMS)[number];

/** What a project requires. A superset of ShipPlatform, plus the families. */
export const PLATFORM_REQUIREMENTS = ['any', 'unix', 'macos', 'linux', 'windows'] as const;
export type PlatformRequirement = (typeof PLATFORM_REQUIREMENTS)[number];

/**
 * Which concrete hosts satisfy each requirement. Adding a host (bsd, say)
 * means adding it here and to SHIP_PLATFORMS — the predicate below never
 * needs to change.
 */
const SATISFIED_BY: Record<PlatformRequirement, readonly ShipPlatform[]> = {
  any: SHIP_PLATFORMS,
  unix: ['macos', 'linux'],
  macos: ['macos'],
  linux: ['linux'],
  windows: ['windows'],
};

/** Node's process.platform, in the Ship vocabulary. */
export function hostPlatform(p: NodeJS.Platform = process.platform): ShipPlatform {
  switch (p) {
    case 'darwin': return 'macos';
    case 'win32': return 'windows';
    default: return 'linux'; // linux and the other POSIX hosts behave alike here
  }
}

export function isShipPlatform(v: string): v is ShipPlatform {
  return (SHIP_PLATFORMS as readonly string[]).includes(v);
}

export function isPlatformRequirement(v: string): v is PlatformRequirement {
  return (PLATFORM_REQUIREMENTS as readonly string[]).includes(v);
}

/** Can this ship take work from a project with this requirement? */
export function satisfies(ship: ShipPlatform, required: PlatformRequirement): boolean {
  return SATISFIED_BY[required].includes(ship);
}

/** Every host that could run this project — what a dispatcher would filter on. */
export function eligibleShips(required: PlatformRequirement): readonly ShipPlatform[] {
  return SATISFIED_BY[required];
}

/** A one-line reason, for a doctor line or a skipped-dispatch log entry. */
export function explain(ship: ShipPlatform, required: PlatformRequirement): string {
  return satisfies(ship, required)
    ? `this ship is ${ship}, and the project requires ${required}`
    : `this ship is ${ship}, but the project requires ${required} ` +
      `(satisfied by: ${eligibleShips(required).join(', ')})`;
}

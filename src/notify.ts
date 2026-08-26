/**
 * Telling somebody what the release did.
 *
 * A hook, and deliberately a thin one: the crew has no icons, colours, target
 * devices or services in it. It hands out a level, a headline and a detail
 * line, and whatever the operator configured decides everything else — a
 * desktop notification, a status widget, a webhook, a push, a log line.
 *
 * This lives on the CONNECTION rather than in a repository's `.crew.yaml`,
 * unlike every other hook. Where release state should be shown is a fact about
 * the machine and the person watching it, not about the code being released:
 * two ships releasing the same repo will want it in different places, and a
 * repo has no business naming someone's notification service.
 *
 * The key was accepted in `crew.yaml` and never invoked for the whole life of
 * the Node port (ISSUE-343) — a configured hook that silently does nothing is
 * worse than one that does not exist, because there is no error to notice.
 */

import type { Route, Ship } from './config.ts';
import type { Emitter } from './events.ts';
import { runScript, resolveShell } from './shell.ts';

export type NotifyLevel = 'ok' | 'warn' | 'fail';

export interface Notification {
  level: NotifyLevel;
  /** One line. What happened. */
  headline: string;
  /** One line. Why, or what to do about it. May be empty. */
  detail?: string;
}

/**
 * Run the route's notify hook, if it has one.
 *
 * Never throws and never fails a release. The work is already done by the time
 * this runs; a broken notifier must not turn a good release into a bad one,
 * and a hook that hangs must not hold the lock — so its output is reported and
 * its failures are warnings.
 */
export async function notify(
  route: Route, ship: Ship, n: Notification, emit: Emitter, dryRun = false,
): Promise<boolean> {
  const script = route.hooks.notify;
  if (!script) return false;

  if (dryRun) {
    emit.emit(`would notify: [${n.level}] ${n.headline}`);
    return true;
  }

  try {
    const r = await runScript(script, {
      cwd: route.dir,
      env: {
        CREW_LEVEL: n.level,
        CREW_HEADLINE: n.headline,
        CREW_DETAIL: n.detail ?? '',
        CREW_ROUTE: route.route,
        CREW_SHIP: ship.name,
      },
      shell: resolveShell(ship.shell),
      onLine: (l) => { if (l.trim()) emit.emit(l.trim(), { data: { hook: 'notify' } }); },
    });
    if (r && r.code !== 0) emit.warn(`notify hook exited ${r.code}`);
    return true;
  } catch (e) {
    emit.warn(`notify hook failed: ${(e as Error).message}`);
    return false;
  }
}

/**
 * What to say about a finished release.
 *
 * Kept apart from sending it so the wording is testable without running
 * anything, and so "what counts as a warning" is one decision in one place.
 */
export function describeRelease(o: {
  deployed?: boolean; confirmed?: boolean; alreadyLive?: boolean; integrated?: boolean;
  version?: string; tag?: string; merged: unknown[]; stopped?: string;
}, route: string): Notification | null {
  if (o.integrated) {
    // Worth saying: something shipped, in the only sense this repo ships.
    return {
      level: 'ok',
      headline: `${route}: integrated ${o.version ?? o.merged.length + ' ticket(s)'}`,
      detail: 'merged to the base branch — this repo has no deploy step',
    };
  }
  if (o.deployed) {
    return {
      level: o.confirmed === false ? 'warn' : 'ok',
      headline: `${route}: released ${o.version ?? 'a new version'}`,
      detail: o.confirmed === false
        // Shipped, but the target never reported the new commit. Not a
        // failure — it may simply be slow — but not a clean success either.
        ? 'deploy ran, but the target did not confirm the new commit in time'
        : `${o.merged.length} ticket(s) shipped`,
    };
  }
  if (o.alreadyLive) return null;   // nothing shipped because nothing needed to
  if (o.stopped === 'tests failed') {
    return {
      level: 'fail',
      headline: `${route}: release blocked — tests failed`,
      detail: 'the target stays on the previous release',
    };
  }
  if (o.stopped === 'deploy failed') {
    return { level: 'fail', headline: `${route}: deploy FAILED`, detail: 'nothing new is live' };
  }
  if (o.stopped === 'build failed') {
    return {
      level: 'fail',
      headline: `${route}: build FAILED`,
      detail: 'the target stays on the previous release — nothing was deployed',
    };
  }
  // Everything else — nothing to release, merge-only, external mode, a dirty
  // tree — is the normal state of most cycles and is not worth interrupting
  // anyone for.
  return null;
}

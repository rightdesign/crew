/**
 * CREW-2528: a verified ticket the release skipped because of this ship's own
 * git refs (a local ticket branch the remote does not agree with) used to be
 * visible only in the event log. This writes one event on the ticket naming
 * the problem and the fix, once per distinct problem.
 */

import { calloutHeader } from './callout.ts';
import type { RunnerEvent, Ticket } from './tracker.ts';

export const LOCAL_REF_SKIP_MARKER = calloutHeader('WARNING', 'Release Skipped');

export function localRefSkipComment(shipName: string, problem: string): string {
  return `${LOCAL_REF_SKIP_MARKER}
> ${problem}

**This ticket is verified but was not released: the release ship's local branch disagrees with the remote.**

Ship ${shipName} found: ${problem}. The release refuses to squash a ref nobody verified and retries every cycle. If the local branch holds only commits already on the base, run \`git branch -f <branch> <remote>/<branch>\` in the release checkout (the crew now does this itself when it can); otherwise a person needs to reconcile the branch.
`;
}

/** Whether this exact problem is already on the ticket. */
export const localRefSkipReported = (ticket: Ticket, problem: string, events: RunnerEvent[]): boolean =>
  events.some((e) => e.record_id === ticket.id && e.event_type === 'local_ref_skip' && (e.message ?? '').includes(problem));

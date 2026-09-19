/**
 * Which open tickets need a PERSON's attention right now (ISSUE-928):
 * `needs_info`, `needs_planning`, `needs_review`. Pure — poll.ts is what
 * reads the previous cycle's set from `State.attention`, diffs it against
 * this cycle's, and turns a NEW (ticket, reason) pair into a notification
 * event with the ticket's public record link.
 */

import type { Contract } from './contract.ts';
import type { Ticket } from './tracker.ts';

export type AttentionReason = 'needs_info' | 'needs_planning' | 'needs_review';

/** Every reason this ticket currently carries, in a fixed order. */
export function attentionReasons(ticket: Ticket, contract: Contract): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  if (ticket.status === contract.statuses.needsHuman) reasons.push('needs_info');
  if (ticket.needs_planning === true) reasons.push('needs_planning');
  if (ticket.needs_review === true) reasons.push('needs_review');
  return reasons;
}

/** One ticket's newly-arrived reasons this cycle. */
export interface AttentionTransition {
  ticketId: string;
  reasons: AttentionReason[];
}

/**
 * (ticket, reason) pairs present in `current` but absent from `previous` —
 * the transition rule from the ticket's own "Decision 2":
 *
 * - present now, absent before -> a transition (emitted).
 * - present both cycles -> nothing.
 * - absent now (ticket closed, or the reason itself cleared) -> simply not
 *   in `current`, so it drops out of whatever the caller persists next —
 *   no special case needed here. If it reappears later it transitions
 *   again, which is the intended "can re-fire" behaviour.
 */
export function attentionTransitions(
  previous: Record<string, AttentionReason[]>,
  current: Record<string, AttentionReason[]>,
): AttentionTransition[] {
  const out: AttentionTransition[] = [];
  for (const [ticketId, reasons] of Object.entries(current)) {
    const before = new Set(previous[ticketId] ?? []);
    const newReasons = reasons.filter((r) => !before.has(r));
    if (newReasons.length > 0) out.push({ ticketId, reasons: newReasons });
  }
  return out;
}

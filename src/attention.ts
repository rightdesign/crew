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

/** One ticket the operator owes an answer on (CREW-1402). */
export interface OperatorTodoItem {
  ticket: Ticket;
  reasons: AttentionReason[];
}

/**
 * What a person owes, for the top of `crew status` (CREW-1402): tickets at
 * `needs_info` that are assigned to the operator, plus every ticket carrying
 * `needs_planning` (a decision gate, whoever holds the assignee). A
 * `needs_info` ticket assigned to someone else is theirs to answer, not the
 * operator's, so it is left out; `needs_review` is not listed because it is a
 * design-lane hand-off the board already surfaces. Pure — the caller supplies
 * the open tickets. One item per ticket, reasons in `attentionReasons` order.
 */
export function operatorTodo(tickets: Ticket[], contract: Contract, operatorId: string): OperatorTodoItem[] {
  const out: OperatorTodoItem[] = [];
  for (const ticket of tickets) {
    const reasons = attentionReasons(ticket, contract).filter(
      (r) => r === 'needs_planning' || (r === 'needs_info' && ticket.assignee_id === operatorId),
    );
    if (reasons.length > 0) out.push({ ticket, reasons });
  }
  return out;
}

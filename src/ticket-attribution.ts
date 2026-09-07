/**
 * Deciding which ticket a run's Agent Log row should cite.
 *
 * A run is planned against one ticket hint — the poll's top candidate,
 * picked before the session even starts (`agent.ts` `planAgentRun`'s
 * `ticket`) — but the spawned session is free to work whatever it actually
 * judges best once it reads the tracker itself. Reporting the log under
 * that pre-run hint regardless produces Agent Log rows that cite one ticket
 * while their transcript discusses a different one entirely, or none at
 * all — the poll hint applied to zero of the turns that followed.
 *
 * The fix: track which ticket key(s) the transcript actually names, turn by
 * turn, weighted by that turn's own token cost (`stream.ts`
 * `extractTurnTokens`), and cite whichever ticket the run spent the most
 * tokens on. A turn that names no ticket is credited to whichever ticket
 * the run was most recently talking about — most turns (reading a file,
 * running a test) don't restate the ticket key every time.
 */

/**
 * This tracker's ticket-key shape, generically — e.g. `ISSUE-430`,
 * `CREW-12`. Never hardcoded to one project's own prefix: `config.ts`'s
 * `issue_prefix` is set per Projects row, so a workspace-specific pattern
 * here would silently stop matching for any area configured differently.
 */
export const TICKET_KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;

/** Every ticket key named in `text`, in the order they appear. */
export function ticketMentions(text: string): string[] {
  return [...text.matchAll(TICKET_KEY_RE)].map((m) => m[0]);
}

/**
 * Accumulates token spend per ticket key across a run's assistant turns.
 * Feed it turn by turn, in order, as the stream is parsed — it needs no
 * buffering of its own.
 */
export class TicketAttributionTracker {
  #tokensByTicket = new Map<string, number>();
  #current: string | undefined;

  /** One assistant turn: its combined visible text (thinking + text blocks) and its own token cost. */
  add(text: string, tokens: number): void {
    const mentions = ticketMentions(text);
    if (mentions.length > 0) this.#current = mentions[mentions.length - 1];
    if (this.#current === undefined || tokens <= 0) return;
    this.#tokensByTicket.set(this.#current, (this.#tokensByTicket.get(this.#current) ?? 0) + tokens);
  }

  /**
   * The ticket key the run spent the most tokens on, or `fallback` (the
   * pre-run poll hint) when the transcript never named one — an
   * administrative run that touches the tracker without discussing a
   * specific ticket in its visible text still has to cite something.
   */
  winner(fallback?: string): string | undefined {
    let best = fallback;
    let bestTokens = -1;
    for (const [ticket, tokens] of this.#tokensByTicket) {
      if (tokens > bestTokens) { best = ticket; bestTokens = tokens; }
    }
    return best;
  }
}

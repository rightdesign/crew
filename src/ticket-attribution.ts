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
  #turns = 0;
  #current: string | undefined;
  /** Tracker record uuid → ticket key, learned when a write names both (a claim resolves the key from the last mention). */
  #keyByRecord = new Map<string, string>();
  #lastBy: Partial<Record<'claim' | 'handoff' | 'comment', string>> = {};

  /**
   * The ticket key most recently named in the transcript, or undefined before any.
   * Only the FIRST key in a turn counts: a closing summary names its own
   * ticket first and then lists others ("Other tickets", "Blocked by", "See
   * also"), and those trailing keys are not what the run worked (CREW-2598).
   */
  get current(): string | undefined { return this.#current; }

  /** Record the mentions in `text` without crediting tokens (a claim needs "which ticket" before the turn's usage line arrives). */
  note(text: string): void {
    const mentions = ticketMentions(text);
    if (mentions.length > 0) this.#current = mentions[0];
  }

  /** One assistant turn: its combined visible text (thinking + text blocks) and its own token cost. */
  add(text: string, tokens: number): void {
    const mentions = ticketMentions(text);
    if (mentions.length > 0) this.#current = mentions[0];
    if (this.#current === undefined || tokens <= 0) return;
    this.#turns++;
    this.#tokensByTicket.set(this.#current, (this.#tokensByTicket.get(this.#current) ?? 0) + tokens);
  }

  /**
   * Record a tool call if it is a ticket-targeted tracker write (claim,
   * hand-off or comment). The ticket key comes from a record uuid seen on an
   * earlier write when known, else from the key last named in the transcript
   * (a claim or hand-off announces its ticket). A comment on a record never
   * seen before is ignored: its uuid cannot be resolved to a key.
   */
  noteWrite(tool: string | undefined, input: Record<string, unknown> | undefined): void {
    const w = classifyWrite(tool, input);
    if (!w) return;
    let key = w.recordId ? this.#keyByRecord.get(w.recordId) : undefined;
    if (w.kind !== 'comment') key ??= this.#current;
    if (!key) return;
    if (w.kind !== 'comment' && w.recordId) this.#keyByRecord.set(w.recordId, key);
    this.#lastBy[w.kind] = key;
  }

  /**
   * How the attribution is decided: a hand-off write beats a claim, a claim
   * beats a comment (so a follow-up ticket filed or commented on while
   * working never displaces the claimed one), and any write beats everything
   * below. Next, `hintMoved` — the post-run read-back showed the hinted
   * ticket changed status or assignee during the run — is a hand-off signal
   * for a run that wrote through MCP tools crew cannot see. Then the
   * mention-token heuristic, which with a hint may override it only when a
   * different ticket holds a strict majority of the credited tokens (a single
   * credited turn, like a lone end-of-run summary naming another ticket,
   * must not). A run with no hint
   * keeps the plain winner. The pre-run hint is last.
   */
  decide(hint?: string, opts: { hintMoved?: boolean } = {}): {
    ticket: string | undefined; by: 'handoff' | 'claim' | 'comment' | 'readback' | 'mentions' | 'hint';
  } {
    for (const by of ['handoff', 'claim', 'comment'] as const) {
      const ticket = this.#lastBy[by];
      if (ticket) return { ticket, by };
    }
    if (hint && opts.hintMoved) return { ticket: hint, by: 'readback' };
    if (this.#tokensByTicket.size > 0) {
      if (!hint) return { ticket: this.winner(), by: 'mentions' };
      const winner = this.winner(hint);
      if (winner === hint) return { ticket: hint, by: 'mentions' };
      let total = 0;
      for (const n of this.#tokensByTicket.values()) total += n;
      const share = (this.#tokensByTicket.get(winner!) ?? 0) / total;
      return share > 0.5 && this.#turns > 1 ? { ticket: winner, by: 'mentions' } : { ticket: hint, by: 'hint' };
    }
    return { ticket: hint, by: 'hint' };
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

/**
 * Whether a tool call is the run claiming a ticket: a tracker record update
 * that sets `status` to `in_progress` (the claim step in every lane brief).
 * The call carries only a record uuid, not the ticket key, so the caller
 * pairs this with `TicketAttributionTracker.current` — the key the agent
 * last named, which it does when announcing the claim.
 */
export function isClaimWrite(tool: string | undefined, input: Record<string, unknown> | undefined): boolean {
  if (!tool || !/records_controller_update$/.test(tool)) return false;
  const body = input?.body;
  return typeof body === 'object' && body !== null && (body as Record<string, unknown>).status === 'in_progress';
}

/** Statuses that hand a ticket on (or park it) rather than claim it. */
const HANDOFF_STATUSES = new Set(['fixed', 'verified', 'needs_info', 'accepted']);

/**
 * Classifies a tool call as a ticket-targeted tracker write: `claim` (status
 * to a building/checking status), `handoff` (status to a hand-off status) or
 * `comment` (a record create carrying `ticket_id`, the Comments table's link).
 * `recordId` is the ticket's uuid for claim/hand-off and for a comment too.
 */
export function classifyWrite(
  tool: string | undefined, input: Record<string, unknown> | undefined,
): { kind: 'claim' | 'handoff' | 'comment'; recordId?: string } | undefined {
  if (!tool) return undefined;
  const body = input?.body;
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as Record<string, unknown>;
  if (/records_controller_update$/.test(tool)) {
    const recordId = typeof input?.recordId === 'string' ? input.recordId : undefined;
    if (b.status === 'in_progress' || b.status === 'qa') return { kind: 'claim', recordId };
    if (typeof b.status === 'string' && HANDOFF_STATUSES.has(b.status)) return { kind: 'handoff', recordId };
  }
  if (/records_controller_create$/.test(tool) && typeof b.ticket_id === 'string') return { kind: 'comment', recordId: b.ticket_id };
  return undefined;
}

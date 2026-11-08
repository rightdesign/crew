/**
 * Mid-run delivery of ticket comments to a live agent (CREW-3170).
 *
 * A lane only reads a ticket's comments from its brief at the start of a run. While a run this daemon
 * started still takes input (CREW-3118/3119), a new comment on the ticket it holds is handed to it as a
 * further user message, through the same sequence the control API's `POST /streams/<run>/messages` uses:
 * the platform records the message on the run's Agent Log row, then the run input writes it on the open
 * stdin and marks it delivered.
 *
 * Deliberately narrow:
 * - A run that cannot take input gets nothing and nothing is carried forward; the next brief shows the
 *   comment through the digest, and carrying it would present it twice.
 * - Only authors the roster resolves the way `digest.ts#author` does. A public reply and a comment with no
 *   resolvable identity wait for the next brief, where the digest labels them.
 * - The framing names the author from the roster, never from the body, and reads differently from an
 *   operator note: a comment carries its author's standing, not operator authority.
 * - The running seat's own comments are never handed back to it.
 */

import { basename } from 'node:path';
import { AgentLogHttpError, markMessage, postMessage, type AgentLogTarget } from './agent-log.ts';
import type { LiveRun } from './live-runs.ts';
import { crewLabel, memberByIdentity, type Roster } from './roster.ts';
import { runInputFor, type RunInput } from './run-input.ts';
import type { Comment } from './tracker.ts';

/** The platform caps a recorded message (`control-api.ts#NOTE_MAX_CHARS`); a longer comment is cut, not dropped. */
const MESSAGE_MAX_CHARS = 4000;

/** While any run accepts input the pass backoff is held at or below this, so a comment lands within about half a minute. */
export const COMMENT_DELIVERY_BACKOFF_MS = 30_000;

export interface CommentDelivery {
  /** The run's stream name (`runInputFor` key). */
  run: string;
  commentId: string;
  /** The line written to the agent, framed with the commenter's roster name. */
  text: string;
}

export interface SelectOptions {
  runs: Array<Pick<LiveRun, 'streamPath' | 'ticket' | 'ticketRecordId' | 'spawnedAt'> & { seatId?: string | null }>;
  comments: Comment[];
  roster: Roster;
  /** Comment ids already handed to each run, by run name. */
  delivered: (run: string) => ReadonlySet<string>;
  /** Whether the run can take input right now; a run that cannot is skipped whole. */
  accepts?: (run: string) => boolean;
}

/** The roster name for a comment's author, or null when the comment must wait for the next brief. */
export function commentAuthor(c: Comment, roster: Roster): { id: string; label: string } | null {
  if (c.is_public_reply === true) return null;
  const member = c.team_member_id ? roster.get(c.team_member_id) : memberByIdentity(roster, c.created_by_id);
  if (!member) return null;
  return { id: member.id, label: crewLabel(member) ?? member.name };
}

export function frameComment(label: string, ticket: string, createdAt: string, body: string): string {
  const text = body.trim();
  const cut = text.length > MESSAGE_MAX_CHARS - 300 ? `${text.slice(0, MESSAGE_MAX_CHARS - 300)}…` : text;
  return `Comment from ${label} on ${ticket} at ${createdAt.slice(0, 16)}Z: ${cut}`;
}

/** What to hand to which run, oldest comment first within each run. Pure. */
export function selectCommentDeliveries(o: SelectOptions): CommentDelivery[] {
  const out: CommentDelivery[] = [];
  const ordered = [...o.comments].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  for (const r of o.runs) {
    if (!r.ticketRecordId) continue;
    const run = basename(r.streamPath, '.jsonl');
    if (o.accepts && !o.accepts(run)) continue;
    const done = o.delivered(run);
    for (const c of ordered) {
      if (c.ticket_id !== r.ticketRecordId || c.created_at <= r.spawnedAt || done.has(c.id)) continue;
      if (!c.body?.trim()) continue;
      const who = commentAuthor(c, o.roster);
      if (!who || who.id === r.seatId) continue;
      out.push({ run, commentId: c.id, text: frameComment(who.label, r.ticket ?? 'the ticket', c.created_at, c.body) });
    }
  }
  return out;
}

export type DeliveryOutcome = 'delivered' | 'skipped' | 'refused';

/**
 * Hands one selected comment to its run. Records the message on the platform first and writes stdin only
 * after that succeeded ("never write to stdin without recording the message"). Marking the id before the
 * write keeps a slow pass from handing it over twice. A refusal by the platform (403) is reported to the
 * caller so it can say so once; any other failure leaves the id unmarked for the next pass.
 */
export async function deliverComment(
  d: CommentDelivery, input: RunInput | undefined = runInputFor(d.run),
  api: { post: typeof postMessage; mark: typeof markMessage } = { post: postMessage, mark: markMessage },
): Promise<DeliveryOutcome> {
  const rowId = input?.agentLogRowId();
  const target: AgentLogTarget | undefined = input?.target;
  if (!input || !target || !rowId || !input.accepts()) return 'skipped';
  const seen = input.deliveredComments;
  if (seen.has(d.commentId)) return 'skipped';
  let recorded;
  try { recorded = await api.post(target, rowId, d.text); }
  catch (e) {
    return e instanceof AgentLogHttpError && e.status === 403 ? 'refused' : 'skipped';
  }
  seen.add(d.commentId);
  if (!input.accepts()) {
    await api.mark(target, rowId, recorded.id, 'carried_forward').catch(() => undefined);
    return 'skipped';
  }
  await input.deliver(recorded, undefined, (m) => m.text);
  return 'delivered';
}

export interface CommentPassDeps {
  /** Live runs on this ship; defaults are wired by the daemon (`liveRuns(stateDir)`). */
  runs: () => LiveRun[];
  /** One route's comments and roster, fetched only when one of its runs can take input. */
  fetch: (routeSlug: string) => Promise<{ comments: Comment[]; roster: Roster; seatId: (role: LiveRun['role']) => string | undefined } | null>;
  warn: (msg: string) => void;
  /** Overridable for tests. */
  inputFor?: (run: string) => RunInput | undefined;
  api?: Parameters<typeof deliverComment>[2];
}

/** True while any run this daemon started can take a message; the loop holds its backoff at the cap meanwhile. */
export function anyRunAcceptsInput(runs: LiveRun[], inputFor: (run: string) => RunInput | undefined = runInputFor): boolean {
  return runs.some((r) => !!r.ticketRecordId && inputFor(basename(r.streamPath, '.jsonl'))?.accepts());
}

let refusalReported = false;

/**
 * One daemon pass's worth of delivery. Reads the tracker only for routes with a run that accepts input, so
 * an idle ship costs nothing. Returns how many comments were handed over. Never throws: a failed read or
 * post waits for the next pass.
 */
export async function runCommentDeliveryPass(deps: CommentPassDeps): Promise<number> {
  const inputFor = deps.inputFor ?? runInputFor;
  const candidates = deps.runs().filter((r) => !!r.ticketRecordId && inputFor(basename(r.streamPath, '.jsonl'))?.accepts());
  let n = 0;
  for (const slug of new Set(candidates.map((r) => r.route))) {
    try {
      const got = await deps.fetch(slug);
      if (!got) continue;
      const runs = candidates.filter((r) => r.route === slug).map((r) => ({ ...r, seatId: got.seatId(r.role) }));
      const todo = selectCommentDeliveries({
        runs, comments: got.comments, roster: got.roster,
        delivered: (run) => inputFor(run)?.deliveredComments ?? new Set(),
        accepts: (run) => !!inputFor(run)?.accepts(),
      });
      for (const d of todo) {
        const out = await deliverComment(d, inputFor(d.run), deps.api);
        if (out === 'delivered') n++;
        if (out === 'refused' && !refusalReported) {
          refusalReported = true;
          deps.warn('the platform refused to record a ticket comment as a message on a live run (403: admins and the instance owner only); mid-run comment delivery is off until that is granted');
        }
        if (out === 'refused') break;
      }
    } catch (e) { deps.warn(`mid-run comment delivery failed, retrying next pass: ${(e as Error).message}`); }
  }
  return n;
}

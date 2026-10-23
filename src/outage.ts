/**
 * CREW-2383: a tracker that is restarting (every release restarts it) or
 * briefly unreachable is routine, not a fault. The daemon classifies a failed
 * pass as transient, backs off on a short schedule, and only escalates when
 * the outage outlasts `OUTAGE_ESCALATE_AFTER` consecutive failures.
 */

/** Retry delays after the 1st, 2nd, 3rd+ consecutive transient failure. */
export const TRANSIENT_BACKOFF_MS = [15_000, 30_000, 60_000];

/** Consecutive transient failures before the one error event and attention item. */
export const OUTAGE_ESCALATE_AFTER = 5;

export const TRACKER_OUTAGE_KEY = 'tracker_unreachable';

const NETWORK_CODES = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'];

/** Delay before the retry that follows the `n`th (1-based) consecutive transient failure. */
export function transientBackoffMs(n: number): number {
  return TRANSIENT_BACKOFF_MS[Math.min(Math.max(n, 1), TRANSIENT_BACKOFF_MS.length) - 1]!;
}

function codeOf(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * True for a network error (`fetch failed`, ECONNRESET, ECONNREFUSED,
 * ETIMEDOUT, EAI_AGAIN), an HTTP 502/503/504, or a non-JSON body where the API
 * should have answered JSON (the proxy's HTML fallback). A 401, a 422 or a
 * thrown bug is not transient.
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  if (msg === 'fetch failed' || msg.startsWith('fetch failed')) return true;
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = codeOf(e);
    if (code && NETWORK_CODES.includes(code)) return true;
  }
  if (NETWORK_CODES.some((c) => msg.includes(c))) return true;
  if (/\b(?:HTTP|status)\s*:?\s*(502|503|504)\b/i.test(msg) || /^(502|503|504)\b/.test(msg)) return true;
  if (err instanceof SyntaxError && /Unexpected token '?<|is not valid JSON|Unexpected end of JSON/.test(msg)) return true;
  return false;
}

/** One line for the log: the cause, no stack. */
export function describeCause(err: unknown): string {
  const first = (err instanceof Error ? err.message : String(err)).split('\n')[0]!;
  const code = codeOf((err as { cause?: unknown } | null)?.cause);
  return code && !first.includes(code) ? `${first} (${code})` : first;
}

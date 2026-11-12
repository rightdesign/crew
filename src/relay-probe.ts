/**
 * `crew doctor`'s end-to-end check of the control API over the relay
 * (CREW-2803, CREW-3276). Two requests with the ship's own key, the same ones
 * a remote monitor makes:
 *
 *  1. `GET <relay url>/control/streams`, a cheap authenticated read that
 *     proves the tunnel, the relay's `control` target and the key together.
 *  2. `GET <relay url>/control/status`, the slow one: the ship builds a whole
 *     status document in a subprocess, which can take well over ten seconds
 *     on a busy ship, so it gets its own, longer timeout and its own verdict.
 *
 * A failure is classified so doctor can say what to do: the relay's 5xx with
 * no JSON body from the ship is the tunnel; 401/403 is a key the ship refuses;
 * a 502 with a JSON `reason` is the ship's own failure to build the document.
 * The key travels only in the Authorization header and is never part of the
 * result.
 */

/** Liveness step. */
export const LIVENESS_TIMEOUT_MS = 10_000;
/** Status step: the control API's subprocess limit (control-api.ts `CREW_JSON_TIMEOUT_MS`, 60 s) plus margin. */
export const STATUS_TIMEOUT_MS = 75_000;

export type RelayFailureKind = 'tunnel_down' | 'key_refused' | 'status_failed' | 'timed_out' | 'http' | 'network';

export type RelayProbe =
  | { ok: true; status: number; latencyMs: number; route?: string }
  | { ok: false; kind: RelayFailureKind; status?: number; error: string; remedy?: string };

const BODY_LIMIT = 4096;

async function boundedText(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, BODY_LIMIT); } catch { return ''; }
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

const oneLine = (s: string, max = 200) => s.replace(/\s+/g, ' ').trim().slice(0, max);

function classify(res: Response, text: string, step: 'liveness' | 'status'): Extract<RelayProbe, { ok: false }> {
  const status = res.status;
  if (status === 401 || status === 403) {
    return { ok: false, kind: 'key_refused', status, error: `the ship's control API refused this route's key (HTTP ${status})`, remedy: 'run `crew connect <route>` to mint and store a key the ship accepts' };
  }
  const body = parseObject(text);
  if (body && typeof body.reason === 'string') {
    const detail = typeof body.detail === 'string' ? `: ${oneLine(body.detail, 400)}` : '';
    return { ok: false, kind: 'status_failed', status, error: `the ship could not build its status document (${body.reason}${detail})`, remedy: 'run `crew status <route> --json` on the ship to see the error' };
  }
  if (status >= 500 && !body) {
    const said = oneLine(text, 80);
    return { ok: false, kind: 'tunnel_down', status, error: `the relay could not reach the ship's tunnel (HTTP ${status}${said ? `, "${said}"` : ''})`, remedy: 'run `crew passengers` and check the tunnel state doctor prints above' };
  }
  return { ok: false, kind: 'http', status, error: `HTTP ${status}${step === 'status' ? ' from /control/status' : ''}` };
}

export async function probeRelayControl(
  relayUrl: string, apiKey: string, userAgent: string,
  fetchFn: typeof fetch = fetch, livenessTimeoutMs = LIVENESS_TIMEOUT_MS, statusTimeoutMs = STATUS_TIMEOUT_MS,
): Promise<RelayProbe> {
  const base = relayUrl.replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${apiKey}`, 'User-Agent': userAgent };
  const step = async (path: string, timeoutMs: number, which: 'liveness' | 'status'): Promise<RelayProbe> => {
    const started = Date.now();
    try {
      const res = await fetchFn(`${base}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      const text = await boundedText(res);
      const latencyMs = Date.now() - started;
      if (res.ok) {
        const route = parseObject(text)?.route;
        return { ok: true, status: res.status, latencyMs, route: typeof route === 'string' ? route : undefined };
      }
      return classify(res, text, which);
    } catch (e) {
      const name = (e as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { ok: false, kind: 'timed_out', error: `no answer from ${path} after ${Math.round((Date.now() - started) / 1000)}s` };
      }
      return { ok: false, kind: 'network', error: (e as Error).message };
    }
  };
  const live = await step('/control/streams', livenessTimeoutMs, 'liveness');
  if (!live.ok) return live;
  const status = await step('/control/status', statusTimeoutMs, 'status');
  return status.ok ? { ...status, latencyMs: live.latencyMs + status.latencyMs } : status;
}

/** The doctor line for a probe result; a failure adds an indented remedy line. */
export function describeRelayProbe(url: string, p: RelayProbe): string {
  if (p.ok) {
    return `relay control:     OK ${url}/control/status (${p.status}, ${p.latencyMs} ms${p.route ? `, route ${p.route}` : ''})`;
  }
  return `relay control:     FAILED ${url}/control/status — ${p.error}${p.remedy ? `\n                   fix: ${p.remedy}` : ''}`;
}

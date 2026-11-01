/**
 * `crew doctor`'s end-to-end check of the control API over the relay
 * (CREW-2803): `GET <relay url>/control/status` with the ship's own key, the
 * same request a remote monitor makes, so a pass proves the tunnel, the
 * relay's `control` target and the control API's auth together. The key
 * travels only in the Authorization header and is never part of the result.
 */

export type RelayProbe =
  | { ok: true; status: number; latencyMs: number }
  | { ok: false; status?: number; error: string };

export async function probeRelayControl(
  relayUrl: string, apiKey: string, userAgent: string,
  fetchFn: typeof fetch = fetch, timeoutMs = 10_000,
): Promise<RelayProbe> {
  const started = Date.now();
  try {
    const res = await fetchFn(`${relayUrl.replace(/\/+$/, '')}/control/status`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': userAgent },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - started;
    // The body is a status document; only the status code matters here.
    await res.arrayBuffer().catch(() => undefined);
    if (res.ok) return { ok: true, status: res.status, latencyMs };
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** The doctor line for a probe result. */
export function describeRelayProbe(url: string, p: RelayProbe): string {
  return p.ok
    ? `relay control:     OK ${url}/control/status (${p.status}, ${p.latencyMs} ms)`
    : `relay control:     FAILED ${url}/control/status — ${p.error}`;
}

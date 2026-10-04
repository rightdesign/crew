/**
 * Self-registration of a Host Passengers tunnel as a workspace MCP endpoint
 * (CREW-1320, TABL-1315 design). The relay no longer writes the tunnel URL
 * onto the Ships row through a synthesis-internal API; the ship itself publishes
 * its tunnel's public URL through the ordinary
 * `/workspaces/<ws>/mcp-endpoints` API, with the route's own key.
 *
 * That key needs the `REGISTER_MCP_ENDPOINTS` capability (TABL-1318), which
 * is API-only and scoped to the endpoints the key's own membership created:
 * `GET` lists only this ship's rows and a PATCH/DELETE of anybody else's id
 * is a 404. A 403 is therefore a configuration gap, not a reason to take a
 * working tunnel down — callers warn and retry next cycle.
 *
 * The endpoint's Authorization header is the container's `mcpSecret` (the
 * credential `passenger-mcp.ts` accepts without an `/auth/me` round trip).
 * Nothing here logs a URL's query, a header, or an API key.
 */

import { createHash } from 'node:crypto';
import { readPersistedTunnel, updatePersistedTunnel, type PersistedTunnel } from './tunnel.ts';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface EndpointApi {
  baseUrl: string;
  apiKey: string;
  userAgent?: string;
  fetchFn?: FetchFn;
}

export interface DesiredEndpoint {
  label: string;
  url: string;
  /** The container's `mcpSecret`; the header is omitted when there is none. */
  mcpSecret?: string;
}

export type RegisterOutcome =
  | { kind: 'ok'; endpointId: string; action: 'created' | 'updated' | 'recreated' }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string };

function endpointsUrl(api: EndpointApi, workspaceId: string, id?: string): string {
  const base = `${api.baseUrl.replace(/\/+$/, '')}/api/workspaces/${workspaceId}/mcp-endpoints`;
  return id ? `${base}/${id}` : base;
}

async function call(
  api: EndpointApi, method: string, url: string, body?: unknown,
): Promise<Response> {
  const f = api.fetchFn ?? fetch;
  return f(url, {
    method,
    headers: {
      Authorization: `Bearer ${api.apiKey}`,
      'User-Agent': api.userAgent ?? 'Mozilla/5.0 CrewAgent',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function bodyFor(d: DesiredEndpoint, forPatch: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { label: d.label, url: d.url };
  if (d.mcpSecret) body.authorizationHeader = `Bearer ${d.mcpSecret}`;
  // PATCH keeps a stored header when the field is omitted, so a secret that
  // went away has to be cleared explicitly.
  else if (forPatch) body.authorizationHeader = null;
  return body;
}

async function create(api: EndpointApi, workspaceId: string, d: DesiredEndpoint): Promise<RegisterOutcome> {
  const res = await call(api, 'POST', endpointsUrl(api, workspaceId), bodyFor(d, false));
  if (res.status === 403) return { kind: 'forbidden' };
  if (!res.ok) return { kind: 'error', message: `register endpoint: ${res.status} ${res.statusText}` };
  const row = (await res.json()) as { id?: string };
  if (!row.id) return { kind: 'error', message: 'register endpoint: response carried no id' };
  return { kind: 'ok', endpointId: row.id, action: 'created' };
}

/**
 * Creates the endpoint, or PATCHes the stored one (URL/header may have
 * changed); a 404 on the stored id means it was deleted out from under us,
 * so it is re-created. Never throws — failures come back as an outcome.
 */
export async function registerEndpoint(
  api: EndpointApi, workspaceId: string, storedId: string | undefined, d: DesiredEndpoint,
): Promise<RegisterOutcome> {
  try {
    if (!storedId) return await create(api, workspaceId, d);
    const res = await call(api, 'PATCH', endpointsUrl(api, workspaceId, storedId), bodyFor(d, true));
    if (res.status === 403) return { kind: 'forbidden' };
    if (res.status === 404) {
      const made = await create(api, workspaceId, d);
      return made.kind === 'ok' ? { ...made, action: 'recreated' } : made;
    }
    if (!res.ok) return { kind: 'error', message: `update endpoint: ${res.status} ${res.statusText}` };
    return { kind: 'ok', endpointId: storedId, action: 'updated' };
  } catch (e) {
    return { kind: 'error', message: (e as Error).message };
  }
}

/** DELETE by stored id; a 404 counts as already gone. Never throws. */
export async function removeEndpoint(
  api: EndpointApi, workspaceId: string, storedId: string,
): Promise<{ kind: 'ok' } | { kind: 'forbidden' } | { kind: 'error'; message: string }> {
  try {
    const res = await call(api, 'DELETE', endpointsUrl(api, workspaceId, storedId));
    if (res.status === 403) return { kind: 'forbidden' };
    if (res.ok || res.status === 404) return { kind: 'ok' };
    return { kind: 'error', message: `remove endpoint: ${res.status} ${res.statusText}` };
  } catch (e) {
    return { kind: 'error', message: (e as Error).message };
  }
}

/** `crew doctor`'s capability probe: `GET` the key's own endpoints. */
export async function probeEndpointAccess(
  api: EndpointApi, workspaceId: string,
): Promise<'ok' | 'forbidden' | { error: string }> {
  try {
    const res = await call(api, 'GET', endpointsUrl(api, workspaceId));
    if (res.ok) return 'ok';
    if (res.status === 403) return 'forbidden';
    return { error: `${res.status} ${res.statusText}` };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export const REGISTER_MCP_ENDPOINTS_HINT =
  'give this key\'s role the REGISTER_MCP_ENDPOINTS capability, e.g. via the group that holds the Crew project role';

export interface ReconcileDeps {
  stateDir: string;
  shipName: string;
  /** The endpoint API for a workspace's route; undefined when no route/key is known for it. */
  apiFor: (workspaceId: string) => EndpointApi | undefined;
  /** The public URL for a slug in this workspace. */
  urlFor: (slug: string) => string;
  warn: (message: string) => void;
}

function registrationKey(url: string, mcpSecret: string | undefined): string {
  return createHash('sha256').update(`${url}\n${mcpSecret ?? ''}`).digest('hex').slice(0, 16);
}

/**
 * Per-cycle: makes the workspace's endpoint row match a `connected` tunnel.
 * Runs every cycle rather than on the connected transition so a 403 (the key
 * lacks `REGISTER_MCP_ENDPOINTS`) or a network error is retried next cycle,
 * without ever touching the tunnel itself. An unchanged registration makes no
 * call at all.
 */
export async function reconcileEndpoint(workspaceId: string, d: ReconcileDeps): Promise<void> {
  const st = readPersistedTunnel(d.stateDir, workspaceId);
  if (!st || st.status !== 'connected' || !st.slug) return;
  const url = d.urlFor(st.slug);
  const key = registrationKey(url, st.mcpSecret);
  if (st.endpointId && st.registeredKey === key) return;
  const api = d.apiFor(workspaceId);
  if (!api) { d.warn(`no API key known for workspace ${workspaceId} — cannot register its MCP endpoint`); return; }
  const out = await registerEndpoint(api, workspaceId, st.endpointId, {
    label: `Ship: ${d.shipName}`, url, mcpSecret: st.mcpSecret,
  });
  if (out.kind === 'ok') {
    updatePersistedTunnel(d.stateDir, workspaceId, { endpointId: out.endpointId, registeredKey: key });
  } else if (out.kind === 'forbidden') {
    d.warn(`could not register this ship's MCP endpoint in workspace ${workspaceId}: 403 — ${REGISTER_MCP_ENDPOINTS_HINT}`);
  } else {
    d.warn(`could not register this ship's MCP endpoint in workspace ${workspaceId}: ${out.message}`);
  }
}

/**
 * Removes the endpoint recorded in `info` (a tunnel torn down, or one that
 * died) and clears the stored id. A 404 is already-gone; any other failure
 * keeps the id so the delete is not forgotten.
 */
export async function unregisterEndpoint(
  workspaceId: string, info: PersistedTunnel | undefined, d: ReconcileDeps,
): Promise<void> {
  if (!info?.endpointId) return;
  const api = d.apiFor(workspaceId);
  if (!api) { d.warn(`no API key known for workspace ${workspaceId} — cannot remove its MCP endpoint`); return; }
  const out = await removeEndpoint(api, workspaceId, info.endpointId);
  if (out.kind === 'ok') {
    updatePersistedTunnel(d.stateDir, workspaceId, { endpointId: undefined, registeredKey: undefined });
  } else {
    d.warn(
      `could not remove this ship's MCP endpoint in workspace ${workspaceId}: ` +
        (out.kind === 'forbidden' ? `403 — ${REGISTER_MCP_ENDPOINTS_HINT}` : out.message),
    );
  }
}

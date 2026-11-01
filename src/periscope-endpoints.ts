/**
 * The secret and the workspace registration of a periscope's own MCP endpoint
 * (EPIC-077, CREW-2862).
 *
 * A periscope opened through the control API gets an MCP server for its
 * worktree (`periscope-mcp.ts`), reachable on the relay at
 * `<relay url>/control/periscopes/<ticket>/mcp`. Two small records back it,
 * both under the state dir and neither in the periscope sidecar, because
 * `crew status --json` (and so the control API's `GET /status`) returns every
 * sidecar wholesale and no endpoint may return a secret:
 *
 *  - `periscope-mcp/<ticketRecordId>.json` (0600): the bearer secret. Minted by
 *    `crew periscope up --mcp`, removed by `down`. Its absence IS the
 *    revocation: the server reads it on every request, so the path answers 404
 *    the moment the file is gone.
 *  - `periscope-endpoints/<ticketRecordId>.json`: which workspace MCP endpoint
 *    row was created for it, so it can be removed even after the sidecar and
 *    secret are gone (a `down` run from a terminal never touches the tracker's
 *    endpoint list, so the daemon reconciles).
 *
 * The workspace registration reuses `mcp-endpoint-registry.ts`, the way the
 * Passenger tunnel registers its own endpoint.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerEndpoint, removeEndpoint, type EndpointApi } from './mcp-endpoint-registry.ts';

const secretDir = (stateDir: string) => join(stateDir, 'periscope-mcp');
const secretFile = (stateDir: string, id: string) => join(secretDir(stateDir), `${id}.json`);
const endpointDir = (stateDir: string) => join(stateDir, 'periscope-endpoints');
const endpointFile = (stateDir: string, id: string) => join(endpointDir(stateDir), `${id}.json`);

/** Mints (or replaces) the secret for a periscope and returns it. */
export function mintPeriscopeSecret(stateDir: string, ticketRecordId: string): string {
  mkdirSync(secretDir(stateDir), { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString('base64url');
  const file = secretFile(stateDir, ticketRecordId);
  writeFileSync(file, `${JSON.stringify({ secret })}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return secret;
}

export function readPeriscopeSecret(stateDir: string, ticketRecordId: string): string | undefined {
  try {
    const v = JSON.parse(readFileSync(secretFile(stateDir, ticketRecordId), 'utf8')) as { secret?: unknown };
    return typeof v.secret === 'string' && v.secret ? v.secret : undefined;
  } catch { return undefined; }
}

/** Revokes the secret. Safe when there is none. */
export function removePeriscopeSecret(stateDir: string, ticketRecordId: string): void {
  rmSync(secretFile(stateDir, ticketRecordId), { force: true });
}

export interface PeriscopeEndpointRecord {
  ticket: string;
  ticketRecordId: string;
  route: string;
  workspaceId: string;
  endpointId: string;
  url: string;
  registeredAt: string;
}

export function readPeriscopeEndpoint(stateDir: string, ticketRecordId: string): PeriscopeEndpointRecord | undefined {
  try { return JSON.parse(readFileSync(endpointFile(stateDir, ticketRecordId), 'utf8')) as PeriscopeEndpointRecord; } catch { return undefined; }
}

export function writePeriscopeEndpoint(stateDir: string, rec: PeriscopeEndpointRecord): void {
  mkdirSync(endpointDir(stateDir), { recursive: true });
  writeFileSync(endpointFile(stateDir, rec.ticketRecordId), `${JSON.stringify(rec, null, 2)}\n`);
}

export function removePeriscopeEndpointRecord(stateDir: string, ticketRecordId: string): void {
  rmSync(endpointFile(stateDir, ticketRecordId), { force: true });
}

/** Every registration record on this ship; an unreadable file is skipped. */
export function listPeriscopeEndpoints(stateDir: string): PeriscopeEndpointRecord[] {
  const dir = endpointDir(stateDir);
  if (!existsSync(dir)) return [];
  const out: PeriscopeEndpointRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const rec = readPeriscopeEndpoint(stateDir, name.slice(0, -'.json'.length));
    if (rec && typeof rec.endpointId === 'string') out.push(rec);
  }
  return out.sort((a, b) => a.registeredAt.localeCompare(b.registeredAt));
}

/** The public URL of a periscope's MCP endpoint on the relay (`relayUrl` is the tunnel's base URL). */
export function periscopeEndpointUrl(relayUrl: string, ticket: string): string {
  return `${relayUrl.replace(/\/+$/, '')}/control/periscopes/${encodeURIComponent(ticket)}/mcp`;
}

export interface PeriscopeEndpointDeps {
  stateDir: string;
  shipName: string;
  /** The endpoint API for a workspace's route; undefined when no key is known for it. */
  apiFor(workspaceId: string): EndpointApi | undefined;
  warn(message: string): void;
  now?(): Date;
}

export type PeriscopeRegisterResult =
  | { ok: true; endpointId: string; url: string }
  | { ok: false; message: string };

/**
 * Registers (or refreshes) the workspace MCP endpoint for one periscope and
 * remembers the row id. Never throws. Needs the secret file to exist: an
 * endpoint without one would point at a path that answers 404.
 */
export async function registerPeriscopeEndpoint(
  d: PeriscopeEndpointDeps,
  p: { ticket: string; ticketRecordId: string; route: string; workspaceId: string; relayUrl: string },
): Promise<PeriscopeRegisterResult> {
  const secret = readPeriscopeSecret(d.stateDir, p.ticketRecordId);
  if (!secret) return { ok: false, message: `${p.ticket} has no MCP secret (it was not opened with --mcp, or has ended)` };
  const api = d.apiFor(p.workspaceId);
  if (!api) return { ok: false, message: `no API key known for workspace ${p.workspaceId}` };
  const url = periscopeEndpointUrl(p.relayUrl, p.ticket);
  const stored = readPeriscopeEndpoint(d.stateDir, p.ticketRecordId);
  const out = await registerEndpoint(api, p.workspaceId, stored?.endpointId, {
    label: `Periscope: ${d.shipName} ${p.ticket}`, url, mcpSecret: secret,
  });
  if (out.kind !== 'ok') {
    return { ok: false, message: out.kind === 'forbidden' ? 'registering the endpoint was refused (403): the route key lacks REGISTER_MCP_ENDPOINTS' : out.message };
  }
  writePeriscopeEndpoint(d.stateDir, {
    ticket: p.ticket, ticketRecordId: p.ticketRecordId, route: p.route, workspaceId: p.workspaceId,
    endpointId: out.endpointId, url, registeredAt: (d.now?.() ?? new Date()).toISOString(),
  });
  return { ok: true, endpointId: out.endpointId, url };
}

/**
 * Removes the workspace registration of every periscope whose secret is gone
 * (it ended, by the control API or from a terminal). A failed delete keeps the
 * record so the next cycle tries again. Returns how many were removed.
 */
export async function removeEndedPeriscopeEndpoints(d: PeriscopeEndpointDeps): Promise<number> {
  let removed = 0;
  for (const rec of listPeriscopeEndpoints(d.stateDir)) {
    if (readPeriscopeSecret(d.stateDir, rec.ticketRecordId)) continue;
    const api = d.apiFor(rec.workspaceId);
    if (!api) { d.warn(`no API key known for workspace ${rec.workspaceId} — cannot remove the MCP endpoint of ${rec.ticket}`); continue; }
    const out = await removeEndpoint(api, rec.workspaceId, rec.endpointId);
    if (out.kind === 'ok') { removePeriscopeEndpointRecord(d.stateDir, rec.ticketRecordId); removed++; }
    else d.warn(`could not remove the MCP endpoint of ${rec.ticket}: ${out.kind === 'forbidden' ? '403' : out.message}`);
  }
  return removed;
}

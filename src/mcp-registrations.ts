/**
 * Provenance for MCP entries crew itself wrote (CREW-2514). Claude Code's
 * `~/.claude.json` holds the route's bearer key in plaintext, and every sign-in
 * can mint a new one, so "the key differs" cannot tell a rotated key from
 * someone else's registration. `<stateDir>/mcp-registrations.json` remembers what
 * crew wrote: harness, scope, server name, URL and a fingerprint of the key
 * (first 8 hex of its SHA-256, never the key), so a later run can recognize its
 * own entry and update it without asking.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface McpRegistration {
  harness: string;
  scope: string;
  name: string;
  url: string;
  keyFingerprint: string;
  at: string;
}

const fileFor = (stateDir: string): string => join(stateDir, 'mcp-registrations.json');

export const keyFingerprint = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 8);

export function readMcpRegistrations(stateDir: string): McpRegistration[] {
  try {
    const j: unknown = JSON.parse(readFileSync(fileFor(stateDir), 'utf8'));
    return Array.isArray(j) ? (j as McpRegistration[]) : [];
  } catch {
    return [];
  }
}

/** Latest write per harness+scope+name wins: the config holds one entry per name. */
export function recordMcpRegistration(stateDir: string, r: Omit<McpRegistration, 'at'>, now = new Date()): void {
  const rest = readMcpRegistrations(stateDir).filter((x) => !(x.harness === r.harness && x.scope === r.scope && x.name === r.name));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(fileFor(stateDir), `${JSON.stringify([...rest, { ...r, at: now.toISOString() }], null, 2)}\n`, { mode: 0o600 });
}

/** The record crew made for an entry with this URL and this key, if any. */
export function findMcpRegistration(
  stateDir: string, r: { harness: string; scope: string; name: string; url: string; key: string },
): McpRegistration | undefined {
  const fp = keyFingerprint(r.key);
  return readMcpRegistrations(stateDir).find(
    (x) => x.harness === r.harness && x.scope === r.scope && x.name === r.name && x.url === r.url && x.keyFingerprint === fp,
  );
}

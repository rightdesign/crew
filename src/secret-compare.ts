/**
 * Deliberately a standalone module with NO imports beyond `node:crypto`
 * (ISSUE-693) — `passenger-mcp.ts` runs inside the lean passenger Docker
 * image (`Dockerfile.passenger-mcp`), which only installs a minimal
 * `docker/passenger-mcp/package.json` and was never provisioned for the
 * full crew CLI's dependencies (e.g. `yaml`, pulled in transitively by
 * `config.ts`). This function used to live in `passenger-sync-daemon.ts`,
 * which `passenger-mcp.ts` imported for exactly this one helper — but that
 * module also imports (a real, value import, not type-only)
 * `passenger-containers.ts`, which imports `config.ts`, which needs
 * `yaml`. That transitive chain crash-looped the deployed container
 * (`ERR_MODULE_NOT_FOUND: 'yaml'`) the moment `passenger-mcp.ts` started
 * importing anything from `passenger-sync-daemon.ts` at all. Keeping this
 * comparison in its own leaf module is what lets both
 * `passenger-sync-daemon.ts` and `passenger-mcp.ts` share one
 * implementation without either pulling in the other's larger graph.
 */
import { timingSafeEqual } from 'node:crypto';

/** `Buffer.from`/`timingSafeEqual` throw on a length mismatch rather than reporting one — a client sending a malformed or wrong-length header is just "not the secret", not an error condition. */
export function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * A stable identifier for THIS machine (ISSUE-2249, EPIC-053 Map §9.3), so
 * `crew connect` can find the machine's `Ships` row even after the macOS
 * hostname drifted (a network rename turns `Brads-Mac-Studio` into
 * `Brads-Mac-Studio-2`, and name-only matching then provisions a second ship
 * and orphans the first).
 *
 * The hardware id never leaves the machine: only its sha256 (hex) is cached
 * and written to the board. The hash is computed once and cached under
 * `<stateDir>/machine-id`, so a later change in how the raw id is read cannot
 * silently re-key an existing ship. `override` (`--machine-id`) is for tests
 * and containers, where there is no stable hardware id; it is hashed too, and
 * is not cached, so it never poisons the real machine's cached id.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function machineIdPathFor(stateDir: string): string {
  return join(stateDir, 'machine-id');
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The raw hardware id: macOS `IOPlatformUUID`, Linux `/etc/machine-id` (or the dbus copy). `undefined` when neither can be read. */
export function readRawMachineId(platform: string = process.platform): string | undefined {
  try {
    if (platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1];
    }
    for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      if (existsSync(p)) {
        const id = readFileSync(p, 'utf8').trim();
        if (id) return id;
      }
    }
  } catch { /* unreadable reads as "no id" */ }
  return undefined;
}

/**
 * This machine's hashed id, or `undefined` when none can be determined (a
 * platform with no stable id, a sandbox without `ioreg`) — callers then match
 * by name exactly as before. `read` is injectable for tests.
 */
export function ensureMachineId(
  stateDir: string,
  opts: { override?: string; read?: () => string | undefined } = {},
): string | undefined {
  if (opts.override?.trim()) return sha256(opts.override.trim());
  const path = machineIdPathFor(stateDir);
  if (existsSync(path)) {
    const cached = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(cached)) return cached;
  }
  const raw = (opts.read ?? readRawMachineId)();
  if (!raw) return undefined;
  const hashed = sha256(raw);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${hashed}\n`, { mode: 0o600 });
  return hashed;
}

/**
 * Which Ships row(s) are this machine's, for read-only callers (`crew doctor`).
 * `by` is `machine_id` when a row carries this machine's id, else `name`.
 * `hasColumn` is probed from the key on the rows, the way `attention` is: a
 * workspace that has not taken the template update returns rows without it.
 */
export function matchShipRows<R extends { name?: string | null; machine_id?: string | null }>(
  ships: R[], shipName: string, machineId: string | undefined,
): { rows: R[]; by: 'machine_id' | 'name'; hasColumn: boolean } {
  const hasColumn = ships.some((r) => 'machine_id' in r);
  const byId = hasColumn && machineId ? ships.filter((r) => r.machine_id === machineId) : [];
  if (byId.length > 0) return { rows: byId, by: 'machine_id', hasColumn };
  return { rows: ships.filter((r) => (r.name ?? '').trim() === shipName.trim()), by: 'name', hasColumn };
}

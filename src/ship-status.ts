/**
 * The identity half of a `ships` entry in `crew status --json` (CREW-2884).
 * A client that offers a remote ship for watching (the Mac app's ship picker)
 * needs the Ships row id, its kind, instance class and relay URL without
 * resolving the Ships table itself. A workspace whose Ships table has not
 * taken the runtime columns returns rows with those keys absent; they read
 * as `null` here rather than being dropped.
 */
import type { ShipRow } from './tracker.ts';

export function shipIdentityJson(s: ShipRow): {
  id: string; kind: string | null; instanceClass: string | null; relayUrl: string | null;
} {
  return {
    id: s.id,
    kind: s.kind ?? null,
    instanceClass: s.instance_class ?? null,
    relayUrl: s.relay_url ?? null,
  };
}

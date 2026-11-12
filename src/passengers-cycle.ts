import type { ShipAttentionItem } from './ship-attention.ts';
import { dockerDaemonItem, DOCKER_DAEMON_KEY } from './ship-attention.ts';

/** The effects `dockerGate` drives, passed in so the decision is testable without Docker, ssh or a board. */
export interface DockerGateDeps<R> {
  dockerUp: boolean;
  passengerRoutes: R[];
  /** Why Docker is unreachable, when it is a PATH problem rather than a stopped daemon. */
  pathProblem: () => string | null | undefined;
  warn: (message: string) => void;
  raise: (item: ShipAttentionItem, route: R) => Promise<unknown>;
  clear: (key: string) => void;
  syncTunnels: (containerPlans: never[], mcpSecrets: Map<string, string>, passengerRoutes: R[]) => Promise<void>;
}

/**
 * CREW-3275: the Docker decision at the top of the passengers cycle.
 *
 * Docker down: tunnels need ssh, not Docker, so the tunnel sync still runs with
 * no container plans. Control stays reachable for every workspace (the `mcp`
 * target needs a container and is left out), dead tunnel processes are detected
 * and the Ships row tells the truth. One `docker_missing:daemon` item says why
 * passengers are down. Returns `'handled'`: the caller skips the container sync.
 *
 * Docker up: clears that item and returns `'proceed'`.
 */
export async function dockerGate<R>(deps: DockerGateDeps<R>): Promise<'proceed' | 'handled'> {
  if (deps.dockerUp) {
    deps.clear(DOCKER_DAEMON_KEY);
    return 'proceed';
  }
  deps.warn(`Host Passengers is on for at least one route but ${deps.pathProblem() ?? 'Docker is not available'} — skipping container sync this cycle`);
  await deps.raise(dockerDaemonItem(), deps.passengerRoutes[0]!);
  await deps.syncTunnels([], new Map<string, string>(), deps.passengerRoutes);
  return 'handled';
}

/**
 * Live runs that can take a note on their harness's stdin (CREW-3119).
 *
 * The control API (`POST /streams/<run>/messages`) and the supervising `spawnPlanned` live in the same
 * daemon process, and only that process holds the child's stdin. `spawnPlanned` registers a run here
 * while its stdin is open; the route looks it up by run name. A run adopted by another process after a
 * restart, or spawned by a different `crew run`, is simply not here, so a note to it is carried forward.
 */

import type { PendingMessage } from './agent-log.ts';

export interface RunInput {
  /** True while the harness still reads further user messages. */
  accepts(): boolean;
  /**
   * Writes one platform-recorded note to the harness, framed with its author, and marks it delivered or
   * carried forward. A note the run's own reporter already handed over is not written twice.
   * Resolves to the state the note ended in.
   */
  deliver(note: PendingMessage, author: string | undefined): Promise<'delivered' | 'carried_forward'>;
  /** The Agent Log row the run reports to, when it has one. */
  agentLogRowId(): string | undefined;
  /** The reporting target, when the run has one. */
  target?: import('./agent-log.ts').AgentLogTarget;
}

const live = new Map<string, RunInput>();

export const registerRunInput = (run: string, input: RunInput): void => { live.set(run, input); };
export const unregisterRunInput = (run: string): void => { live.delete(run); };
export const runInputFor = (run: string): RunInput | undefined => live.get(run);

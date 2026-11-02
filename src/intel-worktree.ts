/**
 * `crew worktree` starts the repository's symbol service (CREW-2912).
 *
 * A lane run registered a `code` bridge at launch (`intel-bridge.ts`); it waits
 * for the attach file this writes. The hook runs after `setup`, with the `ports`
 * output, `CREW_TICKET` and `CREW_BRANCH` exported, exactly as for a periscope.
 * A second `crew worktree` for the same ticket reuses a service that still
 * answers instead of starting another. Never throws: the worktree is the point,
 * the service is optional.
 */
import { codeToolsParagraph, probeIntel, type IntelOutcome } from './intel.ts';
import { attachFilePath, readAttachFile, writeAttachFile } from './intel-bridge.ts';
import { parseEnvLines, type HookResult } from './periscope-cmd.ts';

export interface WorktreeIntelDeps {
  worktree: string;
  route: string;
  /** The ticket number the attach file is named by (the launch-time bridge knows the same). */
  number: string;
  ticketTag: string;
  branch: string;
  stateDir: string;
  startupSeconds: number;
  /** Copies the declared files and runs `setup`; null when there is no setup. */
  prepare(path: string): Promise<HookResult | null>;
  runHook(name: 'ports' | 'intel', cwd: string, env: Record<string, string>): Promise<HookResult | null>;
  probe?: typeof probeIntel;
}

/** Returns the "Code tools" paragraph for what happened. */
export async function startWorktreeIntel(d: WorktreeIntelDeps): Promise<string> {
  const file = attachFilePath(d.stateDir, d.route, d.number);
  const probe = d.probe ?? probeIntel;
  let outcome: IntelOutcome;
  try {
    const known = readAttachFile(file);
    outcome = known
      ? await probe({ runHook: async () => ({ code: 0, output: known }) }, {}, 3)
      : { state: 'absent' };
    if (outcome.state !== 'ready') {
      const prepared = await d.prepare(d.worktree);
      if (prepared && prepared.code !== 0) {
        outcome = { state: 'failed', reason: `setup exited ${prepared.code}` };
      } else {
        const env: Record<string, string> = { CREW_TICKET: d.ticketTag, CREW_BRANCH: d.branch };
        const ports = await d.runHook('ports', d.worktree, env);
        if (ports) Object.assign(env, parseEnvLines(ports.output));
        outcome = await probe({ runHook: (e) => d.runHook('intel', d.worktree, e) }, env, d.startupSeconds);
      }
    }
    if (outcome.state === 'ready') writeAttachFile(file, outcome.url);
  } catch (e) {
    outcome = { state: 'failed', reason: (e as Error).message.slice(0, 200) };
  }
  const tail = outcome.state === 'ready' ? ' The session\'s `code` server attaches to it within a second; until it lists these tools it still shows only `code_status`.' : '';
  return `${codeToolsParagraph(outcome)}${tail}`;
}

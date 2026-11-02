/**
 * The `code` bridge as it runs inside a sandbox (CREW-2922), bundled into one file
 * and baked into the crew layer at `/opt/crew/bin/intel-bridge`.
 *
 * A host lane run has `crew worktree` start the repository's symbol service and
 * write the attach file. A sandbox has no `crew` binary, no state directory and no
 * `crew worktree`, so this entry point carries the start itself, lazily (see
 * `intel-bridge.ts`): on the first `tools/list` or `tools/call` it runs the
 * clone's `ports` hook, exports its output, then starts the `intel` flavor or
 * command from the clone and probes it until it answers MCP.
 *
 *   node /opt/crew/bin/intel-bridge --attach-file F --start <flavor|command> --clone DIR
 *        [--state-dir D] [--seed-cache DIR] [--ticket N] [--startup-seconds S]
 *
 * Only what the symbol service needs is imported here: the bundle must stay small
 * and must not pull in the CLI.
 */
import { createBridge, type StartResult } from './intel-bridge.ts';
import { intelFlavor, probeIntel } from './intel.ts';
import { realSerenaDeps, startSerena } from './intel-serena.ts';
import { loadRepoConfig } from './repo-config.ts';
import { runScript } from './shell.ts';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface SandboxBridgeArgs {
  attachFile: string;
  /** A bare `hooks.intel` flavor name, or the repository's own intel command. */
  start: string;
  clone: string;
  stateDir: string;
  /** The host's symbol cache for the mirror's default branch, on the read-only cache volume (CREW-2924). */
  seedCache?: string;
  ticket: number;
  startupSeconds: number;
}

export function parseSandboxBridgeArgs(argv: string[]): SandboxBridgeArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const attachFile = get('--attach-file');
  const start = get('--start');
  const clone = get('--clone');
  if (!attachFile || !start || !clone) throw new Error('usage: intel-bridge --attach-file FILE --start FLAVOR|COMMAND --clone DIR [--state-dir DIR] [--seed-cache DIR] [--ticket N] [--startup-seconds S]');
  return {
    attachFile, start, clone,
    stateDir: get('--state-dir') ?? '/sandbox/.crew',
    ...(get('--seed-cache') ? { seedCache: get('--seed-cache')! } : {}),
    ticket: Number(get('--ticket')) || 0,
    startupSeconds: Number(get('--startup-seconds')) || 90,
  };
}

/** `KEY=value` lines a hook prints (`ports`, `isolate`) as an environment. Same rule as `parseEnvLines` in periscope-cmd.ts, which this bundle does not import. */
export function envFromHookOutput(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, '$1');
  }
  return env;
}

const onPath = (bin: string): boolean => (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, bin)));

/** Everything the lazy start does, with the hook runner injectable for tests. */
export function sandboxStarter(a: SandboxBridgeArgs, run: typeof runScript = runScript): () => Promise<StartResult> {
  return async () => {
    const env: Record<string, string> = {};
    const ports = loadRepoConfig(a.clone)?.hooks.ports;
    if (ports) {
      const r = await run(ports, { cwd: a.clone, env, timeoutMs: 30_000 });
      if (r.code === 0) Object.assign(env, envFromHookOutput(r.stdout));
    }
    const flavor = intelFlavor(a.start);
    const outcome = await probeIntel({
      runHook: async (e) => {
        if (flavor === 'serena') {
          return startSerena(realSerenaDeps(onPath), {
            stateDir: a.stateDir, route: 'sandbox', ticket: a.ticket, worktree: a.clone, mainCheckout: a.clone, noMainIndex: true, seedCache: a.seedCache,
            languageServers: process.env.CREW_SERENA_LANGUAGE_SERVERS,
          });
        }
        return run(a.start, { cwd: a.clone, env: e, timeoutMs: 60_000 });
      },
    }, env, a.startupSeconds);
    return outcome.state === 'ready' ? { url: outcome.url } : { error: outcome.state === 'failed' ? outcome.reason : 'no intel hook is declared' };
  };
}

export async function main(argv: string[]): Promise<void> {
  const a = parseSandboxBridgeArgs(argv);
  const bridge = createBridge({ attachFile: a.attachFile, start: sandboxStarter(a) });
  const closed = new Promise<void>((resolve) => { bridge.server.onclose = resolve; process.stdin.on('end', resolve); });
  await bridge.start(new StdioServerTransport());
  await closed;
  await bridge.stop();
}

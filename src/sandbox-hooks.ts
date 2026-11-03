/**
 * Hook binaries on a sandbox ship (CREW-3007).
 *
 * With `ship.runner: sandbox` every hook runs inside the repository's sandbox
 * image, so the host PATH says nothing about whether a hook can run: the host
 * is meant to carry git, docker and crew and nothing else. `crew doctor`
 * therefore asks the image instead, and a binary the image lacks is a gap in
 * the repository's `sandbox:` declaration, not in `ship.extraPath`.
 */
import { realExec, type Exec } from './passenger-containers.ts';
import { hookCommand } from './ship-attention.ts';

/** Whether `bin` resolves on PATH inside `image`, asked of the container engine. */
export const imageHasBinary = (engine = 'docker', exec: Exec = realExec) => (image: string, bin: string): boolean => {
  try {
    exec(engine, ['run', '--rm', '--entrypoint', 'sh', image, '-c', `command -v ${bin}`], { timeoutMs: 60_000 });
    return true;
  } catch {
    return false;
  }
};

export interface SandboxHookGap { hook: string; command: string; message: string; remedy: string }

/**
 * Hooks of one repository whose first command is absent from the image it runs
 * in. An unbuilt image (`image` null) yields nothing: `crew doctor` already
 * reports that as a sandbox image status, and there is nothing to ask.
 */
export function sandboxHookGaps(o: {
  route: string; repo: string; image: string | null; declares: boolean;
  hooks: Partial<Record<'setup' | 'test' | 'build' | 'deploy', string | undefined>>; hasBinary: (image: string, bin: string) => boolean;
}): SandboxHookGap[] {
  if (!o.image) return [];
  const seen = new Map<string, boolean>();
  const has = (bin: string): boolean => {
    if (!seen.has(bin)) seen.set(bin, o.hasBinary(o.image!, bin));
    return seen.get(bin)!;
  };
  const gaps: SandboxHookGap[] = [];
  for (const hook of ['setup', 'test', 'build', 'deploy'] as const) {
    const script = o.hooks[hook];
    const command = script ? hookCommand(script) : null;
    if (!command || has(command)) continue;
    const remedy = o.declares
      ? `add the package that provides \`${command}\` to sandbox.packages or sandbox.setup in ${o.repo}'s .crew.yaml, then \`crew sandbox build ${o.repo}\``
      : `${o.repo} declares no sandbox: section, so it runs in the ship's crew image; add a sandbox: section to its .crew.yaml providing \`${command}\``;
    gaps.push({
      hook, command, remedy,
      message: `${o.route}/${o.repo}: the ${hook} hook runs \`${command}\`, which is not in its sandbox image ${o.image} — ${remedy}`,
    });
  }
  return gaps;
}

/**
 * Whether the crew layer's pnpm store can be written by the sandbox user (CREW-3036). An offline install
 * writes the store's index, so a store the sandbox user cannot write fails every run's `pnpm install`.
 * Returns the engine's complaint, or null when the store is writable.
 */
export const imageStoreProblem = (engine = 'docker', exec: Exec = realExec) => (image: string): string | null => {
  try {
    exec(engine, ['run', '--rm', '--entrypoint', 'sh', image, '-c', 'd=/opt/crew/pnpm-store; test -d $d && t=$(mktemp -p $d) && rm -f "$t"'], { timeoutMs: 60_000 });
    return null;
  } catch (e) {
    return (e as Error).message.split('\n')[0] || 'write test failed';
  }
};

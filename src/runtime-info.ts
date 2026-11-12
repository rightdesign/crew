/**
 * `bun build --compile` rewrites a compiled binary's `import.meta.url` to a
 * synthetic `file:///$bunfs/...` path — there is no real script file on disk
 * to resolve CREW_HOME from, and `process.execPath` is the crew binary
 * itself rather than a node/bun interpreter to invoke it with.
 */
export function isCompiledBinary(moduleUrl: string): boolean {
  return moduleUrl.includes('$bunfs');
}

/** What a process needs to start another copy of this crew: the program and its leading arguments. */
export interface SelfLaunch {
  command: string;
  args: string[];
}

/** The process facts `selfLaunch` reads, injectable so both forms are testable. */
export interface SelfLaunchEnv {
  compiled: boolean;
  execPath: string;
  execArgv: string[];
  argv1: string | undefined;
}

/**
 * The command and leading arguments that re-launch this same crew; append the
 * crew subcommand and its flags. Under an interpreter (a checkout or the
 * package install) that is the interpreter, its own flags and the script path.
 * A compiled binary has no script: `process.argv[1]` there is the binary's
 * internal virtual path, which the child would read as the command name, so the
 * binary alone is the whole launch. Every self-spawn goes through here;
 * test/self-launch.test.ts fails on any other use of `process.argv[1]`.
 */
export function selfLaunch(env: SelfLaunchEnv = currentLaunchEnv()): SelfLaunch {
  if (env.compiled) return { command: env.execPath, args: [] };
  return { command: env.execPath, args: [...env.execArgv, env.argv1 ?? 'crew'] };
}

function currentLaunchEnv(): SelfLaunchEnv {
  return { compiled: isCompiledBinary(import.meta.url), execPath: process.execPath, execArgv: process.execArgv, argv1: process.argv[1] };
}

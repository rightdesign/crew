/**
 * `bun build --compile` rewrites a compiled binary's `import.meta.url` to a
 * synthetic `file:///$bunfs/...` path — there is no real script file on disk
 * to resolve CREW_HOME from, and `process.execPath` is the crew binary
 * itself rather than a node/bun interpreter to invoke it with.
 */
export function isCompiledBinary(moduleUrl: string): boolean {
  return moduleUrl.includes('$bunfs');
}

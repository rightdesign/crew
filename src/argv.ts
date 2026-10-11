/**
 * Flags that consume the next argv entry as their value. Every other `--flag`
 * is boolean and must NOT swallow what follows it: `crew agents sync --force
 * paradium/issues` has to read `paradium/issues` as the route (CREW-1539).
 * Keep in step with the `value('<name>')` reads in cli.ts.
 */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  'area', 'base-url', 'dir', 'harness', 'key', 'level', 'limit', 'max-roles', 'mcp',
  'member', 'name', 'project', 'repo', 'role', 'route', 'tail', 'ticket', 'workspace',
  'workspace-id',
]);

/** argv minus every `--flag` and the value of each value-taking flag. */
export function positionalArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      // `--flag=value` carries its own value; otherwise a value flag takes the next entry.
      if (!a.includes('=') && VALUE_FLAGS.has(a.slice(2))) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

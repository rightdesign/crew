/**
 * Flags that consume the next argv entry as their value. Every other `--flag`
 * is boolean and must NOT swallow what follows it: `crew agents sync --force
 * paradium/issues` has to read `paradium/issues` as the route (CREW-1539).
 * Keep in step with the `value('<name>')` reads in cli.ts.
 */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  'agent-bin', 'area', 'base-url', 'choose', 'dir', 'extra-path', 'harness', 'hook', 'host', 'key', 'level', 'limit', 'max-roles', 'mcp',
  'member', 'name', 'project', 'repo', 'role', 'route', 'recipes', 'ship-name', 'tail', 'ticket', 'workspace',
  'workspace-id', 'write',
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

const WORKTREE_ROLES = ['dev', 'design', 'qa'];

/**
 * `crew worktree [route] NNN (CREW-1551): the route is optional, so a lone
 * ticket number at positional[1] must never be looked up as a route name —
 * that was `no route "1534" (have: ...)` on every `crew worktree 1534`.
 * `route` is the explicit route when one was typed (a first argument that is
 * not a ticket number, or that is the name of a route), `ticket` the raw
 * ticket argument. When `route` is undefined the caller resolves it from the
 * ticket's own repo.
 */
export function splitWorktreeArgs(
  positional: readonly string[],
  routeNames: readonly string[],
): { route?: string; ticket?: string } {
  // A trailing lane word (`crew worktree NNN qa`) is the role, not a route or
  // ticket; the caller reads it separately from positional.
  const args = positional.slice(1);
  if (args.length > 1 && WORKTREE_ROLES.includes(args[args.length - 1] ?? '')) args.pop();
  const [a, b] = [args[0], args[1]];
  const isTicket = (s: string | undefined) => !!s && /^(?:[A-Za-z]+-)?\d+$/.test(s.trim());
  if (b !== undefined) return { route: a, ticket: b };
  if (a !== undefined && isTicket(a) && !routeNames.includes(a)) return { ticket: a };
  return { route: a, ticket: undefined };
}

/**
 * Which route serves `crew worktree NNN` when none was named (CREW-1551).
 * Pure so the multi-route lookup is testable without a tracker: `candidates`
 * is each route looked on, with the ticket's repo id when that route's board
 * has the ticket (`hit`) and the repo ids its checkouts serve. A route wins
 * when it has the ticket and serves its repo; with a single candidate the hit
 * wins regardless (the route's own default repo is the fallback).
 */
export function pickWorktreeRoute(
  ticketNumber: number,
  candidates: readonly { route: string; hit?: { repoId: string | null }; servedRepoIds: readonly string[] }[],
): { route: string } | { error: string } {
  for (const c of candidates) {
    if (c.hit && (candidates.length === 1 || c.servedRepoIds.includes(c.hit.repoId ?? ''))) return { route: c.route };
  }
  const looked = candidates.map((c) => c.route).join(', ');
  const found = candidates.filter((c) => c.hit).map((c) => `${c.route} (repo ${c.hit?.repoId ?? 'none'})`);
  return {
    error: `no open ticket ISSUE-${ticketNumber} served by this ship — looked on ${looked}` +
      (found.length ? `; found it only on ${found.join(', ')}, which has no checkout for its repo` : ''),
  };
}

/**
 * `crew connect`'s positional: `<workspace>[/<project>]`, split on the first
 * `/`. The workspace part may itself contain a colon — a secondary workspace
 * is addressed as `<primary>:<slug>` (EPIC-051) — and is passed through
 * verbatim; only `/` separates the project.
 */
export function splitConnectArg(arg: string | undefined): [string | undefined, string | undefined] {
  if (!arg?.includes('/')) return [arg, undefined];
  const i = arg.indexOf('/');
  return [arg.slice(0, i), arg.slice(i + 1)];
}

/**
 * `crew --version` / `crew version` (CREW-2404): the version request, or null
 * for any other argv. Only the first argument counts, and only `--json` may
 * follow, so every other unknown flag still falls through to usage (exit 2).
 */
export function versionRequest(argv: readonly string[]): { json: boolean } | null {
  if (argv[0] !== '--version' && argv[0] !== 'version') return null;
  const rest = argv.slice(1);
  if (rest.some((a) => a !== '--json')) return null;
  return { json: rest.length > 0 };
}

/**
 * `crew --help` / `-h` / `help` (CREW-2410): a requested usage, which succeeds.
 * Only the first argument counts, so `crew poll --help` is not a help request.
 */
export function helpRequest(argv: readonly string[]): boolean {
  return argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help';
}

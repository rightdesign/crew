import { execFileSync } from 'node:child_process';

/**
 * Preflight checks `crew doctor` adds for first-run setup (CREW-2239): can the
 * crew push to each repo, and are the soft tools (gh, Node, Docker) present.
 * Pure of the CLI so fixtures can drive every branch without a network.
 */

export type PushAuthResult =
  | { state: 'ok' }
  | { state: 'failed'; detail: string; hint: string }
  | { state: 'skipped'; detail: string };

/** Runs git with the given args, returning stderr+stdout on failure by throwing. */
export type GitRunner = (cwd: string, args: string[], env: NodeJS.ProcessEnv) => void;

export const PROBE_BRANCH = 'crew-probe-branch';

const realGit: GitRunner = (cwd, args, env) => {
  execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
};

/** SSH-shaped remotes: `ssh://…` or scp-style `user@host:path`. */
export function isSshRemote(url: string): boolean {
  return /^ssh:\/\//.test(url) || /^[\w.-]+@[\w.-]+:/.test(url);
}

export function pushAuthHint(remoteUrl: string): string {
  return isSshRemote(remoteUrl)
    ? 'make sure an SSH key is loaded for this host (ssh-add), and that the scheduler user can reach it'
    : 'run `gh auth login`, then `gh auth setup-git`';
}

/**
 * `git push --dry-run <remote> HEAD:refs/heads/<probe>`, non-interactive.
 * A dry run contacts the remote and authenticates but writes nothing.
 * `offline` skips the network call and says so.
 */
export function probePushAuth(
  o: { dir: string; remote: string; remoteUrl: string | null; offline?: boolean },
  run: GitRunner = realGit,
  baseEnv: NodeJS.ProcessEnv = process.env,
): PushAuthResult {
  if (o.offline) return { state: 'skipped', detail: 'skipped (--offline)' };
  if (!o.remoteUrl) return { state: 'skipped', detail: `no remote "${o.remote}" configured` };
  const env = { ...baseEnv, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: `${baseEnv.GIT_SSH_COMMAND ?? 'ssh'} -o BatchMode=yes` };
  try {
    run(o.dir, ['push', '--dry-run', o.remote, `HEAD:refs/heads/${PROBE_BRANCH}`], env);
    return { state: 'ok' };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message: string };
    const raw = (err.stderr ? String(err.stderr) : err.message).trim().split('\n').filter(Boolean).slice(-2).join(' / ');
    return { state: 'failed', detail: raw || 'push dry-run failed', hint: pushAuthHint(o.remoteUrl) };
  }
}

export interface ToolCheck {
  name: 'gh' | 'node' | 'docker';
  need: 'required' | 'optional';
  found: boolean;
  path?: string;
  hint: string;
}

const INSTALL_HINTS: Record<ToolCheck['name'], string> = {
  gh: 'install GitHub CLI: brew install gh (https://cli.github.com)',
  node: 'install Node: brew install node, or https://nodejs.org',
  docker: 'install Docker Desktop: https://docs.docker.com/get-docker/',
};

/** A hook script that shells out to Node tooling. */
export function mentionsNode(script: string | undefined): boolean {
  return !!script && /\b(node|npm|pnpm|npx|yarn)\b/.test(script);
}

/** A repo is PR-based when it opens PRs or asks a forge whether work landed. */
export function isPrBased(hooks: { pr?: string; merged?: string }): boolean {
  return !!hooks.pr || /\bgh\b/.test(hooks.merged ?? '');
}

export function toolChecks(
  o: { prBased: boolean; hostPassengers: boolean; hooksMentionNode: boolean },
  find: (bin: string) => string | undefined,
): ToolCheck[] {
  const mk = (name: ToolCheck['name'], need: ToolCheck['need']): ToolCheck => {
    const path = find(name);
    return { name, need, found: !!path, ...(path ? { path } : {}), hint: INSTALL_HINTS[name] };
  };
  const node = mk('node', 'optional');
  if (o.hooksMentionNode) node.hint = `your repositories' hooks may need it — ${node.hint}`;
  return [mk('gh', o.prBased ? 'required' : 'optional'), node, mk('docker', o.hostPassengers ? 'required' : 'optional')];
}

export function formatToolCheck(t: ToolCheck): string {
  const label = `${t.name}:`.padEnd(19);
  if (t.found) return `${label}OK (${t.path}) [${t.need}]\n`;
  return `${label}${t.need === 'required' ? 'NOT FOUND' : 'not found'} [${t.need}] — ${t.hint}\n`;
}

export function formatPushAuth(repo: string, r: PushAuthResult): string {
  const label = `push auth ${repo}:`.padEnd(19);
  if (r.state === 'ok') return `${label}ok\n`;
  if (r.state === 'skipped') return `${label}${r.detail}\n`;
  return `${label}FAILED — ${r.detail}; ${r.hint}\n`;
}

/**
 * Resolve each repo independently. A repo whose resolution throws (an invalid
 * `.crew.yaml`) is reported in `errors` and does not affect its siblings.
 */
export async function settleRepos<T, R>(
  items: T[],
  nameOf: (t: T) => string,
  resolve: (t: T) => Promise<R>,
): Promise<{ settled: R[]; errors: Array<{ repo: string; detail: string }> }> {
  const out = await Promise.all(items.map(async (t) => {
    try { return { ok: true as const, value: await resolve(t) }; }
    catch (e) { return { ok: false as const, repo: nameOf(t), detail: (e as Error).message }; }
  }));
  const settled: R[] = [];
  const errors: Array<{ repo: string; detail: string }> = [];
  for (const o of out) { if (o.ok) settled.push(o.value); else errors.push({ repo: o.repo, detail: o.detail }); }
  return { settled, errors };
}

/** True unless `process.kill(pid, 0)` says the process is gone (ESRCH); EPERM means it exists. */
export function pidRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/**
 * CREW-2412: a Locks row held as `<this ship>:<pid>` whose pid no longer runs.
 * The release phase reclaims it on its next cycle (CREW-2411, same test), so
 * this only makes the stale claim visible beforehand. Another ship's holder,
 * a free row or a live pid is not reported; neither is a label with no pid
 * part, since nothing can tell whether that process is gone.
 */
export function staleOwnLockClaim(
  holder: string | undefined, shipName: string, running: (pid: number) => boolean = pidRunning,
): boolean {
  if (!holder) return false;
  const i = holder.lastIndexOf(':');
  if (i < 0 || holder.slice(0, i) !== shipName) return false;
  const pid = Number(holder.slice(i + 1));
  return Number.isInteger(pid) && pid > 0 && !running(pid);
}

export function formatStaleOwnLock(scope: string, holder: string): string {
  return `WARN lock ${scope} is held by ${holder}, but that process is gone — the next release cycle reclaims it\n`;
}

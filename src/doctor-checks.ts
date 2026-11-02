import { execFileSync, spawnSync } from 'node:child_process';
import { hostOfRemote } from './forges.ts';

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
  o: { dir: string; remote: string; remoteUrl: string | null; offline?: boolean; forge?: { host: string; hasToken: boolean } },
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
    const detail = raw || 'push dry-run failed';
    const f = o.forge;
    // CREW-2798: name the forge host even with no forge block, since a GitLab row is not github.com.
    if (!f) return { state: 'failed', detail: hostOfRemote(o.remoteUrl) ? `${hostOfRemote(o.remoteUrl)}: ${detail}` : detail, hint: pushAuthHint(o.remoteUrl) };
    if (!f.hasToken) {
      return {
        state: 'failed', detail: `no token for forge ${f.host}: ${detail}`,
        hint: `set one with \`crew forge set ${f.host}\` (forges.${f.host} in crew.yaml)`,
      };
    }
    // A token is configured. If a read still works, the token is read-only (CREW-2783).
    try {
      run(o.dir, ['ls-remote', '--exit-code', o.remote, 'HEAD'], env);
      return {
        state: 'failed', detail: `the token for forge ${f.host} is read-only (fetch works, push refused): ${detail}`,
        hint: `replace it with one that can write contents: \`crew forge rotate ${f.host}\``,
      };
    } catch {
      return {
        state: 'failed', detail: `the token for forge ${f.host} was refused: ${detail}`,
        hint: `check that it is current and has access to this repository: \`crew forge rotate ${f.host}\``,
      };
    }
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

/**
 * An EXPLICIT `ship.maxConcurrentAgents` lower than a single role's
 * `roleConcurrency` cap (CREW-2821): that role could never fill its slots. A
 * derived (unset) ship cap is the sum of the role caps, so it never warns.
 * A warning, not a blocker.
 */
export function roleCapWarnings(ship: { maxConcurrentAgents: number; maxConcurrentAgentsSet?: boolean; roleConcurrency: Partial<Record<string, number>> }): string[] {
  if (!ship.maxConcurrentAgentsSet) return [];
  return Object.entries(ship.roleConcurrency)
    .filter(([, n]) => (n ?? 0) > ship.maxConcurrentAgents)
    .map(([role, n]) => `ship.roleConcurrency.${role} is ${n}, above ship.maxConcurrentAgents (${ship.maxConcurrentAgents}); the ship-wide cap wins`);
}

/**
 * A Tablation-managed ship (Ships.kind `managed_instance` or `pooled`/`pooled_instance`, CREW-2910) has no harness binary on the host and no
 * provider key: it must run agents in the sandbox and reach a model through the workspace's inference endpoint (`auth: workspace`). Names each
 * setting that says otherwise. Only claude toolchains are checked: `workspace` is not available for the other harnesses. Empty for any other kind.
 */
export function managedRuntimeWarnings(
  kind: string | null | undefined,
  ship: { runner?: string; toolchains?: Array<{ name: string; harness: string; auth?: string }> },
): string[] {
  if (kind !== 'managed_instance' && kind !== 'pooled_instance' && kind !== 'pooled') return [];
  const out: string[] = [];
  // The legacy `agent:` block defines an implicit `claude` toolchain (inherit auth) unless the map names its own.
  const explicit = ship.toolchains ?? [];
  const effectiveToolchains = explicit.some((t) => t.name === 'claude') ? explicit : [{ name: 'claude', harness: 'claude' }, ...explicit];
  if ((ship.runner ?? 'host') !== 'sandbox') out.push(`ship.runner is "${ship.runner ?? 'host'}" on a ${kind} ship; a managed ship should run agents in the sandbox (set ship.runner: sandbox)`);
  for (const t of effectiveToolchains) {
    if (t.harness === 'claude' && t.auth !== 'workspace') out.push(`ship.toolchains.${t.name}.auth is "${t.auth ?? 'inherit'}" on a ${kind} ship; a managed ship reaches a model only through the workspace endpoint (set auth: workspace)`);
  }
  return out;
}

/**
 * A Linux ship whose per-user runtime directory `/run/user/<uid>` is missing has no user manager, so
 * `systemctl --user` fails and a user unit dies at logout: lingering is off (CREW-2937). Null on a
 * healthy host, on root (system units) and off Linux.
 */
export function runtimeDirWarning(
  platform: string,
  uid: number | null,
  exists: (p: string) => boolean,
  user = 'the crew user',
): string | null {
  if (platform !== 'linux' || uid === null || uid === 0) return null;
  if (exists(`/run/user/${uid}`)) return null;
  return `/run/user/${uid} is missing, so \`systemctl --user\` cannot reach the user manager: lingering is off for ${user}; run \`sudo loginctl enable-linger ${user}\``;
}

/** The git identity crew gives a managed ship's `crew` user (CREW-2955). The email is shared; the name is the ship's own. */
export const MANAGED_GIT_EMAIL = 'crew@tablation.dev';

/** The global git identity of the user running crew; either part is null when unset. */
export function readGlobalGitIdentity(): { name: string | null; email: string | null } {
  const get = (key: string): string | null => {
    const res = spawnSync('git', ['config', '--global', '--get', key], { encoding: 'utf8' });
    const v = (res.stdout ?? '').trim();
    return res.status === 0 && v ? v : null;
  };
  return { name: get('user.name'), email: get('user.email') };
}

/**
 * CREW-2955: a Tablation-managed ship has no operator to have configured git, so every commit it makes (the release phase's squash-merge, a
 * hand-off, `periscope down --keep`) fails with `Committer identity unknown` unless `crew provision` wrote one. Names what is missing.
 * Empty for any other kind: an operator-run machine keeps the operator's own identity and crew says nothing about it.
 */
export function managedGitIdentityWarnings(kind: string | null | undefined, identity: { name: string | null; email: string | null }): string[] {
  if (kind !== 'managed_instance' && kind !== 'pooled_instance' && kind !== 'pooled') return [];
  const missing = [identity.name ? '' : 'user.name', identity.email ? '' : 'user.email'].filter(Boolean);
  if (missing.length === 0) return [];
  return [`git ${missing.join(' and ')} not set for this user on a ${kind} ship; every commit crew makes here fails with "Committer identity unknown" (re-run \`crew provision\`, or \`git config --global user.name <ship name>\` and \`user.email ${MANAGED_GIT_EMAIL}\`)`];
}

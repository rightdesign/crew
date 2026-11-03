/**
 * The release sandbox (CREW-2940, EPIC-075).
 *
 * A managed ship has no primary checkouts, so the release phase cannot merge,
 * gate, tag and push on the host. For a repository whose release runs on the
 * ship (`integrate`, `ci_*`) it makes a sandbox the way a run's is made (the
 * crew layer or the repository's layer, the cache volume mounted read-only,
 * the generated policy), clones the repository there, and registers the clone
 * as a remote directory (`remote-dir.ts`) so the whole existing release code
 * runs against it unchanged: its `git` calls, its gate hooks and its version
 * and changelog edits all execute inside the sandbox.
 *
 * The clone is shallow and takes only what a release reads: the base branch,
 * the ticket branches being merged, no tags beyond the latest release tag the
 * version hooks read. `crew.releaseDepth` in the clone's config records the
 * depth so a later fetch keeps it, and `deepenUntilMergeBase` (release-run.ts)
 * deepens when a merge base falls outside it.
 *
 * The forge token is in the sandbox's environment (`--env-from`, never argv or
 * a file); git reads it through a credential helper that expands the variable
 * when it runs, the same way the cache refresh does.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import type { Emitter } from './events.ts';
import { registerRemoteDir, unregisterRemoteDir } from './remote-dir.ts';
import { DEFAULT_SANDBOX_CONFIG, sandboxLabels, sandboxName, shQuote, type SandboxConfig } from './runner.ts';
import { containerEngineStubScript, SANDBOX_STUB_DIR } from './sandbox-brief.ts';
import { sandboxEnvExports } from './sandbox-image.ts';
import { describe as describeError, mirrorRelPath, type CacheRepo } from './sandbox-cache.ts';
import { generateSandboxPolicy, parseDeniedRequests, type SandboxPolicyInput } from './sandbox-policy.ts';

const execFileP = promisify(execFile);

/** Commits the base branch is cloned with, before it grows to reach the latest release tag. */
export const RELEASE_CLONE_DEPTH = 50;

/** Environment variable names the forge credential travels in, the same ones the cache refresh helper reads. */
export const FORGE_TOKEN_VAR = 'CREW_FORGE_TOKEN';
export const FORGE_USER_VAR = 'CREW_FORGE_USER';

/** Git's credential helper body: the shell git runs it in expands the environment, so no token is written anywhere. */
export const CREDENTIAL_HELPER = `!f() { echo username=\${${FORGE_USER_VAR}:-x-access-token}; echo password=\$${FORGE_TOKEN_VAR}; }; f`;

export interface ReleaseCloneInput {
  mirrorDir: string;
  repo: CacheRepo;
  workDir: string;
  /** The forge URL `origin` points at for the push. */
  origin: string;
  base: string;
  /** Pushed names of the verified tickets' branches. */
  branches: string[];
  /** The `release.tagPattern` glob the version hooks read. */
  tagPattern: string;
  depth?: number;
}

/**
 * The script that makes the release clone inside the sandbox, one `sh -c` line.
 *
 * The depth is the larger of `RELEASE_CLONE_DEPTH` and the distance from the
 * base tip back to the latest release tag (plus slack), so `git describe` can
 * see that tag. Only that tag is fetched. A ticket branch the mirror does not
 * have yet is skipped here; its refspec is configured anyway, so the release's
 * own fetch from the forge brings it.
 */
export function releaseCloneScript(o: ReleaseCloneInput): string {
  const mirror = `${o.mirrorDir}/${mirrorRelPath(o.repo)}`;
  const depth = o.depth ?? RELEASE_CLONE_DEPTH;
  const branch = shQuote(o.base);
  return [
    'set -e',
    'export GIT_TERMINAL_PROMPT=0',
    // The mirror is written by a helper container as root and mounted read-only, so git sees it as someone else's.
    `git config --global --add safe.directory '*'`,
    `git config --global credential.helper ${shQuote(CREDENTIAL_HELPER)}`,
    `m=${shQuote(mirror)}`,
    `depth=${depth}`,
    `t=$(git -C "$m" describe --tags --abbrev=0 --match ${shQuote(o.tagPattern)} ${shQuote(`refs/heads/${o.base}`)} 2>/dev/null || true)`,
    `if [ -n "$t" ]; then n=$(git -C "$m" rev-list --count "$t..refs/heads/"${branch}); [ $((n + 20)) -gt "$depth" ] && depth=$((n + 20)); fi`,
    `git clone --quiet --no-tags --depth "$depth" --single-branch --branch ${branch} "file://$m" ${shQuote(o.workDir)}`,
    `cd ${shQuote(o.workDir)}`,
    `git remote set-url origin ${shQuote(o.origin)}`,
    `git config crew.releaseDepth "$depth"`,
    // A tag already in the window: only its (annotated) tag object is new.
    `if [ -n "$t" ]; then git fetch --quiet --no-tags "file://$m" "refs/tags/$t:refs/tags/$t" || true; fi`,
    ...o.branches.flatMap((b) => {
      const spec = shQuote(`+refs/heads/${b}:refs/remotes/origin/${b}`);
      return [
        `git config --add remote.origin.fetch ${spec}`,
        `git fetch --quiet --no-tags --depth "$depth" "file://$m" ${spec} 2>/dev/null || true`,
      ];
    }),
  ].join('\n');
}

export interface ReleaseSandboxOptions {
  /** `ship.sandbox`. */
  sandbox: Partial<SandboxConfig>;
  route: string;
  repoName: string;
  /** The built layer for the repository, else the ship's crew layer; `ship.sandbox.image` wins. */
  image?: string;
  policy: SandboxPolicyInput;
  /** Where the generated policy is written. */
  policyFile: string;
  repo: CacheRepo;
  origin: string;
  base: string;
  branches: string[];
  tagPattern: string;
  token?: string | null;
  username?: string;
  emit: Emitter;
  /** Test seam: runs a command, defaults to `execFile`. */
  exec?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>;
  now?: () => number;
}

export interface ReleaseSandbox {
  /** The host-side name of the clone; `git`, hooks and file edits on it run in the sandbox. */
  dir: string;
  sandbox: string;
  close(): Promise<void>;
}

/** Hosts the policy lets this sandbox reach, for the run log. */
const endpointsOf = (g: ReturnType<typeof generateSandboxPolicy>): string[] => g.groups.flatMap((x) => x.endpoints.map((e) => `${e.host}:${e.port}`));

/**
 * Creates the sandbox, makes the clone, registers it. On any failure the sandbox
 * is deleted and the error carries the cause. The caller closes the sandbox when
 * the release is done, whatever its outcome.
 */
export async function openReleaseSandbox(o: ReleaseSandboxOptions): Promise<ReleaseSandbox> {
  const cfg: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, ...o.sandbox };
  const run = o.exec ?? ((bin, args, env) => execFileP(bin, args, { env, maxBuffer: 16 * 1024 * 1024 }));
  const name = sandboxName({ route: o.route, role: 'release', ticket: o.repoName }, o.now?.());

  let policyFile = cfg.policy;
  let generated: ReturnType<typeof generateSandboxPolicy> | undefined;
  if (!policyFile) {
    generated = generateSandboxPolicy({ mirrorDir: cfg.mirrorDir, workDir: cfg.workDir, ...o.policy });
    policyFile = o.policyFile;
    mkdirSync(dirname(policyFile), { recursive: true });
    writeFileSync(policyFile, generated.yaml, { mode: 0o600 });
  }

  const secrets: NodeJS.ProcessEnv = { ...process.env };
  const secretKeys: string[] = [];
  if (o.token) {
    secrets[FORGE_TOKEN_VAR] = o.token;
    secrets[FORGE_USER_VAR] = o.username ?? 'x-access-token';
    secretKeys.push(FORGE_TOKEN_VAR, FORGE_USER_VAR);
  }
  const create = ['sandbox', 'create', '--name', name, '--detach'];
  if (policyFile) create.push('--policy', policyFile);
  for (const l of sandboxLabels({ role: 'release', run: name })) create.push('--label', l);
  const image = cfg.image ?? o.image;
  if (image) create.push('--from', image);
  if (cfg.cacheVolume) {
    create.push('--driver-config-json', JSON.stringify({
      docker: { mounts: [{ type: 'volume', source: cfg.cacheVolume, target: cfg.mirrorDir, read_only: true }] },
    }));
  }
  for (const k of secretKeys) create.push('--env-from', k);
  create.push('--', 'sleep', String(3 * 3600));

  const t0 = Date.now();
  const deleteQuietly = async (): Promise<void> => {
    try { await run(cfg.bin, ['sandbox', 'delete', name], process.env); } catch { /* already gone, or the gateway is down */ }
  };
  try {
    await run(cfg.bin, create, secrets);
  } catch (e) {
    await deleteQuietly();
    throw new Error(`openshell could not create the release sandbox: ${describeError(e)}`);
  }
  o.emit.emit(`sandbox_created: ${name}`, { role: 'release', data: { event: 'sandbox_created', sandbox: name, role: 'release', repo: o.repoName, ms: Date.now() - t0 } });
  if (generated) {
    o.emit.emit(`sandbox_policy: ${endpointsOf(generated).length} allowed endpoint(s)`, {
      role: 'release', data: { event: 'sandbox_policy', sandbox: name, file: policyFile, allowed: endpointsOf(generated), declared: generated.extraHosts },
    });
  }

  // What the run sandbox's release does (runner.ts), through the same injected exec: fold the policy's
  // denied requests into the log, then delete.
  const closeSandbox = async (): Promise<void> => {
    try {
      const { stdout } = await run(cfg.bin, ['logs', name], process.env);
      for (const d of parseDeniedRequests(stdout)) {
        const where = `${d.host}${d.port !== undefined ? `:${d.port}` : ''}${d.binary ? ` by ${d.binary}` : ''}`;
        o.emit.warn(`sandbox_denied: ${where}${d.count > 1 ? ` (${d.count}x)` : ''} — blocked by the sandbox policy`, { data: { event: 'sandbox_denied', sandbox: name, ...d } });
      }
    } catch { /* the log is a convenience */ }
    const t1 = Date.now();
    await deleteQuietly();
    o.emit.emit(`sandbox_deleted: ${name}`, { role: 'release', data: { event: 'sandbox_deleted', sandbox: name, ms: Date.now() - t1 } });
  };
  try {
    const clone = `${releaseCloneScript({
      mirrorDir: cfg.mirrorDir, repo: o.repo, workDir: cfg.workDir, origin: o.origin, base: o.base,
      branches: o.branches, tagPattern: o.tagPattern,
    })}\n${containerEngineStubScript()}`;
    await run(cfg.bin, ['sandbox', 'exec', '-n', name, '--no-login-shell', '--', 'sh', '-c', clone], process.env);
  } catch (e) {
    await closeSandbox();
    throw new Error(`could not make the release clone in ${name}: ${describeError(e)}`);
  }

  const dir = registerRemoteDir({
    bin: cfg.bin, sandbox: name, workDir: cfg.workDir,
    prelude: `${sandboxEnvExports()}PATH=${shQuote(SANDBOX_STUB_DIR)}:"$PATH"; export PATH; `,
  });
  let closed = false;
  return {
    dir, sandbox: name,
    async close() {
      if (closed) return;
      closed = true;
      unregisterRemoteDir(dir);
      await closeSandbox();
    },
  };
}

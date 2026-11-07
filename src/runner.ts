/**
 * Where an agent run executes (CREW-2793, EPIC-075).
 *
 * `spawnAgent` plans nothing and parses nothing here: it asks a `Runner` to
 * start the harness with stdout appended to the run's stream file, and to kill,
 * probe and release it later. Two runners sit behind that boundary:
 *
 * - `host`    the harness is a detached child of the daemon, in the plan's cwd
 *             (the code that used to live inline in `spawnAgent`, unchanged).
 * - `sandbox` the harness runs inside an OpenShell sandbox created for this one
 *             run. The host process is the `openshell sandbox exec` client, whose
 *             stdout is the stream file exactly as for a host run, so the tailing,
 *             the sidecar, the wall-clock limit and the reattach path all see the
 *             same shape. Killing a run is deleting the sandbox.
 *
 * The run's `.pid` sidecar records the client's pid for both kinds, so
 * `runIsAlive` works unchanged; a sandbox run also records the sandbox name so
 * a restarted daemon can delete it when it finishes the run.
 */

import { sandboxEnvExports } from './sandbox-image.ts';
import { containerEngineStubScript, SANDBOX_STUB_DIR, DEFAULT_SANDBOX_WORKDIR, writeFilesScript } from './sandbox-brief.ts';
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentPlan } from './agent.ts';
import type { Emitter } from './events.ts';
import { killRunGroup } from './run-limit.ts';
import { generateSandboxPolicy, parseDeniedRequests, policyPathFor, type SandboxPolicy } from './sandbox-policy.ts';
import { cloneScript, describe as describeSandboxError, parseRemote, DEFAULT_CACHE_SETTINGS } from './sandbox-cache.ts';

const execFileP = promisify(execFile);

export type RunnerKind = 'host' | 'sandbox';

/** What survives of a started run: enough for any process to kill or release it. */
export interface RunHandle {
  runner: RunnerKind;
  /** The host process: the harness itself (host) or the `openshell sandbox exec` client (sandbox). */
  pid?: number;
  sandbox?: string;
  /** The OpenShell binary the sandbox was created with, so a restarted daemon uses the same one. */
  sandboxBin?: string;
}

export interface StartedRun {
  child: ChildProcess;
  handle: RunHandle;
  /** The prompt already reached the harness by another route (an upload), so `spawnAgent` must not also write it to `child.stdin`. */
  promptDelivered?: boolean;
}

export interface Runner {
  readonly kind: RunnerKind;
  /**
   * Starts the harness with stdout on `streamFd` and the prompt still to be written to `child.stdin`.
   * The host runner returns synchronously (the child exists, and its sidecar is written, before
   * `spawnAgent` returns); the sandbox runner has a create to wait for.
   */
  start(plan: AgentPlan, o: { env: NodeJS.ProcessEnv; streamFd: number; emit: Emitter }): StartedRun | Promise<StartedRun>;
  /** Ends the run. Safe to call on a run that is already gone. */
  kill(handle: RunHandle, reason: string): Promise<void>;
  /** Whether the run's host process is still the one that was started. */
  isAlive(handle: RunHandle, spawnedAt: string): boolean;
  /** The handle for a run found in a sidecar. */
  reattach(meta: { pid: number; sandbox?: string; sandboxBin?: string }): RunHandle;
  /** Tears down whatever the run left behind (the sandbox); a host run leaves nothing. */
  release(handle: RunHandle, emit: Emitter): Promise<void>;
}

/** `ship.sandbox` in crew.yaml. Every field has a default, so `runner: sandbox` alone is a valid config. */
export interface SandboxConfig {
  /** The `openshell` binary. */
  bin: string;
  /** Image the sandbox is created from; absent means the OpenShell base image. */
  image?: string;
  /** Policy file handed to `sandbox create --policy`. */
  policy?: string;
  /** Named volume holding the bare mirrors, mounted read-only at `mirrorDir`. */
  cacheVolume?: string;
  /** Where the mirrors are inside the sandbox. */
  mirrorDir: string;
  /** Directory in the sandbox the run's clone is made in. */
  workDir: string;
  /** The harness binary inside the image; default is the basename of the plan's `bin`. */
  agentBin?: string;
  /** Host environment variable carrying the forge token, injected without touching argv. */
  forgeTokenVar?: string;
  /** Container engine CLI that owns the cache volume (CREW-2799). */
  engine?: string;
  /** Value of the OpenShell workspace label on the cache volume. */
  cacheWorkspace?: string;
  /** Image of the helper containers that refresh the mirrors; needs `git`. */
  cacheImage?: string;
  /** Image dependency trees are built in; defaults to `image`. */
  depsImage?: string;
  /** Install command whose result is cached per lockfile hash, for example `pnpm install --frozen-lockfile`. */
  depsCommand?: string;
  /** Lockfile that keys the dependency tree. */
  depsLockfile?: string;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  bin: 'openshell', mirrorDir: '/cache', workDir: DEFAULT_SANDBOX_WORKDIR,
};

/** `sandbox exec` carries 4 MiB of piped stdin; a prompt near that goes through `sandbox upload`. */
export const SANDBOX_STDIN_LIMIT = 4 * 1024 * 1024 - 64 * 1024;

const SANDBOX_PROMPT_PATH = '/sandbox/prompt.txt';

export class HostRunner implements Runner {
  readonly kind = 'host' as const;

  start(plan: AgentPlan, o: { env: NodeJS.ProcessEnv; streamFd: number }): StartedRun {
    const child = spawn(plan.bin, plan.args, {
      cwd: plan.cwd, env: o.env, stdio: ['pipe', o.streamFd, 'inherit'], detached: true,
    });
    return { child, handle: { runner: 'host', pid: child.pid } };
  }

  async kill(handle: RunHandle): Promise<void> {
    if (handle.pid !== undefined) await killRunGroup(handle.pid);
  }

  isAlive(handle: RunHandle): boolean {
    if (handle.pid === undefined) return false;
    try { process.kill(handle.pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
  }

  reattach(meta: { pid: number }): RunHandle { return { runner: 'host', pid: meta.pid }; }

  async release(): Promise<void> { /* a host run leaves nothing behind */ }
}

/** POSIX single-quote, for the one `sh -c` line the sandbox runs. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The longest sandbox name the OpenShell gateway accepts on Linux (CREW-2947): the host-mode supervisor derives a network interface name (15 characters) from it. */
export const SANDBOX_NAME_MAX = 19;

/**
 * A sandbox name OpenShell accepts: lowercase, digits and dashes, at most
 * {@link SANDBOX_NAME_MAX} characters. `crew-` + a 6-character hash of route,
 * role and ticket + the time in base36 (8 characters for any date this century),
 * with no separator: the dash would make it 20.
 * The readable route, role and ticket live in the run sidecar and the
 * `sandbox_created` event; nothing reads them back from the name.
 */
export function sandboxName(plan: Pick<AgentPlan, 'route' | 'ticket'> & { role: string }, now = Date.now()): string {
  const h = createHash('sha256').update([plan.route, plan.role, plan.ticket ?? ''].join('\0')).digest();
  const tag = (h.readUInt32BE(0) % 36 ** 6).toString(36).padStart(6, '0');
  return `crew-${tag}${now.toString(36).slice(-8).padStart(8, '0')}`;
}

/** Characters an OpenShell label value accepts; anything else becomes `_`, and the value is capped at 63. */
function labelValue(v: string): string {
  return v.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 63);
}

/**
 * Labels naming who a sandbox was created for (CREW-3034), so a leaked one can
 * be attributed from `docker inspect` alone. A role with no ticket (release)
 * carries no ticket label.
 */
export function sandboxLabels(o: { role: string; ticket?: string | null; run: string }): string[] {
  return [
    `crew.role=${labelValue(o.role)}`,
    ...(o.ticket ? [`crew.ticket=${labelValue(o.ticket)}`] : []),
    `crew.run=${labelValue(o.run)}`,
  ];
}

export class SandboxRunner implements Runner {
  readonly kind = 'sandbox' as const;
  private readonly cfg: SandboxConfig;
  /** Injected for tests; the real one reads the plan's checkout. */
  private readonly originOf: (cwd: string) => string | null;

  constructor(cfg: Partial<SandboxConfig> = {}, originOf: (cwd: string) => string | null = gitOrigin) {
    this.cfg = { ...DEFAULT_SANDBOX_CONFIG, ...cfg };
    this.originOf = originOf;
  }

  private os(args: string[], o: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<{ stdout: string; stderr: string }> {
    return execFileP(this.cfg.bin, args, { env: o.env ?? process.env, maxBuffer: 16 * 1024 * 1024 });
  }

  async start(plan: AgentPlan, o: { env: NodeJS.ProcessEnv; streamFd: number; emit: Emitter }): Promise<StartedRun> {
    // CREW-2946: the ticket's own repository; the route directory's origin only serves a run with none.
    const origin = plan.sandboxOrigin ?? (plan.repo ? null : this.originOf(plan.cwd));
    if (!origin) {
      throw new Error(plan.repo
        ? `cannot place the repository ${plan.repo} of ${plan.ticket ?? 'this run'} on route ${plan.route}, so there is nothing to clone into the sandbox`
        : `cannot find the origin remote of ${plan.cwd}, so there is nothing to clone into the sandbox`);
    }
    const repo = parseRemote(origin);
    if (!repo) throw new Error(`cannot read a forge host and path from the origin remote ${origin}`);
    const name = sandboxName(plan);
    const { cfg } = this;

    // Secrets go in through `--env-from`, read from the create process's own
    // environment; `--env` and argv are for non-secrets only (OpenShell's rule).
    const secretKeys = Object.keys(plan.setEnv);
    if (cfg.forgeTokenVar && o.env[cfg.forgeTokenVar] !== undefined && !secretKeys.includes(cfg.forgeTokenVar)) secretKeys.push(cfg.forgeTokenVar);
    // CREW-2998: the gateway refuses a newline in any environment value, and its message does not
    // say which; name the variable here instead.
    for (const [k, v] of Object.entries(plan.setEnv)) {
      if (/[\r\n]/.test(v)) throw new Error(`the sandbox environment variable ${k} contains a newline, which the sandbox gateway refuses`);
    }
    const createEnv: NodeJS.ProcessEnv = { ...process.env, ...plan.setEnv };
    // CREW-3084: the ticket repository's own environment, by name only in argv; a name crew already sets is not overridden.
    for (const [k, v] of Object.entries(plan.sandboxRepoEnv ?? {})) {
      if (k in plan.setEnv) continue;
      if (/[\r\n]/.test(v)) throw new Error(`the repository environment variable ${k} contains a newline, which the sandbox gateway refuses`);
      createEnv[k] = v;
      if (!secretKeys.includes(k)) secretKeys.push(k);
    }
    if (cfg.forgeTokenVar && o.env[cfg.forgeTokenVar] !== undefined) createEnv[cfg.forgeTokenVar] = o.env[cfg.forgeTokenVar];

    // CREW-2801: crew writes the policy for every run, beside the stream files.
    // An explicit `ship.sandbox.policy` is the operator's override and wins.
    let policyFile = cfg.policy;
    let generated: SandboxPolicy | undefined;
    if (!policyFile && plan.sandboxPolicy) {
      try {
        generated = generateSandboxPolicy({ mirrorDir: cfg.mirrorDir, workDir: cfg.workDir, ...plan.sandboxPolicy });
      } catch (e) {
        throw new Error(`cannot generate the sandbox policy: ${(e as Error).message}`);
      }
      policyFile = policyPathFor(plan.streamPath);
      mkdirSync(dirname(policyFile), { recursive: true });
      writeFileSync(policyFile, generated.yaml, { mode: 0o600 });
    }

    const create = ['sandbox', 'create', '--name', name, '--detach'];
    if (policyFile) create.push('--policy', policyFile);
    for (const l of sandboxLabels({ role: plan.role, ticket: plan.ticket, run: basename(plan.streamPath).replace(/\.jsonl$/, '') })) create.push('--label', l);
    const image = cfg.image ?? plan.sandboxImage;
    if (image) create.push('--from', image);
    if (cfg.cacheVolume) {
      create.push('--driver-config-json', JSON.stringify({
        docker: { mounts: [{ type: 'volume', source: cfg.cacheVolume, target: cfg.mirrorDir, read_only: true }] },
      }));
    }
    for (const k of secretKeys) create.push('--env-from', k);
    const maxSeconds = Math.max(60, Math.ceil((plan.maxRunMinutes ?? 0) * 60) + 600);
    create.push('--', 'sleep', String(plan.maxRunMinutes ? maxSeconds : 86_400));

    const t0 = Date.now();
    try {
      await this.os(create, { env: createEnv });
    } catch (e) {
      await this.deleteQuietly(name);
      throw new Error(`openshell could not create the sandbox: ${describeExecError(e)}`);
    }
    const imageNote = plan.sandboxImageReason ? ` (image ${image ?? 'default'}: ${plan.sandboxImageReason})` : '';
    o.emit.emit(`sandbox_created: ${name}${imageNote}`, { role: plan.role, data: { event: 'sandbox_created', sandbox: name, ms: Date.now() - t0, ...(plan.sandboxImageReason ? { image: image ?? null, imageReason: plan.sandboxImageReason } : {}) } });
    const handle: RunHandle = { runner: 'sandbox', sandbox: name, sandboxBin: cfg.bin };
    if (generated) {
      // The run log records what the policy let through, and any host the repository added.
      const hosts = generated.groups.flatMap((g) => g.endpoints.map((e) => `${e.host}:${e.port}`));
      o.emit.emit(`sandbox_policy: ${hosts.length} allowed endpoint(s)${generated.extraHosts.length ? `; declared by the repository: ${generated.extraHosts.join(', ')}` : ''}`, {
        role: plan.role, data: { event: 'sandbox_policy', sandbox: name, file: policyFile, allowed: hosts, declared: generated.extraHosts },
      });
    }

    try {
      // The run's checkout: a shared clone of the read-only mirror on a fresh branch.
      const branch = `crew-run-${name.slice(-8)}`;
      const clone = `${cloneScript({
        mirrorDir: cfg.mirrorDir, repo, workDir: cfg.workDir, origin, branch, lockfile: cfg.depsLockfile ?? DEFAULT_CACHE_SETTINGS.depsLockfile,
      })} && ${containerEngineStubScript()}`;
      await this.os(['sandbox', 'exec', '-n', name, '--no-login-shell', '--', 'sh', '-c', clone]);
      // CREW-2922: the symbol bridge's Gemini settings and the `typescript-lsp` plugin, written before the harness starts.
      if (plan.sandboxFiles?.length) {
        await this.os(['sandbox', 'exec', '-n', name, '--no-login-shell', '--', 'sh', '-c', writeFilesScript(plan.sandboxFiles)]);
      }

      const harness = cfg.agentBin ?? basename(plan.bin);
      const viaUpload = Buffer.byteLength(plan.prompt) > SANDBOX_STDIN_LIMIT;
      if (viaUpload) {
        const tmp = mkdtempSync(join(tmpdir(), 'crew-prompt-'));
        try {
          const file = join(tmp, 'prompt.txt');
          writeFileSync(file, plan.prompt, { mode: 0o600 });
          await this.os(['sandbox', 'upload', name, file, SANDBOX_PROMPT_PATH]);
        } finally { rmSync(tmp, { recursive: true, force: true }); }
      }
      // CREW-2800: the stub container-engine CLIs come first on PATH, so a hook that reaches for
      // docker fails with the message naming the in-sandbox services pattern.
      // CREW-2968: `sandbox exec` does not carry the image's `ENV` (only PATH arrives), so the crew
      // layer's variables are exported here for the harness and every hook it runs.
      const withStubs = `${sandboxEnvExports()}PATH=${shQuote(SANDBOX_STUB_DIR)}:"$PATH"; export PATH; `;
      const command = viaUpload
        ? ['sh', '-c', `${withStubs}exec ${[harness, ...plan.args].map(shQuote).join(' ')} < ${SANDBOX_PROMPT_PATH}`]
        : ['sh', '-c', `${withStubs}exec "$@"`, 'sh', harness, ...plan.args];
      const child = spawn(cfg.bin, ['sandbox', 'exec', '-n', name, '--no-login-shell', '--workdir', cfg.workDir, '--', ...command], {
        env: process.env, stdio: ['pipe', o.streamFd, 'inherit'], detached: true,
      });
      return { child, handle: { ...handle, pid: child.pid }, ...(viaUpload ? { promptDelivered: true } : {}) };
    } catch (e) {
      await this.release(handle, o.emit);
      throw new Error(`could not prepare the sandbox ${name}: ${describeExecError(e)}`);
    }
  }

  async kill(handle: RunHandle): Promise<void> {
    // Deleting the sandbox ends the exec client within a second or so; the
    // process-group kill is the fallback for a client that is wedged.
    if (handle.sandbox) await this.deleteQuietly(handle.sandbox, handle.sandboxBin);
    if (handle.pid !== undefined) await killRunGroup(handle.pid, { graceMs: 2_000 });
  }

  isAlive(handle: RunHandle): boolean {
    return new HostRunner().isAlive(handle);
  }

  reattach(meta: { pid: number; sandbox?: string; sandboxBin?: string }): RunHandle {
    return { runner: 'sandbox', pid: meta.pid, sandbox: meta.sandbox, sandboxBin: meta.sandboxBin };
  }

  async release(handle: RunHandle, emit: Emitter): Promise<void> {
    if (!handle.sandbox) return;
    await this.foldDenied(handle.sandbox, handle.sandboxBin, emit);
    const t0 = Date.now();
    await this.deleteQuietly(handle.sandbox, handle.sandboxBin);
    emit.emit(`sandbox_deleted: ${handle.sandbox}`, { data: { event: 'sandbox_deleted', sandbox: handle.sandbox, ms: Date.now() - t0 } });
  }

  /**
   * Denied requests from the sandbox log become `sandbox_denied` events in the
   * run's event stream (CREW-2801), so an agent blocked by policy is diagnosable
   * from the Mac app. Read before the delete, which takes the log with it.
   */
  private async foldDenied(name: string, bin: string | undefined, emit: Emitter): Promise<void> {
    let log: string;
    try { log = (await execFileP(bin ?? this.cfg.bin, ['logs', name], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })).stdout; } catch { return; }
    for (const d of parseDeniedRequests(log)) {
      const where = `${d.host}${d.port !== undefined ? `:${d.port}` : ''}${d.binary ? ` by ${d.binary}` : ''}`;
      emit.warn(`sandbox_denied: ${where}${d.count > 1 ? ` (${d.count}x)` : ''} — blocked by the sandbox policy`, { data: { event: 'sandbox_denied', sandbox: name, ...d } });
    }
  }

  private async deleteQuietly(name: string, bin = this.cfg.bin): Promise<void> {
    try { await execFileP(bin, ['sandbox', 'delete', name], { timeout: 60_000 }); } catch { /* already gone, or the gateway is down: nothing more to do from here */ }
  }
}

const describeExecError = describeSandboxError;

function gitOrigin(cwd: string): string | null {
  try {
    return execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

/** The runner for a ship's `runner:` setting. */
export function runnerFor(kind: RunnerKind | undefined, sandbox?: Partial<SandboxConfig>): Runner {
  return kind === 'sandbox' ? new SandboxRunner(sandbox) : new HostRunner();
}

/** The runner a sidecar was written by, for the processes that finish a run they did not start. */
export function runnerOfSidecar(sc: { runner?: RunnerKind; sandboxBin?: string }): Runner {
  return sc.runner === 'sandbox' ? new SandboxRunner(sc.sandboxBin ? { bin: sc.sandboxBin } : {}) : new HostRunner();
}

export interface SandboxCheck { ok: boolean; detail: string }

/**
 * `crew doctor` for `ship.runner: sandbox`: the OpenShell CLI is installed and
 * its gateway answers. The gateway's host-specific settings are the spike's
 * "found the hard way" list (CREW-2787), so a refusal names them.
 */
const PROBE_CREATE_TIMEOUT_MS = 120_000;

export function checkSandboxRunner(cfg: Partial<SandboxConfig> = {}, run: (bin: string, args: string[], timeoutMs?: number) => string = (b, a, t) =>
  execFileSync(b, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: t ?? 15_000 })): SandboxCheck {
  const bin = cfg.bin ?? DEFAULT_SANDBOX_CONFIG.bin;
  let version: string;
  try { version = run(bin, ['--version']).trim(); } catch (e) {
    return { ok: false, detail: `${bin} is not installed or not on the scheduler PATH (${(e as Error).message.split('\n')[0]})` };
  }
  try { run(bin, ['status']); } catch (e) {
    const err = e as { stderr?: string; message: string };
    return {
      ok: false,
      detail: `${version}: the gateway does not answer (${(err.stderr || err.message).trim().split('\n').filter(Boolean).slice(0, 2).join(' / ')}). ` +
        'Start it; on Docker Desktop its docker section needs supervisor_network_mode = "bridge", and allow_driver_config = true for the cache volume mount.',
    };
  }
  // CREW-2947: a gateway can be healthy and still refuse crew's names (the
  // host-mode length limit), so create and delete one with a crew-shaped name.
  const probe = sandboxName({ route: 'doctor', role: 'dev', ticket: undefined });
  // The first create on a host pulls the supervisor and runtime images, which
  // outlasts the default 15 s, so the probe gets its own limit. It ends in
  // `-- sleep 60` like the real create: no wait on a command, and a probe that
  // outlives a failed delete still stops by itself.
  try { run(bin, ['sandbox', 'create', '--name', probe, '--detach', '--', 'sleep', '60'], PROBE_CREATE_TIMEOUT_MS); } catch (e) {
    const err = e as { stderr?: string; message: string; code?: string; killed?: boolean };
    if (err.code === 'ETIMEDOUT' || err.killed) {
      return { ok: false, detail: `${version}: creating a probe sandbox named ${probe} timed out after ${PROBE_CREATE_TIMEOUT_MS / 1000} s; the gateway may still be pulling its images on a first create, so run crew doctor again` };
    }
    return { ok: false, detail: `${version}: the gateway refused a probe sandbox named ${probe} (${(err.stderr || err.message).trim().split('\n').filter(Boolean).slice(0, 2).join(' / ')})` };
  } finally {
    try { run(bin, ['sandbox', 'delete', probe]); } catch { /* never created, or already gone */ }
  }
  return { ok: true, detail: version };
}

import { INTEL_MINIMUM_TOOLS, INTEL_SERVER_NAME, lspFlavor, lspToolsParagraph, wantsCodeBridge } from './intel.ts';

/**
 * What differs in a run's prompt and sandbox when the run executes under the
 * sandbox runner (CREW-2800).
 *
 * Three small pieces, all keyed on the runner kind and nothing else, so the
 * prompts stay generic and host runs are untouched:
 *
 * - the environment's checkout section (`sandboxCheckoutSection`): the agent is
 *   already in a fresh clone on a fresh branch and there is no primary checkout;
 * - the skill swap (`swapSandboxSkills`): the lane policy names the `Worktree
 *   Setup` skill, whose steps (cut a worktree, copy files from the primary
 *   checkout) cannot be followed in a sandbox, so the sandboxed prompt names
 *   `Sandbox Setup` instead;
 * - the container-engine stubs (`containerEngineStubScript`): a sandbox has no
 *   container engine, and a `hooks.setup` that reaches for one fails at once
 *   with a message naming the in-sandbox services pattern instead of hanging.
 */

/** The skill a host run's lane policy names, and the one a sandboxed run reads in its place. */
export const SANDBOX_SKILL_SWAPS: ReadonlyArray<readonly [host: string, sandbox: string]> = [
  ['Worktree Setup', 'Sandbox Setup'],
];

/** Where the stub `docker`/`podman` live; put first on the harness's `PATH`. */
export const SANDBOX_STUB_DIR = '/sandbox/.crew-bin';

/** The container-engine CLIs a sandbox refuses. */
export const CONTAINER_ENGINES = ['docker', 'podman', 'nerdctl', 'docker-compose'] as const;

/** What a refused container-engine call prints. Names the pattern, so the fix is one search away. */
export const CONTAINER_ENGINE_MESSAGE =
  'crew: this run is inside a sandbox, which has no container engine. Run the service as a process ' +
  'in hooks.setup instead (ports from hooks.ports, overrides from hooks.isolate) — see "Services inside the sandbox" in REPO_SPEC.md.';

/** Rewrites each host-only skill name in a brief to its sandbox counterpart. Backticked names only, as the lane policy writes them. */
export function swapSandboxSkills(text: string): string {
  let out = text;
  for (const [host, sandbox] of SANDBOX_SKILL_SWAPS) out = out.split(`\`${host}\``).join(`\`${sandbox}\``);
  return out;
}

/**
 * A shell fragment that creates the stubs. Each prints the message on stderr
 * and exits 125 (docker's own "the daemon could not be reached" class of code),
 * never 0: a setup that carries on past a missing database is a worse failure
 * than one that stops.
 */
export function containerEngineStubScript(dir = SANDBOX_STUB_DIR): string {
  const body = `#!/bin/sh\nprintf '%s\\n' ${shSingle(CONTAINER_ENGINE_MESSAGE)} >&2\nexit 125\n`;
  return [
    `mkdir -p ${shSingle(dir)}`,
    ...CONTAINER_ENGINES.map((e) => `printf '%b' ${shSingle(body)} > ${shSingle(`${dir}/${e}`)} && chmod 755 ${shSingle(`${dir}/${e}`)}`),
  ].join(' && ');
}

/**
 * A shell line that writes `files` (absolute path, text) inside a sandbox, creating directories
 * (CREW-2922). Content travels base64-encoded so no quoting of the text can break the line, and a
 * sandbox's `sandbox upload` does not have to create parent directories.
 */
export function writeFilesScript(files: ReadonlyArray<{ path: string; content: string }>): string {
  return files
    .map((f) => {
      const dir = f.path.slice(0, f.path.lastIndexOf('/')) || '/';
      return `mkdir -p ${shSingle(dir)} && printf %s ${shSingle(Buffer.from(f.content, 'utf8').toString('base64'))} | base64 -d > ${shSingle(f.path)}`;
    })
    .join(' && ');
}

function shSingle(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The first container-engine invocation in a hook, or null. Used by
 * `crew repos check` to warn about a hook that cannot run in a sandbox before a
 * run finds out. A command word only: `echo docker` or a path segment does not count.
 */
export function containerEngineUse(hook: string): string | null {
  const names = CONTAINER_ENGINES.map((e) => e.replace(/-/g, '\\-')).join('|');
  const re = new RegExp(`(?:^|[;&|(\`]|&&|\\|\\||\\$\\()\\s*(?:(?:then|do|else|elif|if|while|until|time|exec)\\s+)*(?:sudo\\s+)?(?:\\S*/)?(${names})(?=\\s|$)`, 'm');
  const m = re.exec(hook.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'));
  return m ? m[1]! : null;
}

/** The environment section that replaces the worktree one for a sandboxed run. */
export function sandboxCheckoutSection(workDir: string, heading: string): string[] {
  return [
    '',
    heading,
    '',
    `You are already inside a sandbox created for this run. \`${workDir}\` is a fresh`,
    'clone of the repository on a fresh branch, and it is your working directory. There is',
    'no primary checkout and no other worktree: do not cut a worktree, do not run `crew',
    'worktree`, and do not look for files to copy from a main checkout. The digest\'s',
    '`worktree` column does not apply; its `branch` column is the name your work is pushed',
    'under, so create it with `git checkout -b <branch>` in the clone.',
    '',
    'The sandbox has no container engine, and nothing installs at run time: a service the',
    'tests need is a process the repository\'s `setup` hook starts. Fetch the `Sandbox Setup`',
    'skill for setup, ports and the hand-off push.',
  ];
}

/**
 * The "Code tools" paragraph of a sandboxed lane run (CREW-2922), for a repository's `hooks.intel`;
 * empty when it declares none. Written for the lane-run form: the symbol service is not running at
 * launch, so the paragraph says when it appears and what the agent does about it (nothing, beyond
 * running `setup` first, which the order of the lane policy already has it do).
 */
export function sandboxCodeToolsSection(intel: string | undefined): string[] {
  if (lspFlavor(intel)) return ['', `**Code tools.** On the Claude Code harness: ${lspToolsParagraph('claude').replace(/^The harness's/, 'the harness\'s')}`];
  if (!wantsCodeBridge(intel)) return [];
  return [
    '',
    `**Code tools.** A \`${INTEL_SERVER_NAME}\` MCP server serves this repository's symbols from its language server. It offers at least: ${INTEL_MINIMUM_TOOLS.join('; ')}.`,
    'It lists only `code_status` until the symbol service is up. The service starts inside this sandbox',
    'the first time the session asks the server for tools, and it expects `setup` to have run, so run `setup`',
    'before your first lookup. `code_status` says whether it is starting, attached, or failed to start (and why).',
  ];
}

/** `renderEnvironment`'s `sandbox` input for a ship: set under `ship.runner: sandbox`, empty otherwise. */
export function sandboxEnv(ship: { runner?: string; sandbox?: { workDir?: string } }): { sandbox?: { workDir: string } } {
  return ship.runner === 'sandbox' ? { sandbox: { workDir: ship.sandbox?.workDir ?? DEFAULT_SANDBOX_WORKDIR } } : {};
}

/** Mirrors `DEFAULT_SANDBOX_CONFIG.workDir` (runner.ts), which imports this module and so cannot be imported here. */
export const DEFAULT_SANDBOX_WORKDIR = '/sandbox/work';

/**
 * `crew connect`'s first-run wizard (CREW-1286).
 *
 * Runs only on a real terminal with no `crew.yaml` at any config search
 * location. It asks the handful of `ship:` questions a new machine has to
 * answer (name, agent binary, Host Passengers), works out `ship.extraPath`
 * from where `node`/`pnpm` actually live, and — once the connection has
 * resolved — writes the whole file instead of printing a block to paste.
 *
 * Everything here is pure or takes its dependencies as arguments (prompts,
 * PATH, a Docker probe), so the wizard is unit-tested without a TTY. The one
 * file write, `writeNewConfig`, refuses to touch a file that already exists:
 * an existing, hand-maintained `crew.yaml` keeps the print-and-paste path.
 */

import { delimiter, dirname, join } from 'node:path';
import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { configSearchPath, defaultConfigPath } from './config.ts';
import type { ShipPlatform } from './platform.ts';

/** Where the Host Passengers explanation lives. */
export const HOST_PASSENGERS_DOCS_URL = 'https://crew.tablation.dev/host-passengers';

/** Just what the wizard needs from a terminal — a real readline in `cli.ts`, a script in tests. */
export interface Prompter {
  /** Free text; a blank answer returns `fallback`. */
  ask(question: string, fallback?: string): Promise<string>;
  /** Yes/no; a blank answer returns `fallback`. */
  confirm(question: string, fallback: boolean): Promise<boolean>;
  /** One line of explanation, not a question. */
  say(line: string): void;
}

export interface WizardAnswers {
  name: string;
  platform: ShipPlatform;
  agentBin: string;
  extraPath?: string;
  hostPassengers: boolean;
}

export interface WizardEnv {
  hostname: string;
  platform: ShipPlatform;
  /** The PATH to search for `claude`/`node`/`pnpm`. */
  pathEnv: string;
  /** `process.execPath` — always an absolute path to the node running crew. */
  nodePath: string;
  dockerAvailable: boolean;
  /** Overridable so a test needs no real executables. */
  isExecutable?: (path: string) => boolean;
}

/**
 * The wizard runs only when a person is there to answer AND nothing is
 * configured anywhere crew would look. The second half is what keeps an
 * existing file from ever being rewritten.
 */
export function shouldRunWizard(opts: { isTTY: boolean; crewHome: string; configExists?: (p: string) => boolean }): boolean {
  if (!opts.isTTY) return false;
  const exists = opts.configExists ?? existsSync;
  return !configSearchPath(opts.crewHome).some((p) => exists(p));
}

/** Where a first-run config is written: `CREW_CONFIG` if set (the only place crew would then look), else the default location. */
export function firstRunConfigPath(): string {
  return process.env.CREW_CONFIG ?? defaultConfigPath();
}

function defaultIsExecutable(p: string): boolean {
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
}

/** The first `name` on `pathEnv` that is executable — `which`, minus the child process. */
export function findOnPath(
  name: string, pathEnv: string, isExecutable: (p: string) => boolean = defaultIsExecutable,
): string | undefined {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * `ship.extraPath` from the directories `node` and `pnpm` resolve in. A
 * scheduler fires crew with a minimal PATH (see `install.ts`'s header), so a
 * hook that runs `pnpm` finds nothing unless these are named. Directories a
 * scheduler's minimal PATH already carries are not worth listing.
 */
export function deriveExtraPath(dirs: Array<string | undefined>): string | undefined {
  const MINIMAL = new Set(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  const out = [...new Set(dirs.filter((d): d is string => !!d && !MINIMAL.has(d)))];
  return out.length > 0 ? out.join(delimiter) : undefined;
}

export async function runWizard(p: Prompter, env: WizardEnv): Promise<WizardAnswers> {
  const isExec = env.isExecutable ?? defaultIsExecutable;
  p.say('\nFirst run: no crew.yaml found, so a few questions to set this machine up.\n');

  const name = await p.ask('Ship name (how this machine appears on the board)', env.hostname);

  // The agent binary: show what resolves, let the person confirm or redirect.
  let agentBin = findOnPath('claude', env.pathEnv, isExec);
  if (agentBin) {
    p.say(`Found the agent binary at ${agentBin}`);
    if (!(await p.confirm('Use it?', true))) agentBin = undefined;
  } else {
    p.say('Could not find "claude" on your PATH.');
  }
  while (!agentBin) {
    const entered = await p.ask('Absolute path to the agent binary');
    if (entered && isExec(entered)) agentBin = entered;
    else p.say(entered ? `${entered} is not an executable file.` : 'A path is required.');
  }

  const nodeDir = dirname(env.nodePath);
  const pnpmPath = findOnPath('pnpm', env.pathEnv, isExec);
  const extraPath = deriveExtraPath([nodeDir, pnpmPath ? dirname(pnpmPath) : undefined]);
  if (extraPath) p.say(`Hooks will get ${extraPath} on their PATH (where node and pnpm live).`);

  p.say(
    '\nHost Passengers lets this machine run the agent sessions that other people\'s\n' +
      `Tablation workspaces ask for, in a container. More: ${HOST_PASSENGERS_DOCS_URL}`,
  );
  const hostPassengers = await p.confirm('Host Passengers on this machine?', false);
  if (hostPassengers && !env.dockerAvailable) {
    p.say('Docker is not available here, so nothing will be hosted until it is. Your answer is recorded anyway.');
  }

  return { name, platform: env.platform, agentBin, extraPath, hostPassengers };
}

/** The `ship:` block, with only what the wizard asked — everything else keeps its default. */
export function renderShipBlock(a: WizardAnswers): string {
  return stringify({
    ship: {
      name: a.name,
      platform: a.platform,
      agent: { bin: a.agentBin },
      ...(a.extraPath ? { extraPath: a.extraPath } : {}),
    },
  });
}

/** The full file: the `ship:` block, then `routes:` with the discovered block already indented as a list item. */
export function renderFullConfig(a: WizardAnswers, routeBlock: string): string {
  return `${renderShipBlock(a)}\nroutes:\n${routeBlock}`;
}

/**
 * Writes `text` at `path` with mode 0600 (the file can name a key file) —
 * and only if nothing is there. Returns false, writing nothing, when a file
 * already exists, so a race with another `crew connect` can never overwrite
 * a config someone else just made.
 */
export function writeNewConfig(path: string, text: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

/** What to do next, for the end of a first-run connect. */
export function nextSteps(o: { route: string; configPath: string; platform: ShipPlatform; needsRepos: boolean }): string {
  const lines = [`\nWrote ${o.configPath}.\n`, 'Next:'];
  let n = 1;
  if (o.needsRepos) {
    lines.push(
      `  ${n++}. Tell crew where each repo's checkout lives:`,
      `       crew repos add ${o.route} <repo-name> <path-to-checkout>`,
    );
  }
  lines.push(`  ${n++}. Check the setup:  crew doctor ${o.route}`);
  lines.push(
    '',
    `Nothing runs yet: the route is written with enabled: false. Set enabled: true in ${o.configPath},`,
    'then run `crew install` to start it on a schedule.',
  );
  if (o.platform === 'windows') {
    lines.push('Windows has no scheduler support yet, so `crew install` will not work on this machine.');
  }
  return `${lines.join('\n')}\n`;
}

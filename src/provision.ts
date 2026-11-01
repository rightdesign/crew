/**
 * `crew provision` (CREW-2792): one non-interactive command that takes a
 * headless host from "crew is installed" to "a daemon is running": connect
 * each route (the `--json` path), store forge tokens, enable the routes,
 * install the units (with lingering, or as a system unit under root), and
 * start the daemon. It is what `scripts/provision.sh` runs from a cloud
 * first-boot hook.
 *
 * IDEMPOTENT BY RECONCILING. Every step looks at what is already there and
 * acts only on a difference: connect is already idempotent, a forge token is
 * compared with the stored one through the credential helper, a route is
 * enabled only if it is not, units are rewritten only when their text
 * differs or the daemon is down. A run that changed nothing reports
 * `already provisioned`.
 *
 * The orchestration is separated from the machine (`ProvisionDeps`) so the
 * decisions are tested with fakes; `realProvisionDeps` is the only part that
 * spawns processes and touches disk.
 *
 * Secrets never travel in argv or in a file crew did not already own: the
 * connect key goes to the child as `CREW_CONNECT_KEY`, a forge token as stdin.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { parseDocument } from 'yaml';
import { findConfigFile, loadConfig } from './config.ts';
import { hostPlatform } from './platform.ts';
import {
  crewInvocation, detectSystemd, installContext, labelFor, planInstall, systemUnitPathFor,
  type InstallJob,
} from './install.ts';
import { planEnable } from './doctor-fix.ts';

/** Exit codes mirror `connect --json`: 0 done, 1 a step failed, 2 bad input or a problem, 3 a decision is needed. */
export const PROVISION_EXIT = { ok: 0, failed: 1, problem: 2, choice: 3 } as const;

export interface ProvisionOptions {
  /** Connect key (`--key` or `CREW_CONNECT_KEY`). */
  key?: string;
  /** Routes to connect and serve, each a `workspace[/project]` argument of `crew connect`. */
  routes: string[];
  shipName?: string;
  agentBin?: string;
  extraPath?: string;
  baseUrl?: string;
  /** Forge hosts to store a token for; each token comes from `tokens`. */
  forgeHosts: string[];
  /** host -> token. Never logged. */
  tokens: Record<string, string>;
  json: boolean;
  dryRun: boolean;
  /** `--choose key=value` answers to pass through to connect. */
  choices: string[];
}

export interface RunResult { status: number; stdout: string; stderr: string }

export interface InstallState {
  /** Mechanism the host will use (`systemd`, `cron`, `launchd`). */
  mechanism: string;
  /** Some unit file is missing or differs from what `crew install` would write. */
  unitsStale: boolean;
  /** The `run` job is active (systemd) — the daemon is up. */
  running: boolean;
  /** Lingering is on, or not applicable (system unit, not systemd). */
  lingering: boolean;
}

export interface ProvisionDeps {
  /** Runs `crew <args>` with extra env and optional stdin. */
  crew(args: string[], o?: { env?: Record<string, string>; input?: string }): RunResult;
  /** crew.yaml path once it exists, else null. */
  configFile(): string | null;
  /** Sets `enabled: true` on a route; true when it changed. */
  enableRoute(route: string): boolean;
  installState(): InstallState;
  /** The token the credential helper currently answers for a host, or null. */
  storedToken(host: string): string | null;
  defaultShipName(): string;
}

export type ProvisionEvent =
  | 'connect' | 'route_enabled' | 'forge' | 'install' | 'daemon' | 'choice' | 'problem' | 'done';

export interface ProvisionSummary {
  ok: boolean;
  /** `provisioned` when anything changed, `already provisioned` when nothing did. */
  state: 'provisioned' | 'already provisioned' | 'dry-run' | 'failed';
  changed: boolean;
  ship?: string;
  routes: string[];
  forges: Array<{ host: string; action: 'stored' | 'rotated' | 'unchanged' }>;
  daemon?: { mechanism: string; running: boolean; lingering: boolean };
  configPath?: string;
}

export interface ProvisionOutcome { code: number; summary: ProvisionSummary }

/** One JSON object per line from a `connect --json` child. Unparseable lines are skipped. */
export function parseEvents(stdout: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { out.push(JSON.parse(t) as Record<string, unknown>); } catch { /* not an event */ }
  }
  return out;
}

export async function runProvision(
  o: ProvisionOptions, deps: ProvisionDeps, write: (line: string) => void, human: (line: string) => void,
): Promise<ProvisionOutcome> {
  const summary: ProvisionSummary = { ok: false, state: 'failed', changed: false, routes: [], forges: [] };
  const emit = (event: ProvisionEvent, message: string, data: Record<string, unknown> = {}) => {
    if (o.json) write(`${JSON.stringify({ ...data, event, message })}\n`);
    else human(`${message}\n`);
  };
  const fail = (code: number, message: string, data: Record<string, unknown> = {}): ProvisionOutcome => {
    emit('problem', message, data);
    return { code, summary: { ...summary, ok: false, state: 'failed' } };
  };

  if (!o.key) return fail(PROVISION_EXIT.problem, 'no connect key: pass --key or set CREW_CONNECT_KEY', { stage: 'input' });
  if (o.routes.length === 0) {
    return fail(PROVISION_EXIT.problem, 'no routes to serve: pass --route WORKSPACE[/PROJECT] (repeatable) or set CREW_PROVISION_ROUTES', { stage: 'input' });
  }
  for (const host of o.forgeHosts) {
    if (!o.tokens[host]) return fail(PROVISION_EXIT.problem, `no token for forge ${host}: set CREW_FORGE_TOKEN or CREW_FORGE_TOKEN_${envKey(host)}`, { stage: 'input' });
  }

  const shipName = o.shipName ?? deps.defaultShipName();
  summary.ship = shipName;

  // 1. connect each route. A non-zero exit stops the run; exit 3 is a decision the caller must answer.
  const routeNames: string[] = [];
  for (const route of o.routes) {
    const args = [
      'connect', route, '--json', '--no-wizard', '--ship-name', shipName,
      ...(o.agentBin ? ['--agent-bin', o.agentBin] : []),
      ...(o.extraPath ? ['--extra-path', o.extraPath] : []),
      ...(o.baseUrl ? ['--base-url', o.baseUrl] : []),
      ...(o.dryRun ? ['--dry-run'] : []),
      ...o.choices.flatMap((c) => ['--choose', c]),
    ];
    const res = deps.crew(args, { env: { CREW_CONNECT_KEY: o.key } });
    const events = parseEvents(res.stdout);
    for (const e of events) if (o.json) write(`${JSON.stringify({ ...e, phase: 'connect' })}\n`);
    if (res.status !== 0) {
      const problem = events.find((e) => e.event === 'problem');
      const msg = String(problem?.message ?? (res.stderr.trim().split('\n').pop() || `crew connect ${route} exited ${res.status}`));
      // Events were forwarded above; add the failure on stderr for a terminal and stop.
      if (!o.json) human(`crew provision: connect ${route}: ${msg}\n`);
      return { code: res.status === PROVISION_EXIT.choice ? PROVISION_EXIT.choice : res.status, summary: { ...summary, ok: false, state: 'failed' } };
    }
    const done = events.find((e) => e.event === 'done');
    const name = String(done?.route ?? route);
    routeNames.push(name);
    const shipRow = events.find((e) => e.event === 'ship_row');
    if (shipRow?.action === 'created') summary.changed = true;
    if (done?.wroteConfig === true) summary.changed = true;
    emit('connect', `connected ${name}${shipRow ? ` (ship row ${String(shipRow.action)})` : ''}`, { route: name });
  }
  summary.routes = routeNames;

  if (o.dryRun) {
    summary.ok = true;
    summary.state = 'dry-run';
    emit('done', 'dry run: connected nothing past discovery; no forge, route, unit or daemon was touched', { summary });
    return { code: PROVISION_EXIT.ok, summary };
  }

  const configPath = deps.configFile();
  if (!configPath) return fail(PROVISION_EXIT.failed, 'connect finished but no crew.yaml exists', { stage: 'connect' });
  summary.configPath = configPath;

  // 2. forge tokens, compared through the credential helper so a re-run with the same token changes nothing.
  for (const host of o.forgeHosts) {
    const token = o.tokens[host]!;
    const stored = deps.storedToken(host);
    if (stored === token) {
      summary.forges.push({ host, action: 'unchanged' });
      emit('forge', `forge ${host}: token already stored`, { host, action: 'unchanged' });
      continue;
    }
    const sub = stored === null ? 'set' : 'rotate';
    const res = deps.crew(['forge', sub, host, '--token-stdin'], { input: `${token}\n` });
    if (res.status !== 0) return fail(PROVISION_EXIT.failed, `forge ${host}: ${res.stderr.trim() || `crew forge ${sub} exited ${res.status}`}`, { stage: 'forge', host });
    const action = sub === 'set' ? 'stored' : 'rotated';
    summary.forges.push({ host, action });
    summary.changed = true;
    emit('forge', `forge ${host}: token ${action}`, { host, action });
  }

  // 3. enable the routes this host serves.
  for (const route of routeNames) {
    if (deps.enableRoute(route)) {
      summary.changed = true;
      emit('route_enabled', `enabled route ${route}`, { route });
    }
  }

  // 4. units and the daemon, only when something is off.
  const before = deps.installState();
  if (before.unitsStale || !before.running || !before.lingering) {
    const res = deps.crew(['install']);
    if (res.status !== 0) {
      return fail(PROVISION_EXIT.failed, `crew install exited ${res.status}: ${(res.stderr || res.stdout).trim().split('\n').pop() ?? ''}`, { stage: 'install' });
    }
    summary.changed = true;
    emit('install', `installed ${before.mechanism} units`, { mechanism: before.mechanism });
  }
  const after = deps.installState();
  summary.daemon = { mechanism: after.mechanism, running: after.running, lingering: after.lingering };
  if (!after.running) {
    return fail(PROVISION_EXIT.failed, `the ${after.mechanism} daemon unit is not running after install`, { stage: 'daemon' });
  }
  emit('daemon', `daemon running (${after.mechanism}${after.lingering ? ', survives logout' : ', will stop at logout: lingering is off'})`, { ...summary.daemon });

  summary.ok = true;
  summary.state = summary.changed ? 'provisioned' : 'already provisioned';
  emit('done', summary.state, { summary });
  return { code: PROVISION_EXIT.ok, summary };
}

/** `github.com` -> `GITHUB_COM`, the suffix of `CREW_FORGE_TOKEN_<HOST>`. */
export function envKey(host: string): string {
  return host.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** Forge tokens from the environment: a per-host variable wins over the shared `CREW_FORGE_TOKEN`. */
export function tokensFromEnv(hosts: string[], env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of hosts) {
    const t = env[`CREW_FORGE_TOKEN_${envKey(h)}`] ?? env.CREW_FORGE_TOKEN;
    if (t?.trim()) out[h] = t.trim();
  }
  return out;
}

/** Every occurrence of a repeatable `--name value` (or `--name=value`) in argv. */
export function repeated(argv: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === `--${name}`) { const v = argv[++i]; if (v !== undefined) out.push(v); }
    else if (a.startsWith(`--${name}=`)) out.push(a.slice(name.length + 3));
  }
  return out;
}

function splitList(v: string | undefined): string[] {
  return (v ?? '').split(/[\s,]+/).filter(Boolean);
}

/** Options from argv and the environment. Flags win over environment variables. */
export function provisionOptionsFrom(argv: readonly string[], env: NodeJS.ProcessEnv): ProvisionOptions {
  const one = (name: string) => repeated(argv, name).at(-1);
  const routes = repeated(argv, 'route');
  const forgeFlags = repeated(argv, 'forge-host');
  const tokenAvailable = !!env.CREW_FORGE_TOKEN?.trim() || Object.keys(env).some((k) => k.startsWith('CREW_FORGE_TOKEN_') && env[k]?.trim());
  const forgeHosts = (forgeFlags.length ? forgeFlags : tokenAvailable ? splitList(env.CREW_FORGE_HOSTS ?? 'github.com') : [])
    .map((h) => h.toLowerCase());
  return {
    key: one('key') ?? env.CREW_CONNECT_KEY,
    routes: routes.length ? routes : splitList(env.CREW_PROVISION_ROUTES),
    shipName: one('ship-name') ?? env.CREW_SHIP_NAME,
    agentBin: one('agent-bin'),
    extraPath: one('extra-path'),
    baseUrl: one('base-url'),
    forgeHosts,
    tokens: tokensFromEnv(forgeHosts, env),
    json: argv.includes('--json'),
    dryRun: argv.includes('--dry-run'),
    choices: repeated(argv, 'choose'),
  };
}

// --- the real machine ------------------------------------------------------

export function realProvisionDeps(crewHome: string): ProvisionDeps {
  const spawnCrew: ProvisionDeps['crew'] = (args, o = {}) => {
    const [bin, ...pre] = crewInvocation(crewHome);
    // The child must not mistake this process for an agent session, and a token left in the environment would be picked up by `forge set`.
    const env: NodeJS.ProcessEnv = { ...process.env, ...o.env };
    delete env.CREW_FORGE_TOKEN;
    const res = spawnSync(bin!, [...pre, ...args], { cwd: crewHome, encoding: 'utf8', env, input: o.input, maxBuffer: 64 * 1024 * 1024 });
    return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: `${res.stderr ?? ''}${res.error ? String(res.error) : ''}` };
  };
  const configFile = () => { const f = findConfigFile(crewHome); return existsSync(f) ? f : null; };
  return {
    crew: spawnCrew,
    configFile,
    enableRoute(route) {
      const file = configFile();
      if (!file) return false;
      const text = readFileSync(file, 'utf8');
      const doc = parseDocument(text);
      const routes = doc.get('routes');
      const entry = (routes as { items?: Array<{ get(k: string): unknown }> } | null)?.items?.find((r) => r.get('route') === route);
      if (!entry) throw new Error(`route ${route} is not in ${file}`);
      if (entry.get('enabled') === true) return false;
      writeFileSync(file, planEnable(text, route));
      return true;
    },
    installState() {
      const file = configFile();
      const cfg = loadConfig(crewHome, file ?? undefined, { allowNoRoutes: true });
      const host = hostPlatform();
      const ctx = installContext();
      const systemd = detectSystemd();
      const jobs: InstallJob[] = ['run', 'release', 'passengers'];
      let unitsStale = false;
      let mechanism = 'none';
      for (const job of jobs) {
        const plan = planInstall(cfg.ship, crewHome, host, systemd, job, ctx);
        mechanism = plan.mechanism;
        if (plan.mechanism === 'cron') { unitsStale = true; continue; }
        for (const p of plan.unitPaths) {
          if (!existsSync(p) || readFileSync(p, 'utf8') !== plan.unitContent[p]) unitsStale = true;
        }
      }
      const label = labelFor(crewHome, 'run');
      let running = false;
      let lingering = true;
      if (mechanism === 'systemd') {
        const system = ctx.root || existsSync(systemUnitPathFor(label));
        const ctl = system ? ['systemctl'] : ['systemctl', '--user'];
        running = spawnSync(ctl[0]!, [...ctl.slice(1), 'is-active', '--quiet', `${label}.service`]).status === 0;
        if (!system) {
          const out = spawnSync('loginctl', ['show-user', ctx.user, '-p', 'Linger'], { encoding: 'utf8' });
          lingering = /Linger=yes/.test(out.stdout ?? '');
        }
      } else if (mechanism === 'cron') {
        running = true; // timer-fired: there is no resident process to check
      } else if (mechanism === 'launchd') {
        running = spawnSync('launchctl', ['list', label]).status === 0;
      }
      return { mechanism, unitsStale, running, lingering };
    },
    storedToken(host) {
      const res = spawnCrew(['credential', 'get'], { input: `protocol=https\nhost=${host}\n\n` });
      const m = /^password=(.*)$/m.exec(res.stdout);
      return m ? m[1]! : null;
    },
    defaultShipName: () => hostname(),
  };
}

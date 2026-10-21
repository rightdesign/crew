/**
 * `crew connect`'s non-interactive mode (CREW-2235): wizard answers as flags,
 * `--json` progress events on stdout, and `--choose key=value` for the
 * decisions a terminal would have asked about.
 *
 * A GUI cannot drive readline. It runs `crew connect --json ...`, reads one
 * JSON object per line, and when a decision is needed crew emits a `choice`
 * event and exits `CHOICE_EXIT_CODE`; the GUI asks, then re-runs with
 * `--choose <key>=<value>`. Re-running is idempotent, so nothing is lost.
 *
 * Everything here is pure (the emitter takes its writer as an argument) so it
 * is unit-tested without a process or a TTY.
 */

import { accessSync, constants } from 'node:fs';
import { dirname } from 'node:path';
import { deriveExtraPath, findOnPath, type WizardAnswers, type WizardEnv } from './connect-wizard.ts';

/** Exit status of a run that stopped on a `choice` event. 2 stays "bad input / unresolved". */
export const CHOICE_EXIT_CODE = 3;

/** Every event type `--json` can emit, in the order a first run produces them. */
export const CONNECT_EVENTS = [
  'device_code', 'signed_in', 'workspace_resolved', 'project_options', 'template_missing', 'template_installed',
  'ship_row', 'operator_row', 'seat', 'mcp_registered', 'pair_installed', 'capabilities',
  'choice', 'problem', 'done',
] as const;
export type ConnectEventName = typeof CONNECT_EVENTS[number];

export interface ConnectEmitter {
  readonly json: boolean;
  /** One `{event, message, ...data}` line on stdout under `--json`; nothing otherwise. */
  emit(event: ConnectEventName, message: string, data?: Record<string, unknown>): void;
}

export function createEmitter(json: boolean, write: (line: string) => void): ConnectEmitter {
  return {
    json,
    emit(event, message, data = {}) {
      if (!json) return;
      // `event` and `message` are written last so a data key can never shadow them.
      write(`${JSON.stringify({ ...data, event, message })}\n`);
    },
  };
}

/** One answer a `choice` event offers. */
export interface ChoiceOption {
  value: string;
  label: string;
}

/**
 * Every `--choose key=value` in argv (repeatable; `--choose=key=value` also
 * accepted). Later occurrences of the same key win. The key is everything
 * before the first `=`, so a value may itself contain `=`.
 */
export function parseChoices(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const take = (kv: string | undefined) => {
    if (!kv) return;
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--choose') take(argv[++i]);
    else if (a.startsWith('--choose=')) take(a.slice('--choose='.length));
  }
  return out;
}

/** The data a `choice` event carries: the key to answer with, and the options. */
export function choiceData(key: string, options: ChoiceOption[]): Record<string, unknown> {
  return { key, options, answer: `--choose ${key}=<value>` };
}

export interface WizardFlags {
  shipName?: string;
  agentBin?: string;
  extraPath?: string;
  hostPassengers: boolean;
  noWizard: boolean;
}

/** True when a first-run connect should take its answers from flags rather than ask. */
export function usesFlagAnswers(f: WizardFlags, isTTY: boolean): boolean {
  if (f.noWizard) return true;
  if (isTTY) return false;
  // A non-terminal run with no answer flags at all keeps its old behavior (an
  // error about the missing config) rather than silently writing defaults.
  return !!(f.shipName || f.agentBin || f.extraPath || f.hostPassengers);
}

/**
 * The wizard's answers from flags, with the same defaults the wizard offers:
 * ship name = hostname, agent binary = the `claude` on PATH, `extraPath`
 * derived from where node/pnpm/docker live. Fails (never prompts) when no
 * executable agent binary can be settled.
 */
export function flagWizardAnswers(
  f: WizardFlags, env: WizardEnv,
): { answers: WizardAnswers } | { error: string } {
  const isExec = env.isExecutable ?? ((p: string) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } });
  const agentBin = f.agentBin ?? findOnPath('claude', env.pathEnv, isExec);
  if (!agentBin) return { error: 'no agent binary: "claude" is not on PATH — pass --agent-bin /absolute/path' };
  if (f.agentBin && !isExec(f.agentBin)) return { error: `--agent-bin ${f.agentBin} is not an executable file` };
  const pnpmPath = findOnPath('pnpm', env.pathEnv, isExec);
  const dockerPath = f.hostPassengers ? findOnPath('docker', env.pathEnv, isExec) : undefined;
  const extraPath = f.extraPath
    ?? deriveExtraPath([dirname(env.nodePath), pnpmPath ? dirname(pnpmPath) : undefined, dockerPath ? dirname(dockerPath) : undefined]);
  return {
    answers: {
      name: f.shipName?.trim() || env.hostname,
      platform: env.platform,
      agentBin,
      extraPath,
      hostPassengers: f.hostPassengers,
    },
  };
}

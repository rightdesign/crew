/**
 * Launchers: wrapper commands a toolchain runs its harness through (CREW-1522
 * Ori, CREW-1554 oMLX). Each launcher has its own argv shape, so the shape lives
 * in one table here instead of in every adapter.
 *
 * - `ori`:  `ori <harness> <harness args…>`
 * - `omlx`: `omlx launch <harness> --model <model> -- <harness args…>` (oMLX
 *   forwards everything after `--` to the tool unchanged; `--model` is required
 *   headlessly or it prompts).
 * - anything else keeps the Ori-style generic prefix, as before.
 *
 * Type-only imports from toolchain.ts: the adapters import this module, so a
 * value import back would be a cycle.
 */

import { basename, join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import type { ToolchainSpec } from './toolchain.ts';

type LauncherSpec = Pick<ToolchainSpec, 'launcher' | 'launcherBin'>;

export function isOriLauncher(spec: Pick<ToolchainSpec, 'launcher'>): boolean {
  return !!spec.launcher && basename(spec.launcher) === 'ori';
}

/** oMLX, a local MLX inference server that launches a harness against itself (CREW-1554). */
export function isOmlxLauncher(spec: Pick<ToolchainSpec, 'launcher'>): boolean {
  return !!spec.launcher && basename(spec.launcher) === 'omlx';
}

/** Where oMLX's CLI lives when a toolchain names `launcher: omlx` without a `launcherBin`. */
export function defaultOmlxBin(home: string = homedir()): string {
  return join(home, '.omlx', 'bin', 'omlx');
}

/** The binary to spawn for a launcher: `launcherBin`, else oMLX's default install path, else the launcher's own name. */
export function launcherExecutable(spec: LauncherSpec & Pick<ToolchainSpec, 'launcher'>, home?: string): string | undefined {
  if (!spec.launcher) return undefined;
  if (spec.launcherBin) return spec.launcherBin;
  return isOmlxLauncher(spec) ? defaultOmlxBin(home) : spec.launcher;
}

/**
 * Wraps a harness invocation in the toolchain's launcher; without one the
 * harness binary is spawned directly. `harnessBin` is what the launcher is told
 * to run (Ori takes the toolchain's `bin`; oMLX takes the harness name, which
 * is the tool name its `launch` subcommand knows).
 */
export function wrapInvocation(
  spec: ToolchainSpec,
  o: { model: string; args: string[] },
): { bin: string; args: string[] } {
  const exe = launcherExecutable(spec);
  if (!exe) return { bin: spec.bin, args: o.args };
  if (isOmlxLauncher(spec)) return { bin: exe, args: ['launch', spec.harness, '--model', o.model, '--', ...o.args] };
  return { bin: exe, args: [spec.bin, ...o.args] };
}

/** `-c model_provider="x"` style override in a toolchain's args that points the harness at a non-default provider. */
export function selectsCustomModelProvider(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const v = a === '-c' || a === '--config' ? args[i + 1] : a.startsWith('--config=') ? a.slice('--config='.length) : undefined;
    const m = v && /^model_provider\s*=\s*"?([^"\s]+)"?$/.exec(v.trim());
    if (m && m[1] !== 'openai') return true;
  }
  return false;
}

export interface OmlxSettings {
  host: string;
  port: number;
  modelDirs: string[];
}

/**
 * The server address and model directories from oMLX's `settings.json`. Only
 * `server` and `model` are read — nothing under `auth` (the API key lives there
 * and crew never needs it).
 */
export function parseOmlxSettings(text: string): OmlxSettings | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const { server, model } = raw as { server?: { host?: unknown; port?: unknown }; model?: { model_dirs?: unknown } };
  const port = Number(server?.port);
  if (!Number.isInteger(port) || port <= 0) return undefined;
  const host = typeof server?.host === 'string' && server.host ? server.host : '127.0.0.1';
  const dirs = Array.isArray(model?.model_dirs) ? model.model_dirs.filter((d): d is string => typeof d === 'string') : [];
  return { host: host === '0.0.0.0' ? '127.0.0.1' : host, port, modelDirs: dirs };
}

/** `GET /v1/models` with no key: 401 means the server is up and wants a key; that is the expected answer. */
export function interpretOmlxProbe(status: number | undefined): { up: boolean; detail: string } {
  if (status === undefined) return { up: false, detail: 'not reachable' };
  if (status === 401) return { up: true, detail: 'up (key required)' };
  if (status >= 200 && status < 300) return { up: true, detail: 'up (no key required)' };
  return { up: false, detail: `answered HTTP ${status}` };
}

/** Whether `model` is a directory name directly under one of oMLX's model dirs. */
export function omlxModelPresent(model: string, dirs: string[]): boolean {
  return dirs.some((d) => {
    try {
      return readdirSync(d).includes(model);
    } catch {
      return false;
    }
  });
}

export function readOmlxSettings(home: string = homedir()): OmlxSettings | undefined {
  const p = join(home, '.omlx', 'settings.json');
  return existsSync(p) ? parseOmlxSettings(readFileSync(p, 'utf8')) : undefined;
}

/**
 * `crew repos check [PATH]` (CREW-2590): validate a checkout's `.crew.yaml`
 * before the repo is attached to any route, the complement of
 * `crew repos hooks --write repo`.
 *
 * Everything the file is later judged by already exists (`parseRepoConfig`,
 * `resolveRepoConfig`, `validateEffective`) but only ran inside `doctor`,
 * `status --json` and the release phase, all of which need an attached repo
 * and a reachable tracker. This runs the same functions on a bare directory,
 * so it needs neither. Nothing is executed: hooks are syntax-checked only.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  RepoConfigError, effectiveBranchTemplate, effectiveWorktreeDirName, findRepoConfig, hookLabel,
  parseRepoConfig, renderBranchName, renderWorktreeName, resolveRepoConfig, validateEffective,
  type BranchContext, type EffectiveRepoConfig, type RepoConfig, type RepoHooks, type ShipRepoSettings,
} from './repo-config.ts';
import { resolveShell } from './shell.ts';

export type SyntaxResult = { status: 'ok' | 'error' | 'unchecked'; message?: string };

export interface HookCheck { name: string; label: string; syntax: SyntaxResult }

export interface RenderedSample {
  /** `with a project tag` / `without a project tag`. */
  case: string;
  branch: string;
  worktree: string;
}

export interface RepoCheckReport {
  file: string | null;
  /** The file as parsed, before any ship settings; null when it did not load. */
  parsed: RepoConfig | null;
  effective: EffectiveRepoConfig | null;
  readiness: string[];
  hooks: HookCheck[];
  shadowed: string[];
  samples: RenderedSample[];
  /** Why the file did not load: no file, or the loader's own wording. */
  error: string | null;
  /** Process exit status: 1 on an error or a failed hook, and on any readiness finding with `strict`. */
  exitCode: 0 | 1;
}

/** Interpreters that read a script on stdin and take `-n` to parse without running it. */
const POSIX_SHELL = /^(?:ba|z|da|k|a|mk)?sh$|^fish$/;

/**
 * Parse `script` with `shellSpec` without executing it. `bash -n` family for
 * POSIX shells, the PowerShell parser for pwsh/powershell, and an honest
 * "unchecked" for anything else (cmd has no parse-only mode). A missing
 * interpreter is also unchecked, not a failure: the file is fine, this machine
 * just cannot say.
 */
export function checkHookSyntax(script: string, shell: string | undefined): SyntaxResult {
  const spec = resolveShell(shell);
  const name = basename(spec.bin).replace(/\.exe$/i, '').toLowerCase();
  let run;
  if (POSIX_SHELL.test(name)) {
    run = spawnSync(spec.bin, ['-n'], { input: script, encoding: 'utf8' });
  } else if (/^(pwsh|powershell)$/.test(name)) {
    const parse =
      '$e=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($env:CREW_CHECK_SCRIPT,[ref]$null,[ref]$e);' +
      'if($e){$e|ForEach-Object{[Console]::Error.WriteLine($_.Message)};exit 1}';
    run = spawnSync(spec.bin, ['-NoProfile', '-NonInteractive', '-Command', parse], {
      encoding: 'utf8', env: { ...process.env, CREW_CHECK_SCRIPT: script },
    });
  } else {
    return { status: 'unchecked', message: `no syntax check for ${spec.bin}` };
  }
  if (run.error) return { status: 'unchecked', message: `cannot run ${spec.bin}: ${run.error.message}` };
  if (run.status === 0) return { status: 'ok' };
  const message = `${run.stderr ?? ''}${run.stdout ?? ''}`.trim() ||`${spec.bin} exited ${run.status}`;
  return { status: 'error', message };
}

/** The branch and worktree names a ticket produces, once with a project tag and once without. */
export function renderSamples(cfg: EffectiveRepoConfig, dir: string): RenderedSample[] {
  const checkout = basename(dir.replace(/[/\\]+$/, ''));
  const tagged: BranchContext = { key: 'ISSUE-123', title: 'Fix the widget', role: 'dev', tag: 'TABL-123', prefix: 'tabl', lowercase: cfg.branch.lowercase };
  const untagged: BranchContext = { key: 'ISSUE-123', title: 'Fix the widget', role: 'dev', lowercase: cfg.branch.lowercase };
  return ([['with a project tag', tagged], ['without a project tag', untagged]] as const).map(([label, ctx]) => {
    const branch = renderBranchName(effectiveBranchTemplate(cfg, ctx.prefix), ctx);
    const worktree = effectiveWorktreeDirName(cfg, dir, branch, '123', (t) => renderWorktreeName(t, { ...ctx, dir: checkout }));
    return { case: label, branch, worktree };
  });
}

export interface RepoCheckOptions {
  /** Ship settings of the route being checked against; absent for a bare checkout. */
  ship?: ShipRepoSettings;
  strict?: boolean;
}

export function checkRepoSpec(dir: string, opts: RepoCheckOptions = {}): RepoCheckReport {
  const empty = { parsed: null, effective: null, readiness: [], hooks: [], shadowed: [], samples: [] };
  const file = findRepoConfig(dir);
  if (!file) {
    return { ...empty, file: null, error: `no .crew.yaml, .crew.yml or .crew.json in ${dir}`, exitCode: 1 };
  }
  let parsed: RepoConfig;
  try {
    parsed = parseRepoConfig(readFileSync(file, 'utf8'), file);
  } catch (e) {
    if (!(e instanceof RepoConfigError)) throw e;
    return { ...empty, file, error: e.message, exitCode: 1 };
  }
  const effective = resolveRepoConfig(parsed, opts.ship, dir);
  const readiness = validateEffective(effective);
  const hooks = (Object.keys(effective.hooks) as Array<keyof RepoHooks>).map((name) => ({
    name,
    label: hookLabel(effective, name),
    syntax: checkHookSyntax(effective.hooks[name] as string, effective.shell),
  }));
  const failed = hooks.some((h) => h.syntax.status === 'error');
  return {
    file, parsed, effective, readiness, hooks, shadowed: effective.shadowed, samples: renderSamples(effective, dir),
    error: null, exitCode: failed || (opts.strict && readiness.length > 0) ? 1 : 0,
  };
}

/** The human rendering. Findings use `crew doctor`'s wording (`release readiness: ...`). */
export function renderRepoCheck(r: RepoCheckReport): string {
  if (r.error) return `${r.file ?? 'crew repos check'}: ${r.error}\n`;
  const e = r.effective!;
  const lines = [
    `${r.file}`,
    `  platform           ${e.platform}`,
    `  release.mode       ${e.release.mode}`,
    `  release.versioning ${e.release.versioning}`,
    `  branch.base        ${e.branch.base}`,
    `  branch.name        ${e.branch.name}`,
    `  branch.push        ${e.branch.push}`,
  ];
  for (const s of r.samples) lines.push(`  ${s.case}: branch ${s.branch}, worktree ../${s.worktree}`);
  lines.push(r.hooks.length ? '  hooks' : '  hooks              none');
  for (const h of r.hooks) {
    const named = h.label !== e.hooks[h.name as keyof RepoHooks] ? ` (${h.label})` : '';
    const syntax = h.syntax.status === 'ok' ? 'syntax ok' : h.syntax.status === 'unchecked' ? `syntax not checked: ${h.syntax.message}` : 'syntax ERROR';
    lines.push(`    ${h.name}${named}: ${syntax}`);
    if (h.syntax.status === 'error') lines.push(...(h.syntax.message ?? '').split('\n').map((l) => `      ${l}`));
  }
  if (r.shadowed.length) lines.push(`  this ship declares ${r.shadowed.join(', ')}, and the file overrides it — the file wins`);
  for (const p of r.readiness) lines.push(`  - release readiness: ${p}`);
  return `${lines.join('\n')}\n`;
}

/**
 * `crew selftest` (CREW-2236): prove an agent run will work on this machine
 * before the first real ticket needs one.
 *
 * `crew doctor` checks that binaries exist on the scheduler PATH and `crew run
 * --dry-run` launches nothing, so the classic first-run failures (vendor login
 * missing, MCP tool not registered, keychain locked, seat key refused) only
 * ever surfaced inside a real launch. This launches each configured toolchain
 * through its adapter exactly as a run would — scheduler PATH, scrubbed
 * environment, the dev seat's key as `CREW_API_KEY` — in a fresh temp
 * directory, with a fixed read-only prompt asking the agent to read the
 * workspace's name through the tracker MCP tool. It never writes to the
 * tracker and leaves no worktree or temp directory behind.
 *
 * Process spawning and the tracker lookup are injected (`SelftestDeps`) so the
 * failure classification is tested against a faked adapter stream.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubbedEnv } from './agent.ts';
import type { Ship } from './config.ts';
import { pathFor } from './install.ts';
import { describeClaudeAuth } from './adapters/claude.ts';
import { adapterFor, type ToolchainSpec } from './toolchain.ts';

export const SELFTEST_TIMEOUT_MS = 120_000;

/** The env var the tracker key travels in; the same one a real run uses. */
const KEY_VAR = 'CREW_API_KEY';

export const SELFTEST_PROMPT =
  'This is a read-only connectivity check. Use the tracker MCP tool to read this workspace (the workspaces find-one tool, ' +
  'using the workspace id below) and reply with the workspace\'s name alone, on one line. Do not write anything, do not ' +
  'create files, and do not use any other tool.\n\nWorkspace id: ';

export type SelftestFailure =
  | 'binary-not-found'
  | 'login-missing'
  | 'mcp-unavailable'
  | 'key-refused'
  | 'keychain-locked'
  | 'timeout'
  | 'wrong-answer';

export interface SelftestResult {
  toolchain: string;
  harness: string;
  model: string;
  ok: boolean;
  /** The workspace name the agent read back (a pass). */
  workspace?: string;
  /** Present on a failure. */
  failure?: SelftestFailure;
  /** One line: what happened and what to do about it. */
  detail: string;
  tokens?: number;
  costUsd?: number;
  ms: number;
  ranAt: string;
}

export interface SpawnedRun {
  /** Process exit code; null when it was killed by the timeout. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the binary could not be started at all. */
  spawnError?: NodeJS.ErrnoException;
}

export interface SelftestDeps {
  run(o: { bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number }): Promise<SpawnedRun>;
}

export interface SelftestInput {
  ship: Ship;
  toolchain: ToolchainSpec;
  baseUrl: string;
  workspaceId: string;
  /** The dev seat's key; undefined when none could be read. */
  apiKey?: string;
  /** Why no seat key could be read, when `apiKey` is absent or is the ship fallback. */
  keyProblem?: string;
  /** What the tracker calls this workspace. */
  workspaceName: string;
  timeoutMs?: number;
  now?: () => number;
}

export const realDeps: SelftestDeps = {
  run: (o) => new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const done = (r: SpawnedRun) => { if (!settled) { settled = true; resolve(r); } };
    const child = spawn(o.bin, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const killGroup = () => {
      try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, o.timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); done({ code: null, stdout, stderr, timedOut: false, spawnError: e }); });
    child.on('close', (code) => { clearTimeout(timer); done({ code: timedOut ? null : code, stdout, stderr, timedOut }); });
    child.stdin?.on('error', () => { /* the harness exiting early is classified from its exit, not from the pipe */ });
    child.stdin?.end(o.stdin);
  }),
};

interface Seen {
  texts: string[];
  /** Tool names the agent called. */
  tools: string[];
  /** Raw tool-result / error text, for the 401/403 check. */
  toolOutput: string;
  mcpFailed: boolean;
  tokens?: number;
  costUsd?: number;
  /** A `result` string on the harness's final line, where it has one. */
  finalText?: string;
}

function parseLines(stdout: string): unknown[] {
  const out: unknown[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { out.push(JSON.parse(t)); } catch { /* a partial or non-JSON line is not evidence of anything */ }
  }
  return out;
}

function collectToolOutput(parsed: unknown): string {
  const msg = (parsed as { message?: { content?: unknown } } | null)?.message;
  if (!msg || !Array.isArray(msg.content)) return '';
  let s = '';
  for (const b of msg.content as Array<{ type?: string; content?: unknown; is_error?: boolean }>) {
    if (b?.type !== 'tool_result') continue;
    s += typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
    s += '\n';
  }
  return s;
}

export function observe(spec: ToolchainSpec, stdout: string): Seen {
  const adapter = adapterFor(spec.harness);
  const mapper = adapter.createStreamMapper?.();
  const seen: Seen = { texts: [], tools: [], toolOutput: '', mcpFailed: false };
  const take = (events: ReturnType<typeof adapter.mapStreamLine>) => {
    for (const e of events) {
      if (e.kind === 'text' && e.text) seen.texts.push(e.text);
      else if (e.kind === 'tool' && e.tool) seen.tools.push(e.tool);
    }
  };
  for (const parsed of parseLines(stdout)) {
    take(mapper ? mapper.map(parsed) : adapter.mapStreamLine(parsed));
    seen.toolOutput += collectToolOutput(parsed);
    const p = parsed as { type?: string; subtype?: string; mcp_servers?: Array<{ status?: string }>; result?: unknown };
    if (p.type === 'system' && p.subtype === 'init' && Array.isArray(p.mcp_servers)) {
      if (p.mcp_servers.some((m) => m.status && m.status !== 'connected')) seen.mcpFailed = true;
    }
    if (typeof p.result === 'string') seen.finalText = p.result;
    const r = adapter.extractResult(parsed);
    if (r) {
      if (r.costUsd !== undefined) seen.costUsd = r.costUsd;
      const total = (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0);
      if (r.inputTokens !== undefined || r.outputTokens !== undefined) seen.tokens = total;
    }
  }
  if (mapper) take(mapper.flush());
  return seen;
}

const REFUSED = /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid (api )?key|key (was )?(refused|revoked)/i;
const LOGIN = /not logged in|please run \/?login|\/login|log in|authentication|oauth|credential|api key|sign in/i;
const MCP_GONE = /mcp[^\n]{0,60}(not (available|found|connected)|failed|unavailable)|no such tool|tool[^\n]{0,40}not (available|found)|unknown tool/i;

/** The remedy line for each class; the app maps the same class to its own button. */
export const REMEDY: Record<SelftestFailure, string> = {
  'binary-not-found': 'add the directory holding it to ship.extraPath in crew.yaml, then run `crew doctor`',
  'login-missing': 'log in to the vendor CLI in a terminal on this machine, then re-run `crew selftest`',
  'mcp-unavailable': 'register the tracker MCP server (`crew doctor` shows how), then re-run `crew selftest`',
  'key-refused': 'the dev seat\'s key was refused — ask a workspace admin to mint a fresh one (`crew agents sync`)',
  'keychain-locked': 'unlock the OS keychain from a logged-in session (`security unlock-keychain`), then re-run',
  timeout: 'the harness did not answer in time — run it by hand to see where it stalls',
  'wrong-answer': 'the agent answered but did not name the workspace — run it by hand to see what it said',
};

/**
 * Names the first reason a run did not pass. Order matters: a refused key and
 * a dead MCP both end in "no answer", and the login guess is the fallback for
 * a harness that simply exited without saying anything.
 */
export function classify(spec: ToolchainSpec, run: SpawnedRun, seen: Seen): { failure: SelftestFailure; detail: string } {
  const bin = spec.launcher ?? spec.bin;
  const fail = (failure: SelftestFailure, what: string) => ({ failure, detail: `${what} — ${REMEDY[failure]}` });
  if (run.spawnError) {
    if (run.spawnError.code === 'ENOENT') return fail('binary-not-found', `\`${bin}\` is not on the scheduler PATH`);
    return fail('binary-not-found', `could not start \`${bin}\` (${run.spawnError.message})`);
  }
  if (run.timedOut) return fail('timeout', 'no answer within the time limit');
  const text = `${seen.toolOutput}\n${run.stderr}`;
  if (REFUSED.test(seen.toolOutput) || (seen.tools.some((t) => t.startsWith('mcp__')) && REFUSED.test(run.stderr))) {
    return fail('key-refused', 'the tracker returned 401/403 to the MCP call');
  }
  if (seen.mcpFailed || (!seen.tools.some((t) => t.startsWith('mcp__')) && MCP_GONE.test(`${text}\n${seen.texts.join('\n')}`))) {
    return fail('mcp-unavailable', 'the tracker MCP tool was not available to the session');
  }
  const answered = seen.texts.length > 0 || seen.finalText;
  if (!answered || LOGIN.test(run.stderr) || LOGIN.test(seen.finalText ?? '')) {
    return fail('login-missing', `\`${bin}\` exited${run.code !== null ? ` (${run.code})` : ''} before answering; the vendor login is probably missing`);
  }
  return fail('wrong-answer', `the agent replied "${(seen.finalText ?? seen.texts.at(-1) ?? '').trim().slice(0, 80)}"`);
}

/** Runs one toolchain's self-test; never throws and never touches the tracker. */
export async function runSelftest(i: SelftestInput, deps: SelftestDeps = realDeps): Promise<SelftestResult> {
  const now = i.now ?? (() => Date.now());
  const started = now();
  const spec = i.toolchain;
  const base = { toolchain: spec.name, harness: spec.harness, model: spec.model };
  const finish = (r: Omit<SelftestResult, 'toolchain' | 'harness' | 'model' | 'ms' | 'ranAt'>): SelftestResult =>
    ({ ...base, ...r, ms: now() - started, ranAt: new Date(started).toISOString() });
  const failed = (failure: SelftestFailure, what: string) => finish({ ok: false, failure, detail: `${what} — ${REMEDY[failure]}` });

  if (!i.apiKey) return failed('keychain-locked', i.keyProblem ?? 'no seat key could be read');

  const adapter = adapterFor(spec.harness);
  const invocation = adapter.invocation(spec, { role: 'dev', model: spec.model, mcp: { url: `${i.baseUrl.replace(/\/+$/, '')}/api/mcp`, keyVar: KEY_VAR } });
  const env: NodeJS.ProcessEnv = {
    ...scrubbedEnv(process.env, spec.harness),
    PATH: pathFor(i.ship),
    ...adapter.runEnv(spec),
    [KEY_VAR]: i.apiKey,
  };

  const cwd = mkdtempSync(join(tmpdir(), 'crew-selftest-'));
  try {
    const run = await deps.run({
      bin: invocation.bin, args: invocation.args, cwd, env,
      stdin: `${SELFTEST_PROMPT}${i.workspaceId}\n`, timeoutMs: i.timeoutMs ?? SELFTEST_TIMEOUT_MS,
    });
    const seen = observe(spec, run.stdout);
    const answer = [seen.finalText ?? '', ...seen.texts].join('\n');
    const usage = { ...(seen.tokens !== undefined ? { tokens: seen.tokens } : {}), ...(seen.costUsd !== undefined ? { costUsd: seen.costUsd } : {}) };
    if (!run.spawnError && !run.timedOut && answer.toLowerCase().includes(i.workspaceName.toLowerCase())) {
      const auth = spec.harness === 'claude' ? ` on ${describeClaudeAuth(spec)}` : '';
      return finish({ ok: true, workspace: i.workspaceName, detail: `read workspace "${i.workspaceName}"${auth}`, ...usage });
    }
    const { failure, detail } = classify(spec, run, seen);
    return finish({ ok: false, failure, detail, ...usage });
  } finally {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* a tmp dir we cannot remove is the OS's to sweep */ }
  }
}

/** One human line per result. */
export function formatResult(r: SelftestResult): string {
  const cost = r.costUsd !== undefined ? ` $${r.costUsd.toFixed(4)}` : '';
  const tok = r.tokens !== undefined ? ` ${r.tokens} tokens${cost}` : '';
  const secs = `${(r.ms / 1000).toFixed(1)}s`;
  return r.ok
    ? `${r.toolchain}: PASS ${r.detail} (${secs}${tok})`
    : `${r.toolchain}: FAIL ${r.failure} — ${r.detail} (${secs})`;
}

const fileFor = (stateDir: string) => join(stateDir, 'selftest.json');

export function readSelftest(stateDir: string): Record<string, SelftestResult> {
  try {
    const p = fileFor(stateDir);
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, SelftestResult>) : {};
  } catch {
    return {};
  }
}

export function recordSelftest(stateDir: string, results: SelftestResult[]): void {
  const all = readSelftest(stateDir);
  for (const r of results) all[r.toolchain] = r;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(fileFor(stateDir), `${JSON.stringify(all, null, 2)}\n`);
}

/** The lines `crew doctor` prints for the last stored result; it never re-runs one. */
export function doctorSelftestLines(stored: Record<string, SelftestResult>, toolchains: string[]): string[] {
  return toolchains.map((name) => {
    const r = stored[name];
    if (!r) return `selftest:          ${name}: not run — run \`crew selftest\``;
    return `selftest:          ${name}: ${r.ok ? 'passed' : `FAILED (${r.failure})`} at ${r.ranAt}`;
  });
}

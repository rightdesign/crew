/**
 * `crew repos hooks --suggest --agent` (CREW-2317): ask the configured
 * toolchain to read a checkout's README, agent instructions and CI workflows
 * and propose the same hooks the file sniff does, for a person to compare.
 *
 * Read-only by construction and by check: the session gets only Read/Grep/Glob
 * (everything that writes or runs is disallowed), no tracker key and no MCP,
 * and the checkout's `git status` is compared before and after, so a harness
 * that ignored its tool list still cannot change a file unnoticed. Failure is
 * a machine-readable `reason` (`AgentFailure`) and never touches the sniff
 * result the caller already holds. Only the Claude harness has a read-only
 * headless invocation here; any other reports `unsupported_harness`.
 */

import { spawn, execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { adapterFor, type ToolchainSpec } from './toolchain.ts';
import { wrapInvocation } from './launcher.ts';
import type { HookSuggestion, SuggestedHooks } from './repos-hooks.ts';

export type AgentFailure =
  | 'not_installed' | 'not_signed_in' | 'unsupported_harness'
  | 'cancelled' | 'timeout' | 'bad_output' | 'modified_checkout' | 'failed';

export class AgentSuggestError extends Error {
  readonly reason: AgentFailure;
  constructor(reason: AgentFailure, message: string) { super(message); this.reason = reason; }
}

export interface AgentSuggestion {
  source: 'agent';
  hooks: SuggestedHooks;
  /** Checkout files the session opened (from its Read tool calls). */
  filesRead: string[];
  /** Hook names whose agent value differs from the sniff's (or the sniff has none). */
  differsFromSniff: string[];
  notes: string[];
  /** The toolchain and model that answered: evidence for "toolchain responded in this checkout". */
  toolchain: string;
  model: string;
}

const HOOK_KEYS = ['test', 'build', 'version', 'bump', 'released'] as const;
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const WRITING_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent'];
const DEFAULT_TIMEOUT_MS = 180_000;

export function buildAgentPrompt(sniff: HookSuggestion): string {
  return [
    'You are reviewing a git checkout (the current directory) to work out how to test and build it.',
    'Read README*, CLAUDE.md, AGENTS.md, GEMINI.md, package/build manifests and .github/workflows/* as needed.',
    'You may only read files. Do not modify anything and do not run commands.',
    '',
    `A file sniff already proposed: ${JSON.stringify(sniff.hooks)}.`,
    'Propose the commands a contributor should run, using the repo\'s own documented ones over guesses.',
    'Omit any hook you cannot support from a file you read.',
    '',
    'Answer with ONLY one JSON object, no prose and no code fence:',
    '{"hooks": {"test": "...", "build": "...", "version": "...", "bump": "...", "released": "..."}, "notes": ["..."]}',
    '`version` prints the bare version, `bump` bumps by $CREW_BUMP (patch|minor|major) and prints the new version,',
    '`released` prints what is live (a version or sha). Keys you cannot support are left out.',
  ].join('\n');
}

export function agentInvocation(spec: ToolchainSpec, model: string): { bin: string; args: string[] } {
  if (spec.harness !== 'claude') {
    throw new AgentSuggestError('unsupported_harness', `--agent supports the claude harness only (toolchain "${spec.name}" is ${spec.harness})`);
  }
  return wrapInvocation(spec, {
    model,
    args: [
      '-p', '--allowedTools', ...READ_ONLY_TOOLS,
      '--disallowedTools', ...WRITING_TOOLS,
      '--model', model, '--output-format', 'stream-json', '--verbose',
      ...spec.args,
    ],
  });
}

export interface ParsedStream { text: string; isError: boolean; filesRead: string[] }

/** Pull the final answer and the Read calls out of a Claude `stream-json` transcript. */
export function parseAgentStream(out: string, dir: string): ParsedStream {
  let text = '';
  let isError = false;
  const files = new Set<string>();
  // The toolchain reports real paths; a checkout reached through a symlink (macOS /tmp) must be compared by its real path too.
  let base = dir;
  try { base = realpathSync(dir); } catch { /* keep dir */ }
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        const p = b?.type === 'tool_use' && b.name === 'Read' ? b.input?.file_path : undefined;
        if (typeof p === 'string') files.add(isAbsolute(p) ? relative(base, p) : p);
      }
    } else if (ev?.type === 'result') {
      text = typeof ev.result === 'string' ? ev.result : '';
      isError = ev.is_error === true;
    }
  }
  return { text, isError, filesRead: [...files].sort() };
}

/** The first JSON object in `text` (tolerates a code fence or a lead-in sentence). */
export function parseAgentHooks(text: string): { hooks: SuggestedHooks; notes: string[] } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AgentSuggestError('bad_output', 'the toolchain did not answer with a JSON object');
  let obj: any;
  try { obj = JSON.parse(text.slice(start, end + 1)); } catch { throw new AgentSuggestError('bad_output', 'the toolchain\'s answer was not valid JSON'); }
  const raw = obj && typeof obj === 'object' && obj.hooks && typeof obj.hooks === 'object' ? obj.hooks : {};
  const hooks: SuggestedHooks = {};
  for (const k of HOOK_KEYS) if (typeof raw[k] === 'string' && raw[k].trim()) hooks[k] = raw[k].trim();
  const notes = Array.isArray(obj.notes) ? obj.notes.filter((n: unknown): n is string => typeof n === 'string') : [];
  return { hooks, notes };
}

const SIGNED_OUT = /not logged in|\/login|invalid api key|authentication|unauthori[sz]ed|\b401\b|credit balance/i;

/** Why a run that produced no usable answer failed. */
export function classifyFailure(o: { code: number | null; spawnError?: NodeJS.ErrnoException; output: string }): AgentFailure {
  if (o.spawnError?.code === 'ENOENT') return 'not_installed';
  return SIGNED_OUT.test(o.output) ? 'not_signed_in' : 'failed';
}

function porcelain(dir: string): string | undefined {
  try { return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' }); } catch { return undefined; }
}

export interface RunAgentOpts {
  spec: ToolchainSpec;
  model?: string;
  dir: string;
  sniff: HookSuggestion;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function runAgentSuggest(o: RunAgentOpts): Promise<AgentSuggestion> {
  const model = o.model ?? o.spec.model;
  const { bin, args } = agentInvocation(o.spec, model);
  const adapter = adapterFor(o.spec.harness);
  const env: NodeJS.ProcessEnv = { ...process.env, ...adapter.runEnv(o.spec) };
  for (const v of adapter.unsetEnv) delete env[v];
  delete env.CREW_API_KEY;
  const before = porcelain(o.dir);

  const timeout = AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  const run = await new Promise<{ code: number | null; out: string; err: string; spawnError?: NodeJS.ErrnoException; aborted: boolean }>((resolve) => {
    let out = ''; let err = '';
    // Own process group, so an abort reaches whatever the toolchain itself spawned and
    // not just the direct child; a grandchild left holding the pipes would keep this
    // process alive after Ctrl-C.
    const child = spawn(bin, args, { cwd: o.dir, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    const settle = (r: { code: number | null; out: string; err: string; spawnError?: NodeJS.ErrnoException; aborted: boolean }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const onAbort = () => {
      try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      child.stdout.destroy(); child.stderr.destroy();
      settle({ code: null, out, err, aborted: true });
    };
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e: NodeJS.ErrnoException) => settle({ code: null, out, err, spawnError: e, aborted: false }));
    child.on('close', (code) => settle({ code, out, err, aborted: false }));
    child.stdin.on('error', () => {});
    child.stdin.end(buildAgentPrompt(o.sniff));
  });

  if (run.aborted || signal.aborted) {
    throw new AgentSuggestError(o.signal?.aborted ? 'cancelled' : 'timeout', o.signal?.aborted ? 'cancelled' : 'the toolchain did not answer in time');
  }
  const after = porcelain(o.dir);
  if (before !== undefined && after !== before) {
    throw new AgentSuggestError('modified_checkout', 'the checkout changed during --agent; inspect it with `git status` (the agent result was discarded)');
  }
  const parsed = parseAgentStream(run.out, o.dir);
  if (run.spawnError || run.code !== 0 || parsed.isError) {
    const reason = classifyFailure({ code: run.code, ...(run.spawnError ? { spawnError: run.spawnError } : {}), output: `${parsed.text}\n${run.err}` });
    throw new AgentSuggestError(reason, reason === 'not_installed' ? `${bin} is not installed` : reason === 'not_signed_in' ? `${o.spec.name} is not signed in` : (parsed.text || run.err).trim().slice(0, 300) || `exited ${run.code}`);
  }
  const { hooks, notes } = parseAgentHooks(parsed.text);
  const differsFromSniff = HOOK_KEYS.filter((k) => hooks[k] !== undefined && hooks[k] !== o.sniff.hooks[k]);
  return { source: 'agent', hooks, filesRead: parsed.filesRead, differsFromSniff, notes, toolchain: o.spec.name, model };
}

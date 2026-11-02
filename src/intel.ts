/**
 * The symbol service a repository's `intel` hook starts (EPIC-078, CREW-2872).
 *
 * Two plain functions, so the periscope path and the lane-run registration
 * (CREW-2912) share them without change:
 *  - `probeIntel` runs the hook in a worktree, takes the last stdout line as the
 *    service's URL and asks it to initialize over MCP until it answers or the
 *    startup budget runs out. It never throws: a failure is a one-line reason.
 *  - `codeToolsParagraph` is the brief's "Code tools" text for each outcome.
 */
import type { HookResult } from './periscope-cmd.ts';

/** What a service must offer for the brief to promise it. */
export const INTEL_MINIMUM_TOOLS = [
  'find symbols by name',
  'references to a symbol',
  'a symbol\'s definition',
  'a file\'s symbol outline',
] as const;

/** The name the service is registered under beside the tracker. */
export const INTEL_SERVER_NAME = 'code';

export type IntelOutcome =
  | { state: 'ready'; url: string; tools: string[] }
  | { state: 'absent' }
  | { state: 'failed'; reason: string };

export interface IntelProbeDeps {
  /** Runs the repository's `intel` hook in the worktree; null when it declares none. */
  runHook(env: Record<string, string>): Promise<HookResult | null>;
  /** `fetch`, injectable for tests. */
  fetch?: typeof fetch;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

const lastUrl = (output: string): string | undefined => {
  const last = output.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  return last && /^https?:\/\/\S+$/i.test(last) ? last : undefined;
};

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 200);

/** A JSON-RPC reply from a Streamable HTTP endpoint: plain JSON, or the first `data:` event of an SSE stream. */
async function rpcResult(res: Response): Promise<unknown> {
  const text = await res.text();
  const body = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim() ?? ''
    : text;
  const msg = JSON.parse(body) as { result?: unknown; error?: { message?: string } };
  if (msg.error) throw new Error(msg.error.message ?? 'MCP error');
  return msg.result;
}

/** `signal` bounds the whole attempt, body reads included, so a service that accepts and never replies cannot outlive the startup budget. */
async function initializeAndList(url: string, f: typeof fetch, signal: AbortSignal): Promise<string[]> {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const init = await f(url, {
    method: 'POST', headers, signal,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'crew', version: '0' } },
    }),
  });
  if (!init.ok) throw new Error(`initialize answered ${init.status}`);
  await rpcResult(init);
  const session = init.headers.get('mcp-session-id');
  const sessionHeaders = session ? { ...headers, 'mcp-session-id': session } : headers;
  await f(url, { method: 'POST', headers: sessionHeaders, signal, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
    .then((r) => r.body?.cancel()).catch(() => {});
  const list = await f(url, { method: 'POST', headers: sessionHeaders, signal, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
  if (!list.ok) throw new Error(`tools/list answered ${list.status}`);
  const result = (await rpcResult(list)) as { tools?: Array<{ name?: unknown }> } | undefined;
  return (result?.tools ?? []).map((t) => String(t.name)).filter(Boolean);
}

/**
 * Starts the service and waits for it. `env` is what the hook should see
 * (`ports` output, `CREW_TICKET`, `CREW_BRANCH`). A repository with no hook is
 * `absent`; every other problem is `failed` with a one-line reason.
 */
export async function probeIntel(deps: IntelProbeDeps, env: Record<string, string>, startupSeconds: number): Promise<IntelOutcome> {
  let ran: HookResult | null;
  try {
    ran = await deps.runHook(env);
  } catch (e) {
    return { state: 'failed', reason: `the intel hook could not run: ${oneLine((e as Error).message)}` };
  }
  if (!ran) return { state: 'absent' };
  if (ran.code !== 0) return { state: 'failed', reason: `the intel hook exited ${ran.code}${ran.output.trim() ? `: ${oneLine(ran.output.trim().split('\n').pop() ?? '')}` : ''}` };
  const url = lastUrl(ran.output);
  if (!url) return { state: 'failed', reason: 'the intel hook printed no URL as its last line' };

  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + startupSeconds * 1000;
  let last = 'no answer';
  for (;;) {
    try {
      const tools = await initializeAndList(url, f, AbortSignal.timeout(Math.max(1, deadline - now())));
      return { state: 'ready', url, tools };
    } catch (e) {
      last = oneLine((e as Error).message);
    }
    if (now() >= deadline) break;
    await sleep(500);
  }
  return { state: 'failed', reason: `${url} did not answer an MCP initialize within ${startupSeconds}s (${last})` };
}

/** The brief's "Code tools" paragraph for an outcome. `server` is the name it was registered under. */
export function codeToolsParagraph(outcome: IntelOutcome, server: string = INTEL_SERVER_NAME): string {
  if (outcome.state === 'absent') return 'No symbol service is available for this repository.';
  if (outcome.state === 'failed') return `The symbol service did not start (${outcome.reason}), so none is available for this run.`;
  return [
    `The \`${server}\` MCP server serves this repository's symbols from its language server. It offers at least: ${INTEL_MINIMUM_TOOLS.join('; ')}.`,
    `Tools it advertised: ${outcome.tools.length ? outcome.tools.map((t) => `\`${t}\``).join(', ') : '(none listed)'}.`,
  ].join(' ');
}

/**
 * `crew intel bridge` (CREW-2912): carries a worktree's `intel` symbol service
 * into a lane-run session whose MCP server list was fixed at launch.
 *
 * A lane run's session starts in the route directory; the agent cuts the
 * worktree later with `crew worktree`, which is where the `intel` hook runs and
 * its URL first exists. So crew registers this stdio server as `code` at launch
 * and the bridge attaches to the URL when `crew worktree` writes it to the
 * attach file (`<stateDir>/intel/<route>/<ticket>/url`).
 *
 *  - Before the file exists, `tools/list` is the single `code_status` tool.
 *  - On appearance it connects to the URL as an MCP client, forwards
 *    `tools/list` and `tools/call` verbatim, and sends one
 *    `notifications/tools/list_changed` so the harness refreshes.
 *  - A call the upstream cannot answer drops the bridge back to the pre-attach
 *    state and answers with the status text, never an error that ends the run.
 *
 * Deliberately dumb: everything but those two requests and the notification is
 * the SDK's default.
 *
 * Inside a sandbox (CREW-2922) there is no `crew worktree` to write the attach file,
 * so the bridge is given a `start` function instead and runs it lazily: the first
 * `tools/list` or `tools/call` after launch starts the service in the background
 * (`tools/list` answers at once with `code_status`, so the harness's startup is
 * never held), and a call for a symbol tool waits for that start. A start that fails is
 * reported by `code_status`, and calling `code_status` again retries it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
  type CallToolResult, type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { INTEL_SERVER_NAME } from './intel.ts';

export const STATUS_TOOL = 'code_status';

/** Text the status tool (and a call the upstream could not answer) returns before and after an attach. */
export const STATUS_WAITING = 'The symbol service is not available yet: the worktree has not been cut. Run `crew worktree` for the ticket; the symbol tools appear in this server afterwards.';
export const STATUS_STARTING = 'The symbol service is starting inside this sandbox. Call `code_status` again in a few seconds; the symbol tools replace it once the service answers.';
export const statusFailed = (reason: string): string =>
  `The symbol service did not start (${reason}). Run the repository's \`setup\` hook first if you have not; this call has started a retry, so call \`code_status\` again in a few seconds; until it starts use text search.`;
export const STATUS_LOST = 'The symbol service stopped answering, so its tools are unavailable. They return if the service comes back; until then use text search.';

/** `<stateDir>/intel/<route>/<ticket>`, the per-run folder (removed with the worktree). */
export function intelDir(stateDir: string, route: string, ticket: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');
  return join(stateDir, 'intel', safe(route), safe(ticket));
}

export const attachFilePath = (stateDir: string, route: string, ticket: string): string => join(intelDir(stateDir, route, ticket), 'url');

export function writeAttachFile(file: string, url: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${url}\n`);
}

export function readAttachFile(file: string): string | undefined {
  try {
    const url = readFileSync(file, 'utf8').trim();
    return /^https?:\/\/\S+$/i.test(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

export function removeIntelDir(stateDir: string, route: string, ticket: string): void {
  rmSync(intelDir(stateDir, route, ticket), { recursive: true, force: true });
}

const statusTool: Tool = {
  name: STATUS_TOOL,
  description: 'Reports whether this repository\'s symbol service (find symbols, references, definitions, file outlines) is attached. Before `crew worktree` has been run for the ticket it is not; the symbol tools replace this one once it is.',
  inputSchema: { type: 'object', properties: {} },
};

/** What a lazy `start` reports: the service's URL, or a one-line reason it did not come up. */
export type StartResult = { url: string } | { error: string };

export interface BridgeOptions {
  /** The attach file to watch (and, with `start`, to write). */
  attachFile: string;
  /**
   * Starts the service on demand (sandbox runs). Absent on a host run, where `crew worktree`
   * starts it and writes the attach file.
   */
  start?: () => Promise<StartResult>;
  /** How long a symbol-tool call waits for a start in progress. Default 120s. */
  startWaitMs?: number;
  /** Poll interval; 1s in production. */
  pollMs?: number;
  /** Connects to the upstream service; injectable so tests can use an in-process MCP server. */
  connectUpstream?: (url: string) => Promise<Client>;
  version?: string;
}

const defaultConnect = async (url: string): Promise<Client> => {
  const client = new Client({ name: 'crew-intel-bridge', version: '0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
};

export interface Bridge {
  server: Server;
  /** Serves `transport` and starts watching the attach file; resolves once connected. */
  start(transport: Transport): Promise<void>;
  /** One attach attempt now (the poll calls this); true when it attached. */
  tryAttach(): Promise<boolean>;
  attached(): boolean;
  stop(): Promise<void>;
}

export function createBridge(o: BridgeOptions): Bridge {
  const connect = o.connectUpstream ?? defaultConnect;
  const server = new Server(
    { name: INTEL_SERVER_NAME, version: o.version ?? '0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  let upstream: Client | undefined;
  let lost = false;
  let connecting = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let starting: Promise<void> | undefined;
  let startError: string | undefined;

  const notify = (): void => { void server.sendToolListChanged().catch(() => {}); };

  /** Back to the pre-attach state. The attach file is kept: a restarted service rewrites it, and a same-URL service returns on its own. */
  const drop = (): void => {
    const gone = upstream;
    upstream = undefined;
    lost = true;
    if (gone) void gone.close().catch(() => {});
    notify();
  };

  const statusText = (): string =>
    lost ? STATUS_LOST : starting ? STATUS_STARTING : startError !== undefined ? statusFailed(startError) : STATUS_WAITING;
  const status = (): CallToolResult => ({ content: [{ type: 'text', text: statusText() }] });

  /** Begins a lazy start unless one is running; never throws. A no-op without `start`. */
  const ensureStarted = (): void => {
    if (!o.start || upstream || starting) return;
    startError = undefined;
    starting = (async () => {
      try {
        const r = await o.start!();
        if ('error' in r) { startError = r.error; return; }
        writeAttachFile(o.attachFile, r.url);
        await tryAttach();
        if (!upstream) startError = `${r.url} did not accept a connection`;
      } catch (e) {
        startError = (e as Error).message.replace(/\s+/g, ' ').slice(0, 200);
      } finally {
        starting = undefined;
        notify();
      }
    })();
  };

  const waitForStart = async (): Promise<void> => {
    const running = starting;
    if (!running) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([running, new Promise<void>((r) => { t = setTimeout(r, o.startWaitMs ?? 120_000); })]);
    if (t) clearTimeout(t);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    ensureStarted();
    if (!upstream) return { tools: [statusTool] };
    try {
      return await upstream.listTools();
    } catch {
      drop();
      return { tools: [statusTool] };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    // A status call after a failed start reports the failure, then retries in the background.
    const failedNow = req.params.name === STATUS_TOOL && !upstream && !starting && startError !== undefined;
    const failedText = failedNow ? statusText() : undefined;
    ensureStarted();
    if (failedText !== undefined) return { content: [{ type: 'text', text: failedText }] };
    if (req.params.name !== STATUS_TOOL) await waitForStart();
    if (!upstream) return status();
    try {
      return (await upstream.callTool({ name: req.params.name, arguments: req.params.arguments })) as CallToolResult;
    } catch {
      // A transport failure; a tool that merely errors comes back as an `isError` result, not a throw.
      drop();
      return status();
    }
  });

  const tryAttach = async (): Promise<boolean> => {
    if (upstream || connecting) return false;
    const url = readAttachFile(o.attachFile);
    if (!url) return false;
    connecting = true;
    try {
      const client = await connect(url);
      client.onclose = () => { if (upstream === client) drop(); };
      upstream = client;
      lost = false;
      notify();
      return true;
    } catch {
      return false;
    } finally {
      connecting = false;
    }
  };

  return {
    server,
    attached: () => upstream !== undefined,
    tryAttach,
    async start(transport) {
      await server.connect(transport);
      if (existsSync(o.attachFile)) await tryAttach();
      timer = setInterval(() => { void tryAttach(); }, o.pollMs ?? 1000);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      const gone = upstream;
      upstream = undefined;
      await gone?.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

/** Runs the bridge on this process's stdio until stdin closes. */
export async function runBridge(stateDir: string, route: string, ticket: string): Promise<void> {
  const bridge = createBridge({ attachFile: attachFilePath(stateDir, route, ticket) });
  const closed = new Promise<void>((resolve) => { bridge.server.onclose = resolve; process.stdin.on('end', resolve); });
  await bridge.start(new StdioServerTransport());
  await closed;
  await bridge.stop();
}

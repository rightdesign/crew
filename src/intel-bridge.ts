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

export interface BridgeOptions {
  /** The attach file to watch. */
  attachFile: string;
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

  const notify = (): void => { void server.sendToolListChanged().catch(() => {}); };

  /** Back to the pre-attach state. The attach file is kept: a restarted service rewrites it, and a same-URL service returns on its own. */
  const drop = (): void => {
    const gone = upstream;
    upstream = undefined;
    lost = true;
    if (gone) void gone.close().catch(() => {});
    notify();
  };

  const status = (): CallToolResult => ({ content: [{ type: 'text', text: lost ? STATUS_LOST : STATUS_WAITING }] });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!upstream) return { tools: [statusTool] };
    try {
      return await upstream.listTools();
    } catch {
      drop();
      return { tools: [statusTool] };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
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

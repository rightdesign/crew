#!/usr/bin/env node
/**
 * Standalone entrypoint for `passenger-mcp.ts`, env-var configured like the
 * synthesis repo's relay (`apps/relay/src/config.ts` + `index.ts`) — this is
 * what a Ship's per-workspace container will eventually run, once that
 * container exists (not built by ISSUE-551; the ticket's own note says the
 * tool surface "can be developed and tested standalone... before the
 * container/relay/credential plumbing around it exists"). Not wired into
 * `cli.ts` or the `crew` bin: this isn't an operator-facing command, it's a
 * service process. Run directly with
 * `PASSENGER_MCP_ROOT=/path/to/workspace PASSENGER_MCP_WORKSPACE_ID=<id> TABLATION_API_BASE_URL=https://app.tablation.com/api node --experimental-strip-types src/passenger-mcp-main.ts`.
 */
import { createPassengerHttpServer } from './passenger-mcp.ts';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const root = requireEnv('PASSENGER_MCP_ROOT');
// This container's own workspace, per decision 6 (each workspace gets its
// own container) — never taken from a caller, only from this trusted config.
const workspaceId = requireEnv('PASSENGER_MCP_WORKSPACE_ID');
const tablationApiBaseUrl = requireEnv('TABLATION_API_BASE_URL');
const port = Number.parseInt(process.env.PASSENGER_MCP_PORT ?? '8765', 10);

const server = createPassengerHttpServer(
  { allowedDirectories: [root] },
  { tablationApiBaseUrl, workspaceId },
);
server.listen(port, () => {
  console.error(`Passenger MCP server for ${root} (workspace ${workspaceId}) listening on :${port}/mcp`);
});

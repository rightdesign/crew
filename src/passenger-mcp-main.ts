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
 * `PASSENGER_MCP_ROOT=/path/to/workspace node --experimental-strip-types src/passenger-mcp-main.ts`.
 */
import { createPassengerHttpServer } from './passenger-mcp.ts';

const root = process.env.PASSENGER_MCP_ROOT;
if (!root) {
  console.error('Missing required environment variable: PASSENGER_MCP_ROOT');
  process.exit(1);
}
const port = Number.parseInt(process.env.PASSENGER_MCP_PORT ?? '8765', 10);

const server = createPassengerHttpServer({ allowedDirectories: [root] });
server.listen(port, () => {
  console.error(`Passenger MCP server for ${root} listening on :${port}/mcp`);
  console.error('No authentication of its own — see passenger-mcp.ts’s module doc before exposing this beyond localhost.');
});

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GuardDeps } from './guard.js';
import { registerConfirmUpdateTool } from './tools/confirmUpdate.js';
import { registerGetContactTool } from './tools/getContact.js';
import { registerListContactsTool } from './tools/listContacts.js';
import { registerPingTool } from './tools/ping.js';
import { registerProposeUpdateTool } from './tools/proposeUpdate.js';

export function createServer(deps: GuardDeps): McpServer {
  const server = new McpServer({ name: 'mcp-salesforce-server', version: '0.1.0' });

  registerPingTool(server);
  registerListContactsTool(server, deps.sfClient);
  registerGetContactTool(server, deps.sfClient);
  registerProposeUpdateTool(server, deps);
  registerConfirmUpdateTool(server, deps);

  return server;
}

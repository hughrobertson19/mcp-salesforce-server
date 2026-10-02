import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GuardDeps } from './guard.js';
import { registerConfirmUpdateTool } from './tools/confirmUpdate.js';
import { registerPingTool } from './tools/ping.js';
import { registerProposeUpdateTool } from './tools/proposeUpdate.js';
import { registerRecordReadTools } from './tools/records.js';

export function createServer(deps: GuardDeps): McpServer {
  const server = new McpServer({ name: 'mcp-salesforce-server', version: '0.1.0' });

  registerPingTool(server);
  registerRecordReadTools(server, deps.sfClient);
  registerProposeUpdateTool(server, deps);
  registerConfirmUpdateTool(server, deps);

  return server;
}

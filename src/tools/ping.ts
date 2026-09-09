import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Trivial smoke-test tool — proves the server is wired up and reachable over stdio. */
export function registerPingTool(server: McpServer): void {
  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description: 'Smoke-test tool: returns "pong". Useful for confirming the server is running and reachable.',
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    () => ({ content: [{ type: 'text', text: 'pong' }] }),
  );
}

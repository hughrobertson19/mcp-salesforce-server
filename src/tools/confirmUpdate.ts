import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { confirmUpdate, type GuardDeps } from '../guard.js';

export function registerConfirmUpdateTool(server: McpServer, deps: GuardDeps): void {
  server.registerTool(
    'confirm_update',
    {
      title: 'Confirm Contact Update',
      description:
        'Confirm and apply a previously proposed Contact update, identified only by its proposalId — the ' +
        "'before' snapshot lives server-side, so the caller cannot supply or tamper with it. Re-fetches the " +
        'live Salesforce values and re-verifies they still match what the proposal was computed against ' +
        'before writing anything; if the record changed since propose_update, the write is rejected as stale ' +
        'and nothing is applied.',
      inputSchema: {
        proposalId: z.string().describe('The proposalId returned by propose_update.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ proposalId }) => {
      const result = await confirmUpdate(deps, proposalId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        ...(result.status === 'rejected' ? { isError: true } : {}),
      };
    },
  );
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { proposeUpdate, type GuardDeps } from '../guard.js';

const ChangesSchema = z
  .object({
    Email: z.email().optional(),
    Phone: z.string().min(1).optional(),
    Title: z.string().min(1).optional(),
    Department: z.string().min(1).optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, {
    message: 'At least one field change is required.',
  });

export function registerProposeUpdateTool(server: McpServer, deps: GuardDeps): void {
  server.registerTool(
    'propose_update',
    {
      title: 'Propose Contact Update',
      description:
        "Propose a change to a Contact's writable fields (Email, Phone, Title, Department). Fetches the " +
        'current live values, computes a before/after diff, and writes a dry-run entry to the audit log. ' +
        'Does NOT write to Salesforce — call confirm_update with the returned proposalId to actually apply it.',
      inputSchema: {
        contactId: z.string().describe('Salesforce Contact Id.'),
        changes: ChangesSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ contactId, changes }) => {
      const result = await proposeUpdate(deps, { contactId, changes });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}

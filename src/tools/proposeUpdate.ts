import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { proposeUpdate, ProposalValidationError, type GuardDeps } from '../guard.js';
import { OBJECTS, SOBJECT_NAMES, writableFields } from '../objects.js';
import { SalesforceApiError } from '../sfClient.js';

const allowlistSummary = SOBJECT_NAMES.map((name) => `${name}: ${writableFields(name).join(', ')}`).join('; ');

export function registerProposeUpdateTool(server: McpServer, deps: GuardDeps): void {
  server.registerTool(
    'propose_update',
    {
      title: 'Propose Record Update',
      description:
        `Propose a change to a Contact, Account or Opportunity's writable fields (${allowlistSummary}). ` +
        'Fetches the current live values, computes a before/after diff, and writes a dry-run entry to the ' +
        'audit log. Does NOT write to Salesforce — call confirm_update with the returned proposalId to ' +
        'actually apply it. Any field outside the allowlist is rejected.',
      inputSchema: {
        object: z
          .enum(SOBJECT_NAMES)
          .default('Contact')
          .describe('Which Salesforce object the record is. Defaults to Contact.'),
        recordId: z.string().optional().describe('Salesforce record Id of the record to change.'),
        contactId: z.string().optional().describe('Salesforce Contact Id. Kept for backwards compatibility; same as recordId with object "Contact".'),
        changes: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .describe(
            `Field name to new value. Amount is a number, CloseDate is YYYY-MM-DD, everything else is a string. ` +
              `Allowed per object — ${SOBJECT_NAMES.map((n) => `${n}: ${Object.keys(OBJECTS[n].writable).join('/')}`).join('; ')}.`,
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ object, recordId, contactId, changes }) => {
      try {
        const result = await proposeUpdate(deps, { object, recordId, contactId, changes });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (err instanceof ProposalValidationError || err instanceof SalesforceApiError) {
          return { content: [{ type: 'text' as const, text: err.message }], isError: true };
        }
        throw err;
      }
    },
  );
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SalesforceApiError, type SalesforceClient } from '../sfClient.js';
import { WRITABLE_CONTACT_FIELDS } from '../types.js';

const CONTACT_FIELDS = ['Id', 'Name', ...WRITABLE_CONTACT_FIELDS] as const;

export function registerGetContactTool(server: McpServer, sfClient: SalesforceClient): void {
  server.registerTool(
    'get_contact',
    {
      title: 'Get Contact',
      description: 'Fetch a single Salesforce Contact by Id.',
      inputSchema: {
        contactId: z
          .union([z.string().length(15), z.string().length(18)])
          .describe('Salesforce Contact Id (15 or 18 characters).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ contactId }) => {
      try {
        const contact = await sfClient.getContactFields(contactId, CONTACT_FIELDS);
        return { content: [{ type: 'text' as const, text: JSON.stringify(contact, null, 2) }] };
      } catch (err) {
        if (err instanceof SalesforceApiError) {
          return {
            content: [{ type: 'text' as const, text: `Failed to fetch contact ${contactId}: ${err.message}` }],
            isError: true,
          };
        }
        throw err;
      }
    },
  );
}

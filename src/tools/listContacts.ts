import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { escapeSoqlLikeValue, type SalesforceClient } from '../sfClient.js';

export function registerListContactsTool(server: McpServer, sfClient: SalesforceClient): void {
  server.registerTool(
    'list_contacts',
    {
      title: 'List Contacts',
      description: 'List Salesforce Contacts, optionally filtered by a search term matched against Name and Email.',
      inputSchema: {
        search: z.string().optional().describe('Case-insensitive substring match against Name or Email.'),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ search, limit }) => {
      let soql = 'SELECT Id, Name, Email, Phone, Title, Department FROM Contact';
      if (search) {
        const escaped = escapeSoqlLikeValue(search);
        soql += ` WHERE Name LIKE '%${escaped}%' OR Email LIKE '%${escaped}%'`;
      }
      soql += ` ORDER BY Name LIMIT ${limit}`;

      const records = await sfClient.query(soql);
      return { content: [{ type: 'text' as const, text: JSON.stringify(records, null, 2) }] };
    },
  );
}

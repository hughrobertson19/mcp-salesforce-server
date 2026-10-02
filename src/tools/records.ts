import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { hasIdPrefixFor, OBJECTS, type SObjectName } from '../objects.js';
import { escapeSoqlLikeValue, SalesforceApiError, type SalesforceClient } from '../sfClient.js';

interface ReadToolNames {
  object: SObjectName;
  /** Lower-case singular/plural used in tool names and descriptions, e.g. "contact" / "contacts". */
  singular: string;
  plural: string;
  /** Name of the get tool's Id argument, e.g. "contactId". */
  idParam: string;
}

const READ_TOOLS: readonly ReadToolNames[] = [
  { object: 'Contact', singular: 'contact', plural: 'contacts', idParam: 'contactId' },
  { object: 'Account', singular: 'account', plural: 'accounts', idParam: 'accountId' },
  { object: 'Opportunity', singular: 'opportunity', plural: 'opportunities', idParam: 'opportunityId' },
];

function text(value: string): { type: 'text'; text: string } {
  return { type: 'text' as const, text: value };
}

function registerListTool(server: McpServer, sfClient: SalesforceClient, names: ReadToolNames): void {
  const { object, plural } = names;
  const spec = OBJECTS[object];
  const searchDescription = spec.searchFields.join(' and ');

  server.registerTool(
    `list_${plural}`,
    {
      title: `List ${object === 'Opportunity' ? 'Opportunities' : `${object}s`}`,
      description: `List Salesforce ${object === 'Opportunity' ? 'Opportunities' : `${object}s`}, optionally filtered by a search term matched against ${searchDescription}.`,
      inputSchema: {
        search: z.string().optional().describe(`Case-insensitive substring match against ${spec.searchFields.join(' or ')}.`),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ search, limit }) => {
      let soql = `SELECT ${spec.readFields.join(', ')} FROM ${object}`;
      if (search) {
        const escaped = escapeSoqlLikeValue(search);
        soql += ` WHERE ${spec.searchFields.map((field) => `${field} LIKE '%${escaped}%'`).join(' OR ')}`;
      }
      soql += ` ORDER BY Name LIMIT ${limit}`;

      const records = await sfClient.query(soql);
      return { content: [text(JSON.stringify(records, null, 2))] };
    },
  );
}

function registerGetTool(server: McpServer, sfClient: SalesforceClient, names: ReadToolNames): void {
  const { object, singular, idParam } = names;
  const spec = OBJECTS[object];

  server.registerTool(
    `get_${singular}`,
    {
      title: `Get ${object}`,
      description: `Fetch a single Salesforce ${object} by Id.`,
      inputSchema: {
        [idParam]: z
          .union([z.string().length(15), z.string().length(18)])
          .describe(`Salesforce ${object} Id (15 or 18 characters).`),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const id = args[idParam] as string;
      if (!hasIdPrefixFor(object, id)) {
        return {
          content: [text(`${id} is not a valid ${object} Id (${object} Ids start with ${spec.idPrefix}).`)],
          isError: true,
        };
      }
      try {
        const record = await sfClient.getRecordFields(object, id, spec.readFields);
        return { content: [text(JSON.stringify(record, null, 2))] };
      } catch (err) {
        if (err instanceof SalesforceApiError) {
          return { content: [text(`Failed to fetch ${singular} ${id}: ${err.message}`)], isError: true };
        }
        throw err;
      }
    },
  );
}

/** Registers list_/get_ tools for every object in OBJECTS: contacts, accounts and opportunities. */
export function registerRecordReadTools(server: McpServer, sfClient: SalesforceClient): void {
  for (const names of READ_TOOLS) {
    registerListTool(server, sfClient, names);
    registerGetTool(server, sfClient, names);
  }
}

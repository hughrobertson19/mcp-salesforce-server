import { mkdir } from 'node:fs/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFileAuditLog } from './auditLog.js';
import { loadConfig } from './config.js';
import { createFileProposalStore } from './proposalStore.js';
import { createSalesforceClient } from './sfClient.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  await mkdir(config.DATA_DIR, { recursive: true });

  const sfClient = createSalesforceClient({
    loginUrl: config.SF_LOGIN_URL,
    clientId: config.SF_CLIENT_ID,
    clientSecret: config.SF_CLIENT_SECRET,
    apiVersion: config.SF_API_VERSION,
  });
  const proposalStore = createFileProposalStore(config.DATA_DIR, config.PROPOSAL_TTL_MINUTES);
  const auditLog = createFileAuditLog(config.DATA_DIR);

  const server = createServer({ sfClient, proposalStore, auditLog });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout is the MCP protocol channel — all diagnostic output goes to stderr.
  console.error('mcp-salesforce-server running on stdio');
}

main().catch((err: unknown) => {
  console.error('Fatal error starting mcp-salesforce-server:', err);
  process.exit(1);
});

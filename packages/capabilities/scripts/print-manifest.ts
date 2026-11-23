/**
 * Prints the registered AppPort application manifest and the MCP tool projection.
 *
 * Reproducible evidence for docs/evidence/ACCEPTANCE.md:
 *
 *   DATABASE_URL=postgres://mi:mi_dev_password@127.0.0.1:5432/managed_integrations_test \
 *     pnpm --filter @mi/capabilities exec tsx scripts/print-manifest.ts
 *
 * Read-only: it creates the application (which only needs a database handle) and lists the tools
 * the MCP adapter derives from the manifest. It invokes no capability.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '@appport/mcp';
import { createDb } from '@mi/database';
import { createIntegrationsApplication } from '../src/index.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const { db, close } = createDb(url, { max: 1 });
try {
  const application = createIntegrationsApplication({ db });
  const manifest = application.manifest();

  console.log('=== AppPort manifest ===');
  console.log(JSON.stringify(manifest, null, 2));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(application);
  await server.connect(serverTransport);
  const client = new Client({ name: 'managed-integrations-evidence', version: '1.0.0' });
  await client.connect(clientTransport);
  try {
    console.log('=== MCP tools (derived from the manifest) ===');
    console.log(JSON.stringify(await client.listTools(), null, 2));
  } finally {
    await client.close();
    await server.close();
  }
} finally {
  await close();
}

/**
 * Provenance of the QuickBooks-dependent application (slice 7): quickbooks-mcp, an MCP server that gives an
 * agent QuickBooks Online tools (query, create and edit invoices, bills, expenses, …). Managed Integrations
 * adopts its `create_invoice` tool (src/tools/handlers/invoice.ts) and everything it imports.
 *
 * It is NOT a pipeline: QuickBooks is its only provider (role: both — it reads customers and items and writes
 * invoices); its callers are people and agents. Selection evidence: docs/adoption/PROVIDER-APPLICATIONS.md.
 *
 * Attachment: VENDORED at v0.11.0 (ce1317e). The import graph of the adopted tool (27 files) is copied
 * byte-for-byte and sha256-pinned below; dependencies are installed at the versions of upstream's own
 * package-lock.json at that commit.
 */
export const QBO_TOOLS_APP = {
  packageName: 'quickbooks-mcp',
  version: '0.11.0',
  repository: 'https://github.com/laf-rge/quickbooks-mcp',
  commit: 'ce1317e51d43fb669d73f6f874935fb7827e5ebd',
  license: 'MIT',
  attachment: 'vendored' as const,
  entryPoints: [
    'src/tools/handlers/invoice.ts#handleCreateInvoice (the create_invoice tool: resolve customer and items, build the Invoice, create it)',
    'src/client/cache.ts#resolveCustomer / resolveItem (exact-name, then id, then LIKE look-ups of active entities)',
  ],
  notUsed: [
    'src/index.ts / src/server.ts / src/lambda.ts (MCP transport): the host invokes the tool handler; callers reach it through our AppPort / MCP',
    'src/client/auth.ts#getClient and src/credentials/* (local file / AWS credential storage): imported, never called — the host builds the QuickBooks client from the customer’s connection',
    'src/tools/index.ts (tool dispatch, auth retry): the host owns authorization and retries',
  ],
  /** sha256 of every upstream file in the import graph of the adopted tool, at the pinned commit (git archive). */
  fileSha256: {
    'src/client/auth.ts': 'bb4300d91b663b0fd778782e85c7c0eda7869ad4f30d5d2f279c37b73821088f',
    'src/client/cache.ts': '262db6a7629c2f9780167d7ecee5853c2c814e8033dc714a49c56e642c2d0410',
    'src/client/entity-refs.ts': 'aba939077fd8536b78b5aded404472621e0827e0f64dce701fc3c6d437305cc8',
    'src/client/index.ts': 'b9be20b704515cabba36fe50e4d5b50f64e0d68529f4fa0e8c9b54b09fb396c8',
    'src/client/promisify.ts': '7af937dde3c49d70eb445d41a930e31c3c24ec076f5e0ff7fb9a823b24a81b8c',
    'src/client/refs.ts': 'b1d221d28c65b43edc246f351695d35cb521772a8715a16274e6c8833649e6ae',
    'src/client/rest.ts': '417e4df361e2f48cb9df1431e96edd8e6ba717d76dd57fb4ebb1617876b67b6c',
    'src/client/throttle.ts': '256313ec0865fddc4349954ac0c8a710b396490f1a34c1ac0baf2b513f9f2b62',
    'src/client/write-barrier.ts': '2af87fc05ebe918ef3f7a150fa58d997ad625925a09f8ee3f4be17a226e5fb38',
    'src/credentials/aws-provider.ts': '47706d8d6768d84bafe54444f5aa1376b6664d937bb1826a269009c06dad60d0',
    'src/credentials/index.ts': 'a37dd50ab66d9a11ff400f4e1ce17e185f21ef06307659bac52b899ec6e796c4',
    'src/credentials/local-provider.ts': 'ce1061a8342e31dfd22b8af09acede408e689032bad6511fbf3168e359544e04',
    'src/credentials/oauth-client.ts': '127b29e5e7ad8849a529a325ad9c558534d22869f4d298505fb411e4201e97f2',
    'src/credentials/types.ts': 'b3a2d8fbc47d3e3062fe847698c974fd8b174758fc265d858986a80dac0ee311',
    'src/tools/handlers/invoice.ts': '51f30f30a611e99c8b65c28ebd1667fa075bf7fb65220df4908933bc63fc86cc',
    'src/types/cache.ts': '8256f6c3c6e3694b2520259c17c2d6018a5182c8a62ffd3398f4c01259b1de89',
    'src/types/index.ts': 'c6ac41ed168a6c24c241ba389c8ac91e4ed6caa81fcfaea41adf97a76ebc6652',
    'src/types/pagination.ts': 'cdd9f0695a72db8860ab61620825f7f6d30b1854e3afac22ee82332015594186',
    'src/types/quickbooks.ts': '2858279942efabd34e879df09efda680ef0ad0ed0980583a77131a59dea918e1',
    'src/utils/concurrency.ts': 'c0d526dec9b58bc32f59d8ec840a8cb77fa5acec06c0d28e5abd3b550c531b60',
    'src/utils/errors.ts': '8c76906abb0ef2b80ca6b8b9ec15f2d50e360cfb503eee6b10869617704fdd18',
    'src/utils/files.ts': '96c713c479d12f91b26b7fabd97d0e45c857ef8d1859436489693d45b7fa3bb9',
    'src/utils/index.ts': 'b7c833574fb827052c1beb4a34d04ad731804988d9e4139bdecc8c8c13de4fe4',
    'src/utils/money.ts': 'b150756cf35f9a949099bfaef76670b8770964dc576485961748c1cbdddde523',
    'src/utils/output.ts': 'a642781b7b9af91b70cc2091f19149760778287844edc8e25f67cbf0d6d7ca66',
    'src/utils/updates.ts': '4091a141749b613384dbe1fff883d1cc840932322ed0197f4a4c8a3907a105d4',
    'src/utils/urls.ts': '75c9260cfc7d5ccc59d02406316f3a06e0ec1bbec97ece87ee2337fb5ba62a4e',
  } as Record<string, string>,
  /** Resolved versions from upstream's package-lock.json at the pinned commit. */
  dependencies: {
    'node-quickbooks': '2.0.48',
    'intuit-oauth': '4.2.2',
    '@aws-sdk/client-secrets-manager': '3.1004.0',
    '@aws-sdk/client-ssm': '3.1004.0',
    tmp: '0.2.5',
  },
  /** Upstream's next release, which managed maintenance evaluates (reviewed dependency change d0001). */
  nextRelease: { version: '0.12.0', commit: '611ca6d05165e405834bc121762026b285ff5526', date: '2026-10-19' },
};

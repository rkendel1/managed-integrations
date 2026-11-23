/**
 * Provenance of the adopted integration implementation. This is data, checked by tests against
 * the installed package and the lockfile, so it cannot silently drift.
 */
export const ADOPTED = {
  /** Upstream package name as published in its own package.json. */
  packageName: 'shopify-sync',
  repository: 'https://github.com/Milo-ai-HQ/shopify-erp-order-sync',
  upstreamBranch: 'main',
  commit: 'd01b51d95993598580cdcffda6537a6f20a10a3a',
  license: 'MIT',
  copyright: 'Copyright (c) 2026 Milo',
  /** Attachment: installed as an unmodified, commit-pinned dependency (pnpm git resolution). */
  attachment: 'dependency',
  localModifications: [] as string[],
  /** The only upstream entry points Managed Integrations calls. */
  entryPoints: [
    'src/webhook.js#verifyShopifyHmac',
    'src/mapping.js#toCanonicalOrder',
    'src/adapters/netsuite.js#createNetSuiteAdapter',
    'src/sync.js#syncOrder',
  ],
  /**
   * sha256 of every upstream file Managed Integrations executes, computed from an independent clone at
   * `commit`. Tests compare the installed package against these, so a local patch cannot go unnoticed.
   */
  fileSha256: {
    'src/webhook.js': '8021f0bd43c10466dbe7f8daff569764ae09af3e697ffa914e53f841639a522f',
    'src/mapping.js': 'f6b29ae7ff357ac7acbccaa012af5af9bc6e9f46d381462b9f3fab52c94bf01f',
    'src/adapters/netsuite.js': '871866d6ea5fe946d2c57006589a47ba847251f2c21fbb98b2a83ebb55a1eaed',
    'src/sync.js': 'ba23c32d2ab49ed0de99c2bc0ae8f9972b957ee737695ca6d6aa9f650f82bf87',
    'src/http.js': 'ade792b8e7b9f723e3cbe7cb7342cadf52657a35249a945af8a36001f6fb862d',
    'src/errors.js': '469204e096b0f2cd4f65268d205da9c856a5444107944a764ab10af9ed1266ac',
    LICENSE: '717f22164312347baf4414aee4e81c4701494aadb2004b2939619f7071d898cc',
  },
  /** Upstream behaviour deliberately NOT used. */
  notUsed: [
    'src/server.js (Managed Integrations hosts the webhook endpoint so receipt is durable and tenant-routed)',
    'src/cli.js',
    'src/adapters/{priority,business-central,odoo}.js (out of scope: NetSuite only)',
    'adapterFromEnv (configuration comes from durable tenant configuration, not process env)',
  ],
} as const;

export const ADOPTED_VERSION_LABEL = `${ADOPTED.packageName}@${ADOPTED.commit.slice(0, 12)}`;

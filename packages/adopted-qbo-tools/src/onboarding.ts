/**
 * Onboarding the QuickBooks application. It has no footprint at QuickBooks to discover (an MCP server leaves
 * no signature on what it creates), so the candidate is a NEW managed instance of the pinned application,
 * stated as such. Activation proves the connection and reads the catalog the tool resolves names against.
 */
import { integrationContracts, providers, type Db } from '@mi/database';
import { contractSha256, type CredentialCipher, type ProviderEndpointConfig } from '@mi/integration-shopify-netsuite';
import { discoveryOutcome, type OnboardingImplementation } from '@mi/managed';
import { describeError } from '@mi/observability';
import { QuickBooksAccess } from '@mi/provider-connections';
import { QBO_TOOLS_CONTRACT, QBO_TOOLS_CONTRACT_VERSION, QBO_TOOLS_FLOW_TYPE } from './contract.ts';
import { QBO_TOOLS } from './descriptor.ts';
import { QBO_TOOLS_APP } from './provenance.ts';

export function qboToolsOnboarding(deps: { cipher: CredentialCipher; endpoints: ProviderEndpointConfig }): OnboardingImplementation {
  return {
    descriptor: QBO_TOOLS,
    async discover(_db, _tenantId, opts) {
      const now = (opts.now ?? new Date()).toISOString();
      const candidates = [{
        id: 'quickbooks-mcp:new',
        kind: 'new' as const,
        title: 'QuickBooks tools (quickbooks-mcp)',
        summary: `We run quickbooks-mcp v${QBO_TOOLS_APP.version} for you (its create_invoice tool), connected to your QuickBooks company. Nothing existing was found to adopt: this application leaves no signature in QuickBooks.`,
        implementation: QBO_TOOLS_APP.packageName,
        confidence: null,
        evidence: {},
      }];
      return { at: now, outcome: discoveryOutcome(candidates), window: { from: now, to: now }, sampled: 0, candidates };
    },
    async ensureContract(db: Db) {
      await db.insert(providers).values({ id: 'quickbooks', displayName: 'QuickBooks Online', apiVersion: 'v3 (minor version 75)', capabilities: ['oauth2.authorization_code (rotating refresh tokens)', 'Invoice.create', 'query'], documentation: ['https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice'] }).onConflictDoNothing();
      await db.insert(integrationContracts).values({ version: QBO_TOOLS_CONTRACT_VERSION, flowType: QBO_TOOLS_FLOW_TYPE, definition: QBO_TOOLS_CONTRACT, definitionSha256: contractSha256(QBO_TOOLS_CONTRACT) }).onConflictDoNothing();
    },
    integrationValues: () => ({ displayName: QBO_TOOLS.name, contractVersion: QBO_TOOLS_CONTRACT_VERSION, config: {} }),
    steps: [
      {
        key: 'connection',
        label: 'Your QuickBooks company answers',
        async run(ctx) {
          try {
            const qbo = new QuickBooksAccess(ctx.db, deps.cipher, deps.endpoints, ctx.tenantId);
            const q = await qbo.query<{ Customer?: unknown[]; Item?: unknown[] }>('select * from Customer');
            const items = await qbo.query<{ Item?: unknown[] }>('select * from Item');
            return { state: 'done', detail: 'connected', record: { customers: q.Customer?.length ?? 0, items: items.Item?.length ?? 0 } };
          } catch (err) {
            return { state: 'blocked', detail: 'QuickBooks refused', problem: `QuickBooks did not answer: ${describeError(err).message}` };
          }
        },
      },
    ],
    async baselineResult(_db, records) {
      return { customers: records['connection']?.['customers'] ?? 0, items: records['connection']?.['items'] ?? 0 };
    },
  };
}

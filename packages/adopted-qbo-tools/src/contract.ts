import type { IntegrationContractDefinition } from '@mi/contracts';
import { QBO_TOOLS_APP } from './provenance.ts';

export const QBO_TOOLS_FLOW_TYPE = 'adopted.quickbooks_mcp_tools';
export const QBO_TOOLS_CONTRACT_VERSION = 'quickbooks-mcp-tools@1';

/** The registered contract (shared definition). Its "scope" is the provider connection and the tool's effects. */
export const QBO_TOOLS_CONTRACT: IntegrationContractDefinition = {
  version: QBO_TOOLS_CONTRACT_VERSION,
  flowType: QBO_TOOLS_FLOW_TYPE as IntegrationContractDefinition['flowType'],
  scope: {
    source: 'requests from the customer’s people and agents (AppPort / MCP)',
    destination: 'QuickBooks Online (Invoice; reads Customer and Item)',
    objects: ['create_invoice request → QuickBooks Invoice'],
    fields: [
      { source: 'customer_name / customer_id', destination: 'Invoice.CustomerRef', rule: 'an active customer, exact name first (the application’s own resolution)' },
      { source: 'lines[].item_name, amount | qty × unit_price', destination: 'Invoice.Line[] (SalesItemLineDetail)', rule: 'an active item per line; amounts in cents, as the application validates' },
      { source: 'doc_number, txn_date, memo', destination: 'Invoice.DocNumber, TxnDate, PrivateNote', rule: 'as given' },
    ],
    excluded: ['The application’s other tools (bills, expenses, journal entries, reports, …) are not managed in this slice'],
  },
  direction: { source: 'the customer', destination: 'QuickBooks Online', permittedWrites: ['Create Invoice'], neverWrites: ['Updates or deletions in QuickBooks'] },
  freshness: { syncIntervalMinutes: 0, maxAcceptableDelayMinutes: 0 },
  completeness: ['Every request is recorded durably before it runs; a request held for lost authorization runs after the customer reconnects.'],
  correctness: ['Every invoice created is read back from QuickBooks: customer, items, amounts, total and number as requested.'],
  idempotency: ['One record per caller request id: a repeated request returns the first result and creates nothing.'],
  recovery: ['Requests held because QuickBooks authorization was lost (nothing was sent) are run after reconnection and verified.'],
  compatibility: [`Pinned to ${QBO_TOOLS_APP.commit.slice(0, 12)} (v${QBO_TOOLS_APP.version}) with node-quickbooks ${QBO_TOOLS_APP.dependencies['node-quickbooks']} (minor version 75).`],
  responsibility: { weOwn: ['Hosting the tool, authorization, durable requests, verification and evidence'], customerOwns: ['Their customers and products in QuickBooks', 'Granting QuickBooks access again when it is revoked'] },
  limitations: ['Fixture-verified only: not run against a live QuickBooks company.'],
};

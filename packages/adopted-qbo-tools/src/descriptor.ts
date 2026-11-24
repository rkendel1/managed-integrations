/**
 * The QuickBooks-dependent APPLICATION (not a pipeline): one provider, QuickBooks, role `both` (reads
 * customers and items, writes invoices). Callers are the customer's people and agents.
 */
import type { IntegrationDescriptor, Responsibilities } from '@mi/managed';
import { QBO_TOOLS_FLOW_TYPE } from './contract.ts';
import { QBO_TOOLS_APP as U } from './provenance.ts';

export const QBO_TOOLS: IntegrationDescriptor & { responsibilities: Responsibilities } = {
  flowType: QBO_TOOLS_FLOW_TYPE,
  name: 'QuickBooks tools (quickbooks-mcp)',
  process: 'Your QuickBooks tools for people and agents: create invoices in QuickBooks from a request, with the customer and products resolved by name',
  shape: 'application',
  providers: [
    {
      id: 'quickbooks',
      name: 'QuickBooks',
      role: 'both',
      api: 'QuickBooks Online Accounting API v3 (Invoice, Customer, Item, query)',
      version: 'minor version 75 (node-quickbooks default since 2.0.46; the version Intuit serves)',
      auth: 'OAuth 2.0 (rotating refresh tokens); the host supplies the access token to the application’s client',
      client: `node-quickbooks ${U.dependencies['node-quickbooks']} (axios), from the application’s lockfile, linked into the artifact`,
      operations: [
        { name: 'query Customer / Item (exact name, id, LIKE; active only)', kind: 'read', effect: 'the application resolves names to QuickBooks references' },
        { name: 'POST /invoice', kind: 'write', effect: 'creates one invoice (not idempotent at QuickBooks: node-quickbooks sends no requestid for it)' },
        { name: 'GET /invoice/{id}', kind: 'read', effect: 'our verification (not the application)' },
      ],
      semantics: 'an invoice to a customer for products/services, its amounts and total',
      idempotency: 'one record per caller request id; a request is never re-sent once it reached QuickBooks',
      recovery: 'requests held before anything was sent (authorization lost) run after reconnection',
      verification: ['the invoice exists in QuickBooks with the requested customer, items, amounts, total and number'],
    },
  ],
  transactions: { one: 'request', many: 'requests', record: 'invoice', businessData: 'customer, items and amounts' },
  adopted: { repository: U.repository, commit: U.commit, license: U.license, package: U.packageName, attachment: 'vendored', entryPoints: U.entryPoints, notUsed: U.notUsed },
  execution: { trigger: 'a request from the customer (AppPort / MCP) runs the application’s create_invoice tool', idempotency: 'one record per caller request id' },
  dependencies: [
    { provider: 'quickbooks', contract: 'Invoice create + Customer/Item query', version: 'v3, minor version 75', usedFor: 'every QuickBooks call the tool makes' },
    { provider: 'quickbooks', contract: 'OAuth 2.0 (rotating refresh tokens)', version: 'OAuth 2.0', usedFor: 'access to the customer’s company' },
  ],
  capabilities: {
    discovery: null,
    monitoring: [
      { signal: 'destination_available', method: 'QuickBooks CompanyInfo query' },
      { signal: 'credentials', method: 'QuickBooks token refresh outcome (invalid_grant = lost)' },
      { signal: 'rejected', method: 'requests QuickBooks or the application refuses' },
      { signal: 'destination_verification', method: 'every invoice read back after it is created' },
      { signal: 'contract_change', method: 'the client’s requests (minor version, user agent) and the artifact that ran' },
      { signal: 'commitment_boundary', method: 'escalated maintenance events' },
    ],
    recovery: 'Requests held because authorization was lost (nothing was sent) run after the customer reconnects, and are verified.',
    verification: 'Each invoice is read back from QuickBooks by id: customer, items, amounts, total and number as requested.',
    corrections: [
      { pattern: 'reauthorization', status: 'implemented', note: 'customer reconnects QuickBooks; held requests run and are verified' },
      { pattern: 'api_version_pin', status: 'implemented', note: 'reviewed dependency change d0001 (upstream v0.12.0: node-quickbooks 2.0.50), operator activation' },
      { pattern: 'field_moved', status: 'not_supported', note: 'no adapter exists for this application' },
      { pattern: 'business_meaning', status: 'not_supported', note: 'routed to a person (unsupported)' },
    ],
  },
  limitations: [
    'Only the create_invoice tool is managed; the application’s other tools are not hosted in this slice.',
    'QuickBooks invoice creation has no idempotency key in this client: a request whose outcome is unknown (connection lost after sending) is not re-sent automatically; it is escalated.',
    'Sales tax: the fixture company has no automated sales tax; with it, QuickBooks adds tax to the total and verification would report the difference.',
  ],
  responsibilities: {
    version: 'q1',
    maintain: [
      'Run your QuickBooks tools for you (quickbooks-mcp), pinned to a known version, with your QuickBooks connection kept working.',
      'Record every request before it runs, create each invoice once, and check it in QuickBooks.',
      'Adapt the tools when QuickBooks or the tools themselves change, verify the result and tell you what happened.',
    ],
    access: ['QuickBooks: read customers and products/services; create invoices.'],
    verify: ['Every invoice we create is in QuickBooks exactly once, with the customer, items and amounts you asked for.'],
  },
};

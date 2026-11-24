/**
 * Stripe → QuickBooks (adopted ledgerly): its maintenance contract. Every `implemented` capability is
 * exercised by this package's tests and by `make demo-stripe`.
 */
import type { IntegrationDescriptor, Responsibilities } from '@mi/managed';
import { LEDGERLY_FLOW_TYPE } from './contract.ts';
import { LEDGERLY } from './provenance.ts';

export const STRIPE_QUICKBOOKS: IntegrationDescriptor & { responsibilities: Responsibilities } = {
  flowType: LEDGERLY_FLOW_TYPE,
  name: 'Stripe → QuickBooks accounting',
  process: 'Stripe payments, refunds and payouts become balanced QuickBooks journal entries',
  shape: 'pipeline',
  providers: [
    {
      id: 'stripe',
      name: 'Stripe',
      role: 'source',
      api: 'Stripe API (events, charges, invoices, refunds, payouts)',
      version: '2024-06-20 (adopted SDK pin); webhook bodies at the endpoint’s version',
      auth: 'restricted secret key (Bearer); webhook signature HMAC-SHA256 (whsec)',
      client: 'stripe-node, as installed with ledgerly; ledgerly src/server/expand.ts',
      operations: [
        { name: 'webhook events', kind: 'event', effect: 'mapped to journal entries by the adopted engine' },
        { name: 'retrieve with expand[]', kind: 'read', effect: 'balance transactions, fees and refunds' },
        { name: 'Events API', kind: 'read', effect: 'discovery, reconciliation and recovery' },
      ],
      semantics: 'money movement: gross, fees, net, refunds and payouts from balance transactions',
      idempotency: 'one delivery per Stripe event id',
      recovery: 'Events API (30-day retention) reconstructs missed events',
      verification: ['every Stripe transaction in the window has a journal entry'],
    },
    {
      id: 'quickbooks',
      name: 'QuickBooks',
      role: 'target',
      api: 'QuickBooks Online Accounting API',
      version: 'v3, minorversion 70 requested (served as 75)',
      auth: 'OAuth 2.0 (rotating refresh tokens)',
      client: 'ledgerly src/server/dispatchers/qbo.ts (fetch)',
      operations: [
        { name: 'JournalEntry create', kind: 'write', effect: 'posts one balanced journal entry' },
        { name: 'JournalEntry / Account query', kind: 'read', effect: 'verification and account mapping' },
      ],
      semantics: 'double-entry: accounts, sides and amounts that balance',
      idempotency: 'requestid on create and a DocNumber look-up before posting',
      recovery: 'held work is released and re-posted through the same dispatcher',
      verification: [
        'exactly one journal entry per expected entry',
        'balanced, with accounts, sides and amounts from Stripe’s balance transactions',
        'accounts as mapped when the transaction was posted',
      ],
    },
  ],
  transactions: {
    one: 'transaction',
    many: 'transactions',
    record: 'journal entry',
    businessData: 'accounts, amounts, fees and net',
  },
  adopted: {
    repository: LEDGERLY.repository,
    commit: LEDGERLY.commit,
    license: LEDGERLY.license,
    package: LEDGERLY.packageName,
    attachment: 'dependency',
    entryPoints: LEDGERLY.entryPoints,
    notUsed: LEDGERLY.notUsed,
  },
  execution: {
    trigger:
      'Stripe webhooks to our endpoint (signature-verified, durably received), plus Events API recovery',
    idempotency:
      'one delivery per Stripe event id; QuickBooks requestid and a DocNumber look-up before posting',
  },
  dependencies: [
    {
      provider: 'stripe',
      contract: 'webhook events + retrieve with expand[]',
      version: '2024-06-20 (SDK and invoices pinned)',
      usedFor: 'what the engine maps',
    },
    {
      provider: 'stripe',
      contract: 'Events API (30-day retention)',
      version: '2024-06-20',
      usedFor: 'discovery, reconciliation, recovery',
    },
    {
      provider: 'quickbooks',
      contract: 'Accounting API JournalEntry create + query',
      version: 'v3, minorversion 70 requested (served as 75)',
      usedFor: 'writes (adopted code) and verification (ours)',
    },
    {
      provider: 'quickbooks',
      contract: 'OAuth 2.0 (rotating refresh tokens)',
      version: 'OAuth 2.0',
      usedFor: 'access to the customer’s books',
    },
  ],
  capabilities: {
    discovery:
      'Recent Stripe events (30 days, ≤100) matched to QuickBooks journal entries with ledgerly’s signature (DocNumber from the event id and its memo); the account mapping is read from those entries.',
    monitoring: [
      { signal: 'source_available', method: 'Stripe GET /v1/account with the customer’s key' },
      { signal: 'destination_available', method: 'QuickBooks CompanyInfo query' },
      {
        signal: 'credentials',
        method: 'Stripe key accepted; QuickBooks token refresh outcome (invalid_grant = lost)',
      },
      { signal: 'activity', method: 'recent Stripe events vs transactions received by us' },
      { signal: 'processing', method: 'deliveries pending more than 10 minutes' },
      { signal: 'delayed', method: 'held and awaiting-authorization deliveries' },
      { signal: 'rejected', method: 'transactions the adopted code refuses (e.g. cross-currency payouts)' },
      { signal: 'missing', method: 'reconciliation against the Stripe Events API' },
      { signal: 'duplicated', method: 'reconciliation: more than one journal entry per DocNumber' },
      {
        signal: 'contract_change',
        method: 'dependency contract of the pinned code (QuickBooks minor version, Stripe versions)',
      },
      {
        signal: 'destination_verification',
        method: 'completed consistent reconciliation in the last 24 hours',
      },
      { signal: 'commitment_boundary', method: 'escalated maintenance events and unsupported changes' },
    ],
    recovery:
      'Missing transactions are reconstructed from the Stripe Events API (within its 30-day retention) and run through the same adopted executor; transactions held for lost authorization are released after the customer reconnects.',
    verification:
      'QuickBooks journal entries read back by DocNumber: exactly one per expected entry, balanced, with the accounts, sides and amounts computed from Stripe’s balance transactions.',
    corrections: [
      {
        pattern: 'reauthorization',
        status: 'implemented',
        note: 'customer reconnects QuickBooks; held work released, reconciled and verified',
      },
      {
        pattern: 'destination_contract',
        status: 'implemented',
        note: 'reviewed patch p0001: request the QuickBooks minor version Intuit serves (operator activation)',
      },
      {
        pattern: 'api_version_pin',
        status: 'not_supported',
        note: 'not needed so far: upstream already retrieves invoices at its pinned Stripe version',
      },
      {
        pattern: 'field_moved',
        status: 'not_supported',
        note: 'no adapter exists for this integration; an input-contract break is held and escalated',
      },
      { pattern: 'business_meaning', status: 'not_supported', note: 'routed to a person (unsupported)' },
    ],
  },
  limitations: [
    'Annual plans (deferred revenue recognised monthly) are refused: the recognition schedule is not posted.',
    'Disputes, credit notes and invoice voids are mapped by upstream but not managed by this integration.',
    'Cross-currency payouts are refused by upstream (no FX accounting).',
    'Recovery from Stripe is bounded by Stripe’s 30-day event retention.',
    'Other integrations are only recognised in QuickBooks when they use the Stripe object id as DocNumber.',
  ],
  responsibilities: {
    version: 's1',
    maintain: [
      'Run your Stripe → QuickBooks accounting integration for you: the same ledgerly software, pinned to a known version.',
      'Receive Stripe’s notifications at our service and post each payment, refund and payout to QuickBooks exactly once, as a balanced journal entry.',
      'Check Stripe and QuickBooks against each other and recover transactions that never arrived.',
      'Keep your QuickBooks connection working, adapt the integration when Stripe or QuickBooks change, verify the result, and tell you what happened.',
    ],
    access: [
      'Stripe: read payments, invoices, refunds and payouts, and register a notification endpoint for our service.',
      'QuickBooks: create journal entries; read accounts and journal entries.',
    ],
    verify: [
      'Every Stripe transaction is in QuickBooks exactly once, balanced, with the amounts, fees and net Stripe reports.',
      'Transactions that never reached QuickBooks are found by comparing both systems.',
    ],
  },
};

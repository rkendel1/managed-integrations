import { z } from 'zod';
import type { IntegrationContractDefinition } from '@mi/contracts';
import { integrationContracts, providers, type Db } from '@mi/database';
import { contractSha256 } from '@mi/integration-shopify-netsuite';

export const LEDGERLY_FLOW_TYPE = 'adopted.ledgerly.stripe_quickbooks';

/** The Stripe event types this integration takes responsibility for (each maps through ledgerly). */
export const MANAGED_EVENT_TYPES = [
  'charge.succeeded',
  'charge.refunded',
  'invoice.payment_succeeded',
  'payout.paid',
] as const;

export const LedgerlyConfigSchema = z.object({
  /** ledgerly account code → QuickBooks account (the customer's chart of accounts). */
  accountMap: z.record(z.string(), z.object({ qboId: z.string(), name: z.string() })),
  /** Where the account map came from: inferred from their books, or matched by account name. */
  accountMapSource: z.enum(['history', 'account_names']),
  /** Transactions created on or after this are our responsibility. */
  coverFrom: z.string().datetime({ offset: true }),
  reconcileGraceMinutes: z.number().int().min(0).max(1440).default(10),
  /** The Stripe webhook endpoint registered for us at onboarding (secret encrypted, AAD = integration). */
  webhook: z
    .object({
      endpointId: z.string(),
      url: z.string(),
      apiVersion: z.string(),
      secretCiphertext: z.string(),
    })
    .optional(),
});
export type LedgerlyConfig = z.infer<typeof LedgerlyConfigSchema>;
export const webhookSecretAad = (integrationId: string) => `integration:${integrationId}:stripe-webhook`;

export const LEDGERLY_CONTRACT: IntegrationContractDefinition = {
  version: 'ledgerly-1.0.0',
  flowType: LEDGERLY_FLOW_TYPE as never,
  scope: {
    source: 'Stripe (signed webhooks; Events API for reconciliation and recovery)',
    destination: 'QuickBooks Online Accounting API (JournalEntry)',
    objects: [
      'Stripe charge (one-off payment) → balanced journal entry',
      'Stripe paid subscription invoice → balanced journal entry',
      'Stripe refund → balanced journal entry',
      'Stripe payout to the bank → transfer journal entry',
    ],
    fields: [
      {
        source: 'event.id',
        destination: 'JournalEntry.DocNumber',
        rule: 'last 21 characters (upstream toQbo)',
      },
      {
        source: 'object id and customer',
        destination: 'JournalEntry.PrivateNote',
        rule: 'memo, e.g. "Stripe charge ch_… (customer cus_…)"',
      },
      {
        source: 'balance transaction amount / fee / net',
        destination: 'JournalEntry.Line[]',
        rule: 'Dr Stripe Clearing (net), Dr Processing Fees (fee), Cr Revenue (gross)',
      },
      {
        source: 'event.created / payout.arrival_date',
        destination: 'JournalEntry.TxnDate',
        rule: 'UTC date',
      },
    ],
    excluded: [
      'Deferred revenue schedules (annual plans recognised monthly): not posted by us',
      'Disputes, credit notes, uncollectible and voided invoices (mapped by upstream, not managed here)',
      'Cross-currency payouts (refused by upstream)',
    ],
  },
  direction: {
    source: 'Stripe (read only)',
    destination: 'QuickBooks Online',
    permittedWrites: ['Create JournalEntry (requestid-idempotent)'],
    neverWrites: ['Stripe (except registering our webhook endpoint)', 'Updates or deletions in QuickBooks'],
  },
  freshness: { syncIntervalMinutes: 0, maxAcceptableDelayMinutes: 0 },
  completeness: [
    'Every signed Stripe webhook is recorded durably before it is acknowledged.',
    'Scheduled reconciliation reads the Stripe Events API (Stripe keeps events for 30 days) and finds events that never reached us.',
  ],
  correctness: [
    'Every journal entry balances (upstream asserts it); amounts equal Stripe’s balance transaction (checked when verifying).',
  ],
  idempotency: [
    'One delivery per Stripe event id; QuickBooks requestid (upstream dispatcher) makes a retried create return the same entry.',
    'Before posting, existing journal entries with the event’s DocNumber are looked up; one found is recorded, never duplicated.',
  ],
  recovery: [
    'Transient failures are retried with backoff; lost QuickBooks authorization holds work until the customer reconnects, then it is released and verified.',
  ],
  compatibility: [
    'ledgerly is pinned to a commit; Stripe calls are pinned to API version 2024-06-20 (the version ledgerly is written for).',
  ],
  responsibility: {
    weOwn: [
      'Receipt, execution, retries, reconciliation, verification and evidence',
      'QuickBooks token refresh',
    ],
    customerOwns: [
      'The chart of accounts the entries post to',
      'Granting QuickBooks access again when it is revoked',
    ],
  },
  limitations: ['Fixture-verified only: not run against a live Stripe account or QuickBooks company.'],
};

export async function registerLedgerlyReferenceData(db: Db): Promise<void> {
  await db
    .insert(providers)
    .values([
      {
        id: 'stripe',
        displayName: 'Stripe',
        apiVersion: '2024-06-20',
        capabilities: [
          'events.list (Events API)',
          'webhook_endpoints.create',
          'charges/invoices/payouts.retrieve (expand)',
        ],
        documentation: [
          'https://docs.stripe.com/api/events/list',
          'https://docs.stripe.com/webhooks#verify-events',
          'https://docs.stripe.com/upgrades',
        ],
      },
      {
        id: 'quickbooks',
        displayName: 'QuickBooks Online',
        apiVersion: 'v3 (minor version 75)',
        capabilities: [
          'oauth2.authorization_code (rotating refresh tokens)',
          'JournalEntry.create (requestid)',
          'query',
        ],
        documentation: [
          'https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0',
          'https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/journalentry',
          'https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/minor-versions',
        ],
      },
    ])
    .onConflictDoNothing();
  await db
    .insert(integrationContracts)
    .values({
      version: LEDGERLY_CONTRACT.version,
      flowType: LEDGERLY_FLOW_TYPE,
      definition: LEDGERLY_CONTRACT,
      definitionSha256: contractSha256(LEDGERLY_CONTRACT),
    })
    .onConflictDoNothing();
}

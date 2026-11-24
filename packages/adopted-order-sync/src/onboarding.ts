/**
 * Onboarding (slice 5): Connect → Discover → Confirm → Protect, for the supported Shopify → NetSuite flow.
 *
 * Discovery uses only what the customer's authorizations let us read, and does not confuse a connection
 * with a working integration:
 *   - Shopify Admin API: the customer's recent orders (read_orders);
 *   - NetSuite SuiteQL: sales orders that reference those orders, by external id or by order number.
 * The adoptable implementation (shopify-erp-order-sync) has a destination signature written by its own
 * mapping: externalId "shopify-<order id>" AND otherRefNum "<order name>". Orders that reached NetSuite
 * with that signature are evidence of that implementation running; orders that reached NetSuite under
 * another reference scheme are evidence of a DIFFERENT integration we cannot adopt. (Shopify does not let
 * one app read another app's webhook subscriptions, so we do not claim to see them.)
 *
 * Protect: register our order notification through the Shopify Admin API, take a baseline reconciliation
 * of the discovered window with the existing reconciliation, and only then mark the integration managed.
 * Every step is durable in `onboardings`, so an interrupted onboarding resumes.
 */
import { and, eq } from 'drizzle-orm';
import { deliveries, integrations, reconciliationItems, reconciliationRuns, type Db } from '@mi/database';
import {
  ConnectionCredentials,
  DEFAULT_RETRY,
  NetSuiteClient,
  ShopifyClient,
  sourceImplementation,
  withRetry,
  type CredentialCipher,
  type ProviderEndpointConfig,
  type RetryPolicy,
} from '@mi/integration-shopify-netsuite';
import {
  confidenceOf,
  discoveryOutcome,
  OnboardingError,
  type ActivationStep,
  type Candidate,
  type Discovery,
  type OnboardingImplementation,
  type StepContext,
  type StepResult,
} from '@mi/managed';
import { readDestination, type SourceIdentity } from '@mi/reliability';
import { ADOPTED_CONTRACT, ADOPTED_FLOW_TYPE, registerAdoptedContract } from './contract.ts';
import { SHOPIFY_NETSUITE } from './descriptor.ts';
import { ReconciliationBusy, startReconciliation, type AdoptedClients } from './reconcile.ts';
import { DISCOVERY_QUERY, discoveryFilter, type DiscoveredOrder } from './source.ts';

export { OnboardingError, type Candidate, type Discovery };

/** What the customer authorizes when they confirm (versioned: the confirmation records the version). */
export const RESPONSIBILITIES = SHOPIFY_NETSUITE.responsibilities;

const DISCOVERY_DAYS = 30;
const GRACE_MS = 10 * 60_000;
const SAMPLE_LIMIT = 100;

const NEW_CANDIDATE: Candidate = {
  id: 'new.shopify_orders_netsuite',
  kind: 'new',
  title: 'Shopify orders → NetSuite sales orders',
  summary: 'We run a managed Shopify → NetSuite order integration for you, starting now.',
  implementation: 'shopify-erp-order-sync',
  confidence: null,
  evidence: {},
};

/** Provider clients for a tenant, from its durable connections. */
export async function tenantClients(
  db: Db,
  cipher: CredentialCipher,
  endpoints: ProviderEndpointConfig,
  tenantId: string,
): Promise<AdoptedClients> {
  const creds = new ConnectionCredentials(db, cipher, endpoints);
  const shop = await creds.load(tenantId, 'shopify');
  const ns = await creds.load(tenantId, 'netsuite');
  if (!shop?.baseUrl || !ns?.baseUrl) throw new OnboardingError('Connect Shopify and NetSuite first');
  return {
    shopify: new ShopifyClient({
      baseUrl: shop.baseUrl,
      apiVersion: sourceImplementation.shopifyApiVersion,
      auth: creds.shopifyAuth(shop),
    }),
    netsuite: new NetSuiteClient({ baseUrl: ns.baseUrl, auth: creds.netsuiteAuth(ns) }),
  };
}

/* ================================================================== discover */

/** Reads the customer's recent Shopify orders and the NetSuite records that reference them. */
export async function discoverIntegration(
  db: Db,
  clients: AdoptedClients,
  tenantId: string,
  opts: { now?: Date; retry?: RetryPolicy } = {},
): Promise<Discovery> {
  const now = opts.now ?? new Date();
  const retry = opts.retry ?? DEFAULT_RETRY;
  const window = {
    from: new Date(now.getTime() - DISCOVERY_DAYS * 86_400_000),
    to: new Date(now.getTime() - GRACE_MS),
  };
  const managed = await db
    .select()
    .from(integrations)
    .where(
      and(
        eq(integrations.tenantId, tenantId),
        eq(integrations.flowType, ADOPTED_FLOW_TYPE),
        eq(integrations.lifecycle, 'active'),
      ),
    );
  const base = {
    at: now.toISOString(),
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
  };
  if (managed.length) return { ...base, outcome: 'already_managed', sampled: 0, candidates: [] };

  // 1. Shopify: recent orders (bounded sample).
  const orders: DiscoveredOrder[] = [];
  let after: string | null = null;
  do {
    const res = await withRetry(
      () =>
        clients.shopify.graphql(DISCOVERY_QUERY, {
          first: 50,
          after,
          query: discoveryFilter(window.from, window.to),
        }),
      retry,
    );
    const page = (
      res.data as {
        orders: { nodes: DiscoveredOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      }
    ).orders;
    orders.push(...page.nodes.filter((o) => !o.cancelledAt));
    after = page.pageInfo.hasNextPage && orders.length < SAMPLE_LIMIT ? page.pageInfo.endCursor : null;
  } while (after);
  if (!orders.length)
    return { ...base, outcome: 'insufficient_evidence', sampled: 0, candidates: [NEW_CANDIDATE] };

  // 2. NetSuite: sales orders referencing them (by external id OR order number).
  const identities: SourceIdentity[] = orders.map((o) => ({
    sourceId: o.id,
    legacyId: o.legacyResourceId,
    name: o.name,
    updatedAt: o.createdAt,
    cancelledAt: o.cancelledAt,
    lines: [],
  }));
  const records = await readDestination(clients.netsuite, identities, retry);

  // 3. Classify by destination signature.
  const signature: { name: string; at: string }[] = [];
  const other = new Map<string, { name: string; at: string }[]>();
  for (const o of orders) {
    const sig = records.find(
      (r) => r.externalId === `shopify-${o.legacyResourceId}` && r.otherRefNum === o.name,
    );
    if (sig) {
      signature.push({ name: o.name, at: o.createdAt });
      continue;
    }
    const ref = records.find(
      (r) => r.otherRefNum === o.name && r.externalId !== `shopify-${o.legacyResourceId}`,
    );
    if (ref) {
      const pattern = (ref.externalId ?? '(none)')
        .replace(o.legacyResourceId, '{order id}')
        .replace(o.name.replace(/^#/, ''), '{order number}');
      other.set(pattern, [...(other.get(pattern) ?? []), { name: o.name, at: o.createdAt }]);
    }
  }
  const candidates: Candidate[] = [];
  if (signature.length) {
    const coverage = signature.length / orders.length;
    const confidence = confidenceOf(signature.length, orders.length);
    candidates.push({
      id: 'adopted.shopify_erp_order_sync',
      kind: 'adoptable',
      title: 'Shopify orders → NetSuite sales orders',
      summary: `${signature.length} of your last ${orders.length} Shopify orders are in NetSuite, written the way the shopify-erp-order-sync integration writes them.`,
      implementation: 'shopify-erp-order-sync',
      confidence,
      evidence: {
        signature: 'externalId "shopify-<order id>" and order number as reference',
        matched: signature.length,
        sampled: orders.length,
        coverage: Math.round(coverage * 1000) / 1000,
        firstSeen: signature.map((x) => x.at).sort()[0],
        lastSeen: signature
          .map((x) => x.at)
          .sort()
          .pop(),
        examples: signature.slice(-3).map((x) => x.name),
      },
    });
  }
  for (const [pattern, list] of other) {
    candidates.push({
      id: `unrecognized:${pattern}`,
      kind: 'unsupported',
      title: 'Shopify orders → NetSuite sales orders (another integration)',
      summary: `${list.length} of your last ${orders.length} Shopify orders are in NetSuite, written by an integration we do not recognize.`,
      implementation: null,
      confidence: null,
      evidence: {
        externalIdPattern: pattern,
        matched: list.length,
        sampled: orders.length,
        examples: list.slice(-3).map((x) => x.name),
      },
    });
  }
  const outcome = discoveryOutcome(candidates);
  return {
    ...base,
    outcome,
    sampled: orders.length,
    candidates: outcome === 'found' ? candidates : [...candidates, NEW_CANDIDATE],
  };
}

/* ================================================================== protect */

const SUBSCRIBE = /* GraphQL */ `
  mutation Subscribe($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
      webhookSubscription {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export interface ShopifyOnboardingDeps {
  cipher: CredentialCipher;
  endpoints: ProviderEndpointConfig;
  webhookBaseUrl: string;
  enqueueReconciliation: (runId: string) => Promise<void>;
  retry?: RetryPolicy;
}

/** Starts a reconciliation of a window, or waits while another one runs. */
async function startCheck(
  ctx: StepContext,
  window: { from: Date; to: Date },
  deps: ShopifyOnboardingDeps,
): Promise<StepResult> {
  try {
    const s = await startReconciliation(ctx.db, {
      integrationId: ctx.integrationId,
      trigger: 'manual',
      requestedBy: 'system:onboarding',
      window,
    });
    await ctx.save({
      runId: s.runId,
      at: new Date().toISOString(),
      attempts: ((ctx.record?.['attempts'] as number) ?? 0) + 1,
    });
    await deps.enqueueReconciliation(s.runId);
    return { state: 'continue', detail: 'check started' };
  } catch (err) {
    if (err instanceof ReconciliationBusy)
      return { state: 'wait', detail: 'another reconciliation is running' };
    throw err;
  }
}

/** Waits for a check to complete; retries an incomplete one up to 3 times. */
async function awaitCheck(
  ctx: StepContext,
  name: string,
): Promise<StepResult | typeof reconciliationRuns.$inferSelect> {
  const [run] = await ctx.db
    .select()
    .from(reconciliationRuns)
    .where(eq(reconciliationRuns.id, String(ctx.record!['runId'])));
  if (!run || run.status === 'running') return { state: 'wait', detail: `${name} running` };
  if (run.status !== 'completed' || run.outcome === 'partial') {
    if (((ctx.record!['attempts'] as number) ?? 1) >= 3)
      return {
        state: 'blocked',
        detail: `${name} incomplete`,
        problem: 'We could not complete the first full check of your orders. We are looking into it.',
      };
    await ctx.save({ attempts: ctx.record!['attempts'] });
    return { state: 'wait', detail: `${name} incomplete; retrying` };
  }
  return run;
}

export function shopifyActivationSteps(deps: ShopifyOnboardingDeps): ActivationStep[] {
  const clients = (ctx: StepContext) => tenantClients(ctx.db, deps.cipher, deps.endpoints, ctx.tenantId);
  return [
    {
      key: 'webhook',
      label: 'New Shopify orders come to us',
      // Route new-order notifications to our service (Shopify Admin API, app-owned subscription).
      async run(ctx) {
        const callbackUrl = `${deps.webhookBaseUrl.replace(/\/$/, '')}/webhooks/shopify/${ctx.integrationId}`;
        const c = await clients(ctx);
        const res = await withRetry(
          () =>
            c.shopify.graphql(SUBSCRIBE, { topic: 'ORDERS_CREATE', sub: { callbackUrl, format: 'JSON' } }),
          deps.retry ?? DEFAULT_RETRY,
        );
        const out = (
          res.data as {
            webhookSubscriptionCreate: {
              webhookSubscription: { id: string } | null;
              userErrors: { message: string }[];
            };
          }
        ).webhookSubscriptionCreate;
        const taken = out.userErrors.some((e) => /already been taken/i.test(e.message));
        if (!out.webhookSubscription && !taken)
          return {
            state: 'blocked',
            detail: 'webhook registration refused',
            problem: `Shopify did not accept our order notification: ${out.userErrors.map((e) => e.message).join('; ')}`,
          };
        return {
          state: 'done',
          detail: 'webhook registered',
          record: {
            subscriptionId: out.webhookSubscription?.id ?? null,
            callbackUrl,
            at: new Date().toISOString(),
            existing: taken,
          },
        };
      },
    },
    {
      key: 'baseline',
      label: 'Every recent order checked against NetSuite',
      // Reconcile the discovered window with the existing reconciliation.
      async run(ctx) {
        if (!ctx.record?.['runId']) {
          const from = new Date(ctx.confirmation.coverFrom);
          return startCheck(
            ctx,
            { from, to: new Date(Math.max(from.getTime(), Date.now() - GRACE_MS)) },
            deps,
          );
        }
        const run = await awaitCheck(ctx, 'baseline');
        if ('state' in run) return run;
        return { state: 'done', detail: 'baseline complete', record: { ...ctx.record } };
      },
    },
    {
      key: 'history',
      label: 'Earlier orders recorded as history',
      // Orders the existing deployment already wrote carry exactly the adopted implementation's signature in
      // NetSuite (classified "exists, untracked"). Record them as delivered history, with their provenance, so
      // later checks account for them — nothing is written to NetSuite.
      async run(ctx) {
        const runId = String(ctx.records['baseline']!['runId']);
        const items = await ctx.db
          .select()
          .from(reconciliationItems)
          .where(
            and(
              eq(reconciliationItems.runId, runId),
              eq(reconciliationItems.classification, 'destination_exists_untracked'),
            ),
          );
        let adopted = 0;
        for (const it of items) {
          const inserted = await ctx.db
            .insert(deliveries)
            .values({
              integrationId: ctx.integrationId,
              idempotencyKey: `${ctx.integrationId}:${it.sourceOrderId}`,
              sourceId: it.sourceOrderId,
              sourceLegacyId: it.sourceLegacyId,
              sourceName: it.orderName,
              sourceCreatedAt: it.sourceCreatedAt,
              sourceUpdatedAt: it.sourceCreatedAt,
              latestSourceUpdatedAt: it.sourceCreatedAt,
              externalId: `shopify-${it.sourceLegacyId}`,
              destinationId: it.destinationIds?.[0] ?? null,
              outcome: 'delivered',
              attempts: 0,
              validation: {
                origin: 'baseline',
                note: 'Written by the customer’s existing deployment before we took over',
                runId,
              },
            })
            .onConflictDoNothing()
            .returning({ id: deliveries.id });
          adopted += inserted.length;
        }
        return {
          state: 'done',
          detail: `${adopted} earlier order(s) recorded as history`,
          record: { adopted, at: new Date().toISOString() },
        };
      },
    },
    {
      key: 'verify',
      label: 'Independent second check',
      async run(ctx) {
        if (!ctx.record?.['runId']) {
          const [run] = await ctx.db
            .select()
            .from(reconciliationRuns)
            .where(eq(reconciliationRuns.id, String(ctx.records['baseline']!['runId'])));
          return startCheck(ctx, { from: run!.windowFrom, to: run!.windowTo }, deps);
        }
        const run = await awaitCheck(ctx, 'verification check');
        if ('state' in run) return run;
        return { state: 'done', detail: 'verified', record: { ...ctx.record } };
      },
    },
  ];
}

export function shopifyOnboarding(deps: ShopifyOnboardingDeps): OnboardingImplementation {
  return {
    descriptor: SHOPIFY_NETSUITE,
    async discover(db, tenantId, opts) {
      const clients = await tenantClients(db, deps.cipher, deps.endpoints, tenantId);
      return discoverIntegration(db, clients, tenantId, {
        ...opts,
        ...(deps.retry ? { retry: deps.retry } : {}),
      });
    },
    ensureContract: registerAdoptedContract,
    integrationValues: (_c, coverFrom) => ({
      displayName: SHOPIFY_NETSUITE.name,
      contractVersion: ADOPTED_CONTRACT.version,
      // The adopted code's own defaults; the customer can change them in Settings later.
      config: {
        erp: 'netsuite',
        customerByEmail: {},
        defaultCustomer: 'WEB',
        reconcileFrom: coverFrom,
        reconcileGraceMinutes: 10,
      },
    }),
    steps: shopifyActivationSteps(deps),
    baselineResult: baselineResultOf,
  };
}

/** What the baseline established, from the independent check. */
async function baselineResultOf(db: Db, records: Record<string, Record<string, unknown>>) {
  const [check] = await db
    .select()
    .from(reconciliationRuns)
    .where(eq(reconciliationRuns.id, String(records['verify']!['runId'])));
  return {
    checked: check!.expectedCount ?? check!.sourceCount,
    accountedFor: check!.matchedCount,
    previouslyDelivered: (records['history']?.['adopted'] as number | undefined) ?? 0,
    missing: (check!.missing as unknown[] | null)?.length ?? 0,
    unresolved: (check!.unresolved as unknown[] | null)?.length ?? 0,
    outcome: check!.outcome,
    verifyRunId: check!.id,
  };
}

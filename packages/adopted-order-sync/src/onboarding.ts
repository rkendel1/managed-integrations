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
import { and, eq, inArray } from 'drizzle-orm';
import {
  auditLog,
  connections,
  deliveries,
  integrations,
  onboardings,
  reconciliationItems,
  reconciliationRuns,
  type Db,
} from '@mi/database';
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
import { describeError } from '@mi/observability';
import { readDestination, type SourceIdentity } from '@mi/reliability';
import { ADOPTED_CONTRACT, ADOPTED_FLOW_TYPE, registerAdoptedContract } from './contract.ts';
import { ReconciliationBusy, startReconciliation, type AdoptedClients } from './reconcile.ts';
import { DISCOVERY_QUERY, discoveryFilter, type DiscoveredOrder } from './source.ts';

export const ONBOARDING_STATUSES = [
  'connect',
  'discovering',
  'confirm',
  'select',
  'activating',
  'managed',
  'blocked',
] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

/** What the customer authorizes when they confirm (versioned: the confirmation records the version). */
export const RESPONSIBILITIES = {
  version: 'r1',
  maintain: [
    'Run your Shopify → NetSuite order integration for you: the same software you run today, pinned to a known version.',
    'Receive Shopify’s new-order notifications at our service and create each order in NetSuite exactly once.',
    'Check Shopify and NetSuite against each other and recover orders that never arrived.',
    'Adapt the integration when Shopify or NetSuite change, verify the result, and tell you what happened.',
  ],
  access: [
    'Shopify: read your orders, and register a new-order notification for our service.',
    'NetSuite: create sales orders; read customers, items and sales orders.',
  ],
  verify: [
    'Every Shopify order is in NetSuite exactly once, with the same items, quantities and prices.',
    'Orders that never reached NetSuite are found by comparing both systems.',
  ],
} as const;

const DISCOVERY_DAYS = 30;
const GRACE_MS = 10 * 60_000;
const SAMPLE_LIMIT = 100;

export interface Candidate {
  id: string;
  kind: 'adoptable' | 'unsupported' | 'new';
  title: string;
  /** Plain-language finding for the customer. */
  summary: string;
  implementation: string | null;
  confidence: 'established' | 'partial' | null;
  evidence: Record<string, unknown>;
}
export interface Discovery {
  at: string;
  outcome: 'found' | 'ambiguous' | 'unsupported' | 'not_found' | 'insufficient_evidence' | 'already_managed';
  window: { from: string; to: string };
  sampled: number;
  candidates: Candidate[];
}

const NEW_CANDIDATE: Candidate = {
  id: 'new.shopify_orders_netsuite',
  kind: 'new',
  title: 'Shopify orders → NetSuite sales orders',
  summary: 'We run a managed Shopify → NetSuite order integration for you, starting now.',
  implementation: 'shopify-erp-order-sync',
  confidence: null,
  evidence: {},
};

async function ready(db: Db, tenantId: string) {
  const rows = await db
    .select()
    .from(connections)
    .where(and(eq(connections.tenantId, tenantId), inArray(connections.providerId, ['shopify', 'netsuite'])));
  const ok = (p: string) =>
    rows.some(
      (c) => c.providerId === p && ['authorized', 'verified'].includes(c.status) && !!c.credentialsCiphertext,
    );
  return { shopify: ok('shopify'), netsuite: ok('netsuite'), rows };
}

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

export class OnboardingError extends Error {}

export async function getOnboarding(db: Db, tenantId: string) {
  // Tenants that already have an active integration (enrolled before self-service onboarding) are managed.
  const [active] = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(and(eq(integrations.tenantId, tenantId), eq(integrations.lifecycle, 'active')))
    .limit(1);
  await db
    .insert(onboardings)
    .values({ tenantId, status: active ? 'managed' : 'connect', integrationId: active?.id ?? null })
    .onConflictDoNothing();
  const [row] = await db.select().from(onboardings).where(eq(onboardings.tenantId, tenantId));
  return row!;
}

async function setOnboarding(db: Db, tenantId: string, set: Partial<typeof onboardings.$inferInsert>) {
  const [row] = await db
    .update(onboardings)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(onboardings.tenantId, tenantId))
    .returning();
  return row!;
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
    const confidence = coverage >= 0.8 && signature.length >= 3 ? 'established' : 'partial';
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
  const adoptable = candidates.filter((c) => c.kind === 'adoptable');
  const unsupported = candidates.filter((c) => c.kind === 'unsupported');
  const outcome: Discovery['outcome'] =
    adoptable.length && !unsupported.length
      ? 'found'
      : adoptable.length
        ? 'ambiguous'
        : unsupported.length
          ? 'unsupported'
          : 'not_found';
  return {
    ...base,
    outcome,
    sampled: orders.length,
    candidates: outcome === 'found' ? candidates : [...candidates, NEW_CANDIDATE],
  };
}

/** Runs discovery for a tenant and records the result (resumable). */
export async function runDiscovery(
  db: Db,
  cipher: CredentialCipher,
  endpoints: ProviderEndpointConfig,
  tenantId: string,
  opts: { now?: Date; retry?: RetryPolicy } = {},
) {
  const ob = await getOnboarding(db, tenantId);
  if (ob.status === 'activating' || ob.status === 'managed') return ob;
  const r = await ready(db, tenantId);
  if (!r.shopify || !r.netsuite) return setOnboarding(db, tenantId, { status: 'connect', problem: null });
  await setOnboarding(db, tenantId, { status: 'discovering', problem: null });
  try {
    const clients = await tenantClients(db, cipher, endpoints, tenantId);
    const discovery = await discoverIntegration(db, clients, tenantId, opts);
    const status: OnboardingStatus =
      discovery.outcome === 'already_managed'
        ? 'managed'
        : discovery.outcome === 'found'
          ? 'confirm'
          : 'select';
    return setOnboarding(db, tenantId, { status, discovery });
  } catch (err) {
    return setOnboarding(db, tenantId, {
      status: 'blocked',
      problem: `We could not read your systems to look for the integration (${describeError(err).message}). Check the connections and try again.`,
    });
  }
}

/* ================================================================== confirm */

export async function confirmOnboarding(
  db: Db,
  tenantId: string,
  p: { candidateId: string; responsibilitiesVersion: string; userId: string },
) {
  const ob = await getOnboarding(db, tenantId);
  if (ob.status !== 'confirm' && ob.status !== 'select')
    throw new OnboardingError(`Nothing to confirm (onboarding is ${ob.status})`);
  if (p.responsibilitiesVersion !== RESPONSIBILITIES.version)
    throw new OnboardingError('The responsibilities changed; review them again');
  const discovery = ob.discovery as Discovery;
  const c = discovery.candidates.find((x) => x.id === p.candidateId);
  if (!c) throw new OnboardingError('Unknown choice');
  if (c.kind === 'unsupported')
    throw new OnboardingError(
      'We cannot take over that integration’s software; choose the managed integration instead',
    );
  await registerAdoptedContract(db);
  // Adopting an existing integration covers its recent history; a NEW integration starts now
  // (orders from before it existed are not "missing", and are not sent without the customer asking).
  const from = c.kind === 'new' ? new Date().toISOString() : discovery.window.from;
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(onboardings)
      .where(eq(onboardings.tenantId, tenantId))
      .for('update');
    if (locked!.integrationId) throw new OnboardingError('Already confirmed');
    const [integ] = await tx
      .insert(integrations)
      .values({
        tenantId,
        flowType: ADOPTED_FLOW_TYPE,
        displayName: 'Shopify → NetSuite orders',
        contractVersion: ADOPTED_CONTRACT.version,
        // The adopted code's own defaults; the customer can change them in Settings later.
        config: {
          erp: 'netsuite',
          customerByEmail: {},
          defaultCustomer: 'WEB',
          reconcileFrom: from,
          reconcileGraceMinutes: 10,
        },
        enabled: true,
        lifecycle: 'setup',
      })
      .returning();
    const confirmation = {
      candidateId: c.id,
      kind: c.kind,
      implementation: c.implementation,
      coverFrom: from,
      responsibilitiesVersion: RESPONSIBILITIES.version,
      responsibilities: RESPONSIBILITIES,
      by: p.userId,
      at: new Date().toISOString(),
    };
    await tx
      .update(onboardings)
      .set({
        status: 'activating',
        confirmation,
        integrationId: integ!.id,
        activation: { steps: {} },
        problem: null,
        updatedAt: new Date(),
      })
      .where(eq(onboardings.tenantId, tenantId));
    await tx.insert(auditLog).values({
      actorUserId: p.userId,
      actorRole: 'customer',
      action: 'onboarding.confirmed',
      targetType: 'integration',
      targetId: integ!.id,
      details: { candidateId: c.id, responsibilitiesVersion: RESPONSIBILITIES.version },
    });
    return integ!;
  });
}

/* ================================================================== protect */

interface ActivationSteps {
  webhook?: { subscriptionId: string | null; callbackUrl: string; at: string; existing: boolean };
  baseline?: { runId: string; at: string; attempts: number };
  /** Orders the customer's existing deployment had already written, recorded as delivered history. */
  history?: { adopted: number; at: string };
  verify?: { runId: string; at: string; attempts: number };
  baselineResult?: {
    checked: number | null;
    accountedFor: number | null;
    previouslyDelivered: number;
    missing: number;
    unresolved: number;
    outcome: string | null;
    verifyRunId: string;
  };
}
export type OnboardingAdvance = { state: 'continue' | 'wait' | 'done' | 'blocked' | 'noop'; detail: string };

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

/** Advances activation by one step; idempotent and resumable. */
export async function advanceOnboarding(p: {
  db: Db;
  tenantId: string;
  clients: AdoptedClients;
  webhookBaseUrl: string;
  enqueueReconciliation: (runId: string) => Promise<void>;
  retry?: RetryPolicy;
}): Promise<OnboardingAdvance> {
  const { db } = p;
  const ob = await getOnboarding(db, p.tenantId);
  if (ob.status !== 'activating' || !ob.integrationId) return { state: 'noop', detail: ob.status };
  const steps = ((ob.activation as { steps?: ActivationSteps } | null)?.steps ?? {}) as ActivationSteps;
  const save = (next: ActivationSteps) => setOnboarding(db, p.tenantId, { activation: { steps: next } });

  // 1. Route new-order notifications to our service (Shopify Admin API, app-owned subscription).
  if (!steps.webhook) {
    const callbackUrl = `${p.webhookBaseUrl.replace(/\/$/, '')}/webhooks/shopify/${ob.integrationId}`;
    const res = await withRetry(
      () =>
        p.clients.shopify.graphql(SUBSCRIBE, {
          topic: 'ORDERS_CREATE',
          sub: { callbackUrl, format: 'JSON' },
        }),
      p.retry ?? DEFAULT_RETRY,
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
    if (!out.webhookSubscription && !taken) {
      await setOnboarding(db, p.tenantId, {
        status: 'blocked',
        problem: `Shopify did not accept our order notification: ${out.userErrors.map((e) => e.message).join('; ')}`,
      });
      return { state: 'blocked', detail: 'webhook registration refused' };
    }
    await save({
      ...steps,
      webhook: {
        subscriptionId: out.webhookSubscription?.id ?? null,
        callbackUrl,
        at: new Date().toISOString(),
        existing: taken,
      },
    });
    return { state: 'continue', detail: 'webhook registered' };
  }

  // 2. Baseline: reconcile the discovered window with the existing reconciliation.
  if (!steps.baseline) {
    const from = new Date((ob.confirmation as { coverFrom: string }).coverFrom);
    try {
      const s = await startReconciliation(db, {
        integrationId: ob.integrationId,
        trigger: 'manual',
        requestedBy: 'system:onboarding',
        window: { from, to: new Date(Math.max(from.getTime(), Date.now() - GRACE_MS)) },
      });
      await save({ ...steps, baseline: { runId: s.runId, at: new Date().toISOString(), attempts: 1 } });
      await p.enqueueReconciliation(s.runId);
      return { state: 'continue', detail: 'baseline started' };
    } catch (err) {
      if (err instanceof ReconciliationBusy)
        return { state: 'wait', detail: 'another reconciliation is running' };
      throw err;
    }
  }
  const [run] = await db
    .select()
    .from(reconciliationRuns)
    .where(eq(reconciliationRuns.id, steps.baseline.runId));
  if (!run || run.status === 'running') return { state: 'wait', detail: 'baseline running' };
  if (run.status !== 'completed' || run.outcome === 'partial') {
    if (steps.baseline.attempts >= 3) {
      await setOnboarding(db, p.tenantId, {
        status: 'blocked',
        problem: 'We could not complete the first full check of your orders. We are looking into it.',
      });
      return { state: 'blocked', detail: 'baseline incomplete' };
    }
    await save({ ...steps, baseline: undefined as never });
    return { state: 'wait', detail: 'baseline incomplete; retrying' };
  }

  // 3. History: orders the existing deployment already wrote carry exactly the adopted implementation's
  //    signature in NetSuite (classified "exists, untracked"). Record them as delivered history, with
  //    their provenance, so later checks account for them — nothing is written to NetSuite.
  if (!steps.history) {
    const items = await db
      .select()
      .from(reconciliationItems)
      .where(
        and(
          eq(reconciliationItems.runId, run.id),
          eq(reconciliationItems.classification, 'destination_exists_untracked'),
        ),
      );
    let adopted = 0;
    for (const it of items) {
      const inserted = await db
        .insert(deliveries)
        .values({
          integrationId: ob.integrationId,
          idempotencyKey: `${ob.integrationId}:${it.sourceOrderId}`,
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
            runId: run.id,
          },
        })
        .onConflictDoNothing()
        .returning({ id: deliveries.id });
      adopted += inserted.length;
    }
    await save({ ...steps, history: { adopted, at: new Date().toISOString() } });
    return { state: 'continue', detail: `${adopted} earlier order(s) recorded as history` };
  }

  // 4. Independent check of the same window, now that history is recorded.
  if (!steps.verify) {
    try {
      const s = await startReconciliation(db, {
        integrationId: ob.integrationId,
        trigger: 'manual',
        requestedBy: 'system:onboarding',
        window: { from: run.windowFrom, to: run.windowTo },
      });
      await save({ ...steps, verify: { runId: s.runId, at: new Date().toISOString(), attempts: 1 } });
      await p.enqueueReconciliation(s.runId);
      return { state: 'continue', detail: 'verification check started' };
    } catch (err) {
      if (err instanceof ReconciliationBusy)
        return { state: 'wait', detail: 'another reconciliation is running' };
      throw err;
    }
  }
  const [check] = await db
    .select()
    .from(reconciliationRuns)
    .where(eq(reconciliationRuns.id, steps.verify.runId));
  if (!check || check.status === 'running') return { state: 'wait', detail: 'verification check running' };
  if (check.status !== 'completed' || check.outcome === 'partial') {
    if (steps.verify.attempts >= 3) {
      await setOnboarding(db, p.tenantId, {
        status: 'blocked',
        problem: 'We could not complete the first full check of your orders. We are looking into it.',
      });
      return { state: 'blocked', detail: 'verification incomplete' };
    }
    await save({ ...steps, verify: undefined as never });
    return { state: 'wait', detail: 'verification incomplete; retrying' };
  }

  // 5. Managed: prerequisites are all durable facts now (authorization, identity, notification, baseline).
  const baselineResult = {
    checked: check.expectedCount ?? check.sourceCount,
    accountedFor: check.matchedCount,
    previouslyDelivered: steps.history.adopted,
    missing: (check.missing as unknown[] | null)?.length ?? 0,
    unresolved: (check.unresolved as unknown[] | null)?.length ?? 0,
    outcome: check.outcome,
    verifyRunId: check.id,
  };
  await db.transaction(async (tx) => {
    await tx
      .update(integrations)
      .set({ lifecycle: 'active', updatedAt: new Date() })
      .where(eq(integrations.id, ob.integrationId!));
    await tx
      .update(onboardings)
      .set({
        status: 'managed',
        activation: { steps: { ...steps, baselineResult } },
        problem: null,
        updatedAt: new Date(),
      })
      .where(eq(onboardings.tenantId, p.tenantId));
    await tx.insert(auditLog).values({
      actorRole: 'system',
      action: 'onboarding.managed',
      targetType: 'integration',
      targetId: ob.integrationId!,
      details: { baselineResult, webhook: steps.webhook },
    });
  });
  return { state: 'done', detail: 'managed' };
}

/** Tenants whose activation should be (re)driven (crash safety: the worker tick picks them up). */
export async function onboardingsActivating(db: Db): Promise<string[]> {
  const rows = await db
    .select({ t: onboardings.tenantId })
    .from(onboardings)
    .where(eq(onboardings.status, 'activating'));
  return rows.map((r) => r.t);
}

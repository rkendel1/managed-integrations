/**
 * Customer API. Every response is derived from durable state and is customer-safe: no secrets,
 * no internal shell output, no agent transcripts, no raw provider traces.
 */
import { and, desc, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IntegrationConfigSchema, QUEUES, type IntegrationContractDefinition } from '@mi/contracts';
import {
  auditLog,
  connections,
  deliveries,
  incidentEvents,
  incidents,
  integrationContracts,
  integrations,
  onboardings,
  reconciliationRuns,
  syncRuns,
} from '@mi/database';
import {
  buildShopifyAuthorizeUrl,
  ConnectionCredentials,
  exchangeShopifyCode,
  generateNetSuiteKeyPair,
  NetSuiteClient,
  randomToken,
  resolveNetSuiteBaseUrl,
  resolveShopifyBaseUrl,
  normalizeShopDomain,
  sha256Hex,
  ShopifyClient,
  sourceImplementation,
  verifyShopifyCallbackHmac,
} from '@mi/integration-shopify-netsuite';
import { ADOPTED_FLOW_TYPE, AdoptedConfigSchema } from '@mi/adopted-order-sync';
import { describeError } from '@mi/observability';
import { requireRole } from './auth.ts';
import type { ApiDeps } from './app.ts';

export function customerIncidentView(i: typeof incidents.$inferSelect) {
  return {
    id: i.id,
    kind: i.kind,
    status: i.status,
    severity: i.severity,
    title: i.title,
    summary: i.customerSummary,
    impact: i.impact,
    customerAction: i.status === 'resolved' ? null : i.customerAction,
    affectedOrderCount: (i.affectedScope as { affectedOrderCount?: number })?.affectedOrderCount ?? null,
    detectedAt: i.detectedAt,
    resolvedAt: i.resolvedAt,
    resolution: i.resolution,
  };
}

export async function registerCustomerRoutes(app: FastifyInstance, deps: ApiDeps) {
  const { db } = deps;
  const auth = requireRole(db, 'customer');
  const creds = () => new ConnectionCredentials(db, deps.config.cipher!, deps.config.endpoints);
  const tenantIntegration = async (tenantId: string) =>
    (await db.select().from(integrations).where(eq(integrations.tenantId, tenantId)))[0];
  const audit = (
    userId: string,
    action: string,
    targetType: string,
    targetId: string | null,
    details: object = {},
  ) =>
    db
      .insert(auditLog)
      .values({ actorUserId: userId, actorRole: 'customer', action, targetType, targetId, details });

  app.get('/api/customer/overview', { preHandler: auth }, async (req) => {
    const tenantId = req.user!.tenantId!;
    const integ = await tenantIntegration(tenantId);
    const conns = await db.select().from(connections).where(eq(connections.tenantId, tenantId));
    const open = integ
      ? await db
          .select()
          .from(incidents)
          .where(and(eq(incidents.integrationId, integ.id), ne(incidents.status, 'resolved')))
          .orderBy(desc(incidents.detectedAt))
      : [];
    const [contract] = integ
      ? await db
          .select()
          .from(integrationContracts)
          .where(eq(integrationContracts.version, integ.contractVersion))
      : [];
    const freshness = (contract?.definition as IntegrationContractDefinition | undefined)?.freshness;
    const lagMinutes = integ?.lastSuccessfulSyncAt
      ? Math.round((Date.now() - integ.lastSuccessfulSyncAt.getTime()) / 60000)
      : null;
    const actions = [
      ...conns
        .filter((c) => c.status === 'revoked' || c.status === 'error' || c.status === 'pending')
        .map((c) => ({
          kind: 'connection',
          provider: c.providerId,
          message:
            c.status === 'pending' ? `Finish connecting ${c.providerId}.` : `Re-authorize ${c.providerId}.`,
        })),
      ...open
        .filter((i) => i.customerAction)
        .map((i) => ({ kind: 'incident', incidentId: i.id, message: i.customerAction! })),
    ];
    return {
      integration: integ
        ? {
            id: integ.id,
            enabled: integ.enabled,
            lifecycle: integ.lifecycle,
            health: integ.health,
            lastSuccessfulSyncAt: integ.lastSuccessfulSyncAt,
            backfillCompletedAt: integ.backfillCompletedAt,
          }
        : null,
      freshness: freshness
        ? {
            lagMinutes,
            commitmentMinutes: freshness.maxAcceptableDelayMinutes,
            withinCommitment: lagMinutes != null && lagMinutes <= freshness.maxAcceptableDelayMinutes,
          }
        : null,
      connections: conns.map((c) => ({ provider: c.providerId, status: c.status })),
      openIncidents: open.map(customerIncidentView),
      actionRequired: actions,
    };
  });

  /* ------------------------------ connections ------------------------------ */
  app.get('/api/customer/connections', { preHandler: auth }, async (req) => {
    const rows = await db.select().from(connections).where(eq(connections.tenantId, req.user!.tenantId!));
    return rows.map((c) => ({
      id: c.id,
      provider: c.providerId,
      status: c.status,
      account: c.externalAccount,
      scopes: c.grantedScopes,
      lastVerifiedAt: c.lastVerifiedAt,
      accessTokenExpiresAt: c.accessTokenExpiresAt,
      refreshTokenExpiresAt: c.refreshTokenExpiresAt,
      problem: c.verificationError,
      revokedAt: c.revokedAt,
    }));
  });

  app.post('/api/customer/connections/shopify/authorize', { preHandler: auth }, async (req, reply) => {
    const body = z.object({ shop: z.string().min(3).max(100) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'shop is required' });
    let domain: string, baseUrl: string;
    try {
      domain = normalizeShopDomain(body.data.shop);
      baseUrl = resolveShopifyBaseUrl(domain, deps.config.endpoints);
    } catch (err) {
      return reply.code(400).send({ error: describeError(err).message });
    }
    const state = randomToken(24);
    const tenantId = req.user!.tenantId!;
    const values = {
      status: 'pending',
      externalAccount: domain,
      baseUrl,
      oauthStateHash: sha256Hex(state),
      oauthStateExpiresAt: new Date(Date.now() + 10 * 60_000),
      updatedAt: new Date(),
    };
    await db
      .insert(connections)
      .values({ tenantId, providerId: 'shopify', ...values })
      .onConflictDoUpdate({ target: [connections.tenantId, connections.providerId], set: values });
    await audit(req.user!.id, 'connection.shopify.authorize_started', 'connection', null, { shop: domain });
    const redirectUri = `${deps.config.env.PUBLIC_BASE_URL}/api/oauth/shopify/callback`;
    return {
      url: buildShopifyAuthorizeUrl({
        baseUrl,
        clientId: deps.config.endpoints.shopifyClientId,
        redirectUri,
        state: `${tenantId}.${state}`,
      }),
    };
  });

  // OAuth callback: authenticated by the signed state + Shopify HMAC, not by session (top-level redirect).
  app.get('/api/oauth/shopify/callback', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const [tenantId, state] = String(q.state ?? '').split('.');
    // Back to onboarding while the customer is still setting up; otherwise to their connections.
    const fail = async (msg: string) => {
      const [ob] =
        tenantId && /^[0-9a-f-]{36}$/.test(tenantId)
          ? await db.select().from(onboardings).where(eq(onboardings.tenantId, tenantId))
          : [];
      return reply.redirect(
        `${ob && ob.status !== 'managed' ? '/app/welcome' : '/app/connections'}?error=${encodeURIComponent(msg)}`,
      );
    };
    if (!verifyShopifyCallbackHmac(q, deps.config.endpoints.shopifyClientSecret))
      return fail('Shopify signature check failed');
    if (!tenantId || !state || !/^[0-9a-f-]{36}$/.test(tenantId)) return fail('Invalid state');
    const [conn] = await db
      .select()
      .from(connections)
      .where(and(eq(connections.tenantId, tenantId), eq(connections.providerId, 'shopify')));
    if (
      !conn ||
      conn.oauthStateHash !== sha256Hex(state) ||
      !conn.oauthStateExpiresAt ||
      conn.oauthStateExpiresAt < new Date()
    )
      return fail('Authorization expired; start again');
    if (normalizeShopDomain(q.shop ?? '') !== conn.externalAccount) return fail('Shop mismatch');
    try {
      const tokens = await exchangeShopifyCode(conn.baseUrl!, deps.config.endpoints, String(q.code ?? ''));
      const scopes = tokens.scope
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!scopes.includes('read_orders')) return fail('read_orders scope was not granted');
      await db
        .update(connections)
        .set({
          status: 'authorized',
          grantedScopes: scopes,
          credentialsCiphertext: deps.config.cipher!.encrypt(tokens, `connection:${conn.id}`),
          credentialsKeyId: deps.config.cipher!.keyId,
          accessTokenExpiresAt: new Date(tokens.accessTokenExpiresAt),
          refreshTokenExpiresAt: new Date(tokens.refreshTokenExpiresAt),
          oauthStateHash: null,
          oauthStateExpiresAt: null,
          revokedAt: null,
          verificationError: null,
          updatedAt: new Date(),
        })
        .where(eq(connections.id, conn.id));
      await db.insert(auditLog).values({
        actorRole: 'customer',
        action: 'connection.shopify.authorized',
        targetType: 'connection',
        targetId: conn.id,
        details: { scopes },
      });
      // Back to onboarding if the customer is still setting up; otherwise to their connections.
      const [ob] = await db.select().from(onboardings).where(eq(onboardings.tenantId, tenantId));
      return reply.redirect(
        ob && ob.status !== 'managed'
          ? '/app/welcome?connected=shopify'
          : '/app/connections?connected=shopify',
      );
    } catch (err) {
      req.log.warn({ err: describeError(err) }, 'shopify code exchange failed');
      return fail('Shopify did not complete authorization');
    }
  });

  app.post('/api/customer/connections/netsuite', { preHandler: auth }, async (req, reply) => {
    const body = z
      .object({
        accountDomain: z.string().min(3).max(120),
        clientId: z.string().min(8).max(200),
        certificateId: z.string().min(4).max(200),
        /** Label only; derived from the account domain when omitted (never the other way round). */
        accountId: z.string().min(3).max(40).optional(),
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'accountDomain, clientId and certificateId are required' });
    let baseUrl: string;
    try {
      baseUrl = resolveNetSuiteBaseUrl(body.data.accountDomain, deps.config.endpoints);
    } catch (err) {
      return reply.code(400).send({ error: describeError(err).message });
    }
    const accountId =
      body.data.accountId ?? body.data.accountDomain.split('.')[0]!.toUpperCase().replace(/-/g, '_');
    const tenantId = req.user!.tenantId!;
    const [conn] = await db
      .insert(connections)
      .values({
        tenantId,
        providerId: 'netsuite',
        status: 'pending',
        externalAccount: accountId,
        baseUrl,
      })
      .onConflictDoUpdate({
        target: [connections.tenantId, connections.providerId],
        set: { status: 'pending', externalAccount: accountId, baseUrl, updatedAt: new Date() },
      })
      .returning();
    const kp = generateNetSuiteKeyPair();
    await db
      .update(connections)
      .set({
        credentialsCiphertext: deps.config.cipher!.encrypt(
          {
            clientId: body.data.clientId,
            certificateId: body.data.certificateId,
            privateKeyPem: kp.privateKeyPem,
            algorithm: 'PS256',
          },
          `connection:${conn!.id}`,
        ),
        credentialsKeyId: deps.config.cipher!.keyId,
        grantedScopes: ['rest_webservices'],
      })
      .where(eq(connections.id, conn!.id));
    await audit(req.user!.id, 'connection.netsuite.configured', 'connection', conn!.id, { accountId });
    // The public key is not secret: the customer's NetSuite admin maps a certificate for it.
    return {
      connectionId: conn!.id,
      publicKeyPem: kp.publicKeyPem,
      next: 'Create a certificate from this public key, upload it under OAuth 2.0 Client Credentials (M2M) Setup, then click Verify.',
    };
  });

  app.post('/api/customer/connections/:provider/verify', { preHandler: auth }, async (req, reply) => {
    const provider = (req.params as { provider: string }).provider;
    if (provider !== 'shopify' && provider !== 'netsuite')
      return reply.code(404).send({ error: 'unknown provider' });
    const c = creds();
    const row = await c.load(req.user!.tenantId!, provider);
    if (!row?.credentialsCiphertext) return reply.code(400).send({ error: 'Connection is not configured' });
    try {
      if (provider === 'shopify') {
        const client = new ShopifyClient({
          baseUrl: row.baseUrl!,
          apiVersion: sourceImplementation.shopifyApiVersion,
          auth: c.shopifyAuth(row),
          timeoutMs: 15_000,
        });
        await client.graphql('query { shop { name } }', {});
      } else {
        const client = new NetSuiteClient({
          baseUrl: row.baseUrl!,
          auth: c.netsuiteAuth(row),
          timeoutMs: 15_000,
        });
        await client.suiteqlPage(
          "SELECT t.id, t.externalid, t.otherrefnum, t.trandate FROM transaction t WHERE t.type = 'SalesOrd' AND t.externalid LIKE ? ORDER BY t.id",
          ['shopify-%'],
          1,
          0,
        );
      }
      await db
        .update(connections)
        .set({
          status: 'verified',
          lastVerifiedAt: new Date(),
          verificationError: null,
          revokedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(connections.id, row.id));
      return { status: 'verified' };
    } catch (err) {
      const msg = describeError(err).message;
      await db
        .update(connections)
        .set({ status: 'error', verificationError: msg.slice(0, 300), updatedAt: new Date() })
        .where(eq(connections.id, row.id));
      return reply.code(422).send({ status: 'error', error: msg });
    }
  });

  app.post('/api/customer/connections/:provider/disconnect', { preHandler: auth }, async (req, reply) => {
    const provider = (req.params as { provider: string }).provider;
    if (provider !== 'shopify' && provider !== 'netsuite')
      return reply.code(404).send({ error: 'unknown provider' });
    const rows = await db
      .update(connections)
      .set({
        status: 'disconnected',
        credentialsCiphertext: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(connections.tenantId, req.user!.tenantId!), eq(connections.providerId, provider)))
      .returning({ id: connections.id });
    await audit(req.user!.id, `connection.${provider}.disconnected`, 'connection', rows[0]?.id ?? null);
    return { status: 'disconnected' };
  });

  /* ------------------------------ integration ------------------------------ */
  app.get('/api/customer/integration', { preHandler: auth }, async (req, reply) => {
    const integ = await tenantIntegration(req.user!.tenantId!);
    if (!integ) return reply.code(404).send({ error: 'No integration' });
    if (integ.flowType === ADOPTED_FLOW_TYPE) {
      // Only what the customer decides. Internal configuration (compatibility rules, reconciliation window)
      // is operated by us and is not part of the customer's settings.
      const c = AdoptedConfigSchema.parse(integ.config);
      return {
        id: integ.id,
        kind: 'adopted',
        flow: 'Shopify orders → NetSuite sales orders',
        enabled: integ.enabled,
        settings: { defaultCustomer: c.defaultCustomer, customerByEmail: c.customerByEmail },
      };
    }
    const [contract] = await db
      .select()
      .from(integrationContracts)
      .where(eq(integrationContracts.version, integ.contractVersion));
    return {
      id: integ.id,
      flow: 'Shopify orders → NetSuite sales orders',
      enabled: integ.enabled,
      lifecycle: integ.lifecycle,
      health: integ.health,
      config: integ.config,
      contract: contract?.definition,
      contractVersion: integ.contractVersion,
      cursor: { watermark: integ.cursorWatermark, updatedAt: integ.cursorUpdatedAt },
      backfillCompletedAt: integ.backfillCompletedAt,
      lastSuccessfulSyncAt: integ.lastSuccessfulSyncAt,
    };
  });

  app.patch('/api/customer/integration', { preHandler: auth }, async (req, reply) => {
    const integ = await tenantIntegration(req.user!.tenantId!);
    if (!integ) return reply.code(404).send({ error: 'No integration' });
    if (integ.flowType === ADOPTED_FLOW_TYPE) {
      const adopted = z
        .object({
          enabled: z.boolean().optional(),
          settings: z
            .object({
              defaultCustomer: z.string().trim().min(1).max(100).optional(),
              customerByEmail: z.record(z.string().email(), z.string().trim().min(1).max(100)).optional(),
            })
            .strict()
            .optional(),
        })
        .strict()
        .safeParse(req.body);
      if (!adopted.success)
        return reply.code(400).send({ error: adopted.error.issues.map((i) => i.message).join('; ') });
      const s = adopted.data.settings;
      // Merge into the full configuration so internal fields (e.g. validated compatibility rules) are kept.
      const config = AdoptedConfigSchema.parse({
        ...(integ.config as object),
        ...(s?.defaultCustomer ? { defaultCustomer: s.defaultCustomer } : {}),
        ...(s?.customerByEmail
          ? {
              customerByEmail: Object.fromEntries(
                Object.entries(s.customerByEmail).map(([k, v]) => [k.toLowerCase(), v]),
              ),
            }
          : {}),
      });
      const [updated] = await db
        .update(integrations)
        .set({
          config,
          ...(s ? { configVersion: integ.configVersion + 1 } : {}),
          ...(adopted.data.enabled != null
            ? { enabled: adopted.data.enabled, lifecycle: adopted.data.enabled ? 'active' : 'paused' }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(integrations.id, integ.id))
        .returning();
      await audit(req.user!.id, 'integration.update', 'integration', integ.id, adopted.data);
      const c = AdoptedConfigSchema.parse(updated!.config);
      return {
        enabled: updated!.enabled,
        settings: { defaultCustomer: c.defaultCustomer, customerByEmail: c.customerByEmail },
      };
    }
    const body = z
      .object({
        enabled: z.boolean().optional(),
        config: IntegrationConfigSchema.partial()
          .pick({ skuMap: true, netsuiteCustomerId: true, netsuiteSubsidiaryId: true })
          .optional(),
      })
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: body.error.issues.map((i) => i.message).join('; ') });
    const config = IntegrationConfigSchema.parse({
      ...(integ.config as object),
      ...(body.data.config ?? {}),
    });
    const [updated] = await db
      .update(integrations)
      .set({
        config,
        ...(body.data.config ? { configVersion: integ.configVersion + 1 } : {}),
        ...(body.data.enabled != null
          ? { enabled: body.data.enabled, lifecycle: body.data.enabled ? 'active' : 'paused' }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, integ.id))
      .returning();
    await audit(req.user!.id, 'integration.update', 'integration', integ.id, body.data);
    // Rejected orders affected by a mapping change are re-attempted automatically.
    if (body.data.config?.skuMap) {
      const rejected = await db
        .select({ id: deliveries.sourceLegacyId })
        .from(deliveries)
        .where(and(eq(deliveries.integrationId, integ.id), eq(deliveries.outcome, 'rejected')));
      if (rejected.length)
        await deps.boss.send(QUEUES.sync, {
          integrationId: integ.id,
          trigger: 'recovery',
          mode: 'redelivery',
          sourceLegacyIds: rejected.map((r) => r.id).slice(0, 1000),
        });
    }
    return { enabled: updated!.enabled, config: updated!.config };
  });

  app.post('/api/customer/integration/sync', { preHandler: auth }, async (req, reply) => {
    const integ = await tenantIntegration(req.user!.tenantId!);
    if (!integ) return reply.code(404).send({ error: 'No integration' });
    const id = await deps.boss.send(
      QUEUES.sync,
      { integrationId: integ.id, trigger: 'manual', mode: 'auto' },
      { singletonKey: `sync:${integ.id}` },
    );
    return { queued: !!id };
  });

  /* ------------------------------ history & reliability ------------------------------ */
  app.get('/api/customer/sync-runs', { preHandler: auth }, async (req) => {
    const integ = await tenantIntegration(req.user!.tenantId!);
    if (!integ) return [];
    const rows = await db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.integrationId, integ.id))
      .orderBy(desc(syncRuns.createdAt))
      .limit(50);
    return rows.map((r) => ({
      id: r.id,
      mode: r.mode,
      status: r.status,
      trigger: r.trigger,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.startedAt && r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
      counts: {
        observed: r.observedCount,
        delivered: r.deliveredCount,
        alreadyDelivered: r.alreadyDeliveredCount,
        skipped: r.skippedCount,
        rejected: r.rejectedCount,
        failed: r.failedCount,
      },
      errorClass: r.errorClass,
    }));
  });

  app.get('/api/customer/sync-runs/:id', { preHandler: auth }, async (req, reply) => {
    const integ = await tenantIntegration(req.user!.tenantId!);
    const id = (req.params as { id: string }).id;
    if (!integ || !z.string().uuid().safeParse(id).success)
      return reply.code(404).send({ error: 'Not found' });
    const [run] = await db
      .select()
      .from(syncRuns)
      .where(and(eq(syncRuns.id, id), eq(syncRuns.integrationId, integ.id)));
    if (!run) return reply.code(404).send({ error: 'Not found' });
    const records = await db.select().from(deliveries).where(eq(deliveries.lastSyncRunId, run.id)).limit(500);
    return {
      id: run.id,
      mode: run.mode,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      cursorBefore: run.cursorBefore,
      cursorAfter: run.cursorAfter,
      pages: run.pagesFetched,
      counts: {
        observed: run.observedCount,
        delivered: run.deliveredCount,
        alreadyDelivered: run.alreadyDeliveredCount,
        skipped: run.skippedCount,
        rejected: run.rejectedCount,
        failed: run.failedCount,
      },
      error:
        run.status === 'failed'
          ? { class: run.errorClass, message: 'See incident details for status and next steps.' }
          : null,
      records: records.map((d) => ({
        order: d.sourceName,
        outcome: d.outcome,
        netsuiteId: d.destinationId,
        externalId: d.externalId,
        attempts: d.attempts,
        reason: d.outcome === 'rejected' ? d.lastError : null,
        deliveredAt: d.deliveredAt,
      })),
    };
  });

  app.get('/api/customer/reliability', { preHandler: auth }, async (req) => {
    const integ = await tenantIntegration(req.user!.tenantId!);
    if (!integ) return { reconciliations: [], deliveryTotals: {} };
    const recons = await db
      .select()
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.integrationId, integ.id))
      .orderBy(desc(reconciliationRuns.startedAt))
      .limit(20);
    const all = await db
      .select({ outcome: deliveries.outcome })
      .from(deliveries)
      .where(eq(deliveries.integrationId, integ.id));
    const totals: Record<string, number> = {};
    for (const d of all) totals[d.outcome] = (totals[d.outcome] ?? 0) + 1;
    return {
      deliveryTotals: totals,
      reconciliations: recons.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        outcome: r.outcome,
        status: r.status,
        window: { from: r.windowFrom, to: r.windowTo },
        expected: r.expectedCount,
        matched: r.matchedCount,
        missing: r.missing,
        duplicates: r.duplicates,
        inconsistent: r.inconsistent,
        stale: r.stale,
        unexpected: r.unexpected,
        unresolved: r.unresolved,
        recoveryEnqueued: r.recoveryEnqueued,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
      })),
    };
  });

  app.get('/api/customer/incidents', { preHandler: auth }, async (req) => {
    const rows = await db
      .select()
      .from(incidents)
      .where(eq(incidents.tenantId, req.user!.tenantId!))
      .orderBy(desc(incidents.detectedAt))
      .limit(100);
    return rows.map(customerIncidentView);
  });

  app.get('/api/customer/incidents/:id', { preHandler: auth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!z.string().uuid().safeParse(id).success) return reply.code(404).send({ error: 'Not found' });
    const [inc] = await db
      .select()
      .from(incidents)
      .where(and(eq(incidents.id, id), eq(incidents.tenantId, req.user!.tenantId!)));
    if (!inc) return reply.code(404).send({ error: 'Not found' });
    const events = await db
      .select()
      .from(incidentEvents)
      .where(and(eq(incidentEvents.incidentId, inc.id), eq(incidentEvents.customerVisible, true)))
      .orderBy(incidentEvents.createdAt);
    const affected = (
      (inc.affectedScope as { affectedOrders?: { name: string }[] })?.affectedOrders ?? []
    ).map((o) => o.name);
    const rejectedOrders = (
      (inc.affectedScope as { orders?: { name: string; reason: string }[] })?.orders ?? []
    ).map((o) => ({ order: o.name, reason: o.reason }));
    return {
      ...customerIncidentView(inc),
      affectedOrders: affected.slice(0, 200),
      rejectedOrders: rejectedOrders.slice(0, 200),
      verification: inc.status === 'resolved' ? inc.verification : null,
      timeline: events.map((e) => ({ at: e.createdAt, status: e.toStatus, note: e.note })),
    };
  });
}

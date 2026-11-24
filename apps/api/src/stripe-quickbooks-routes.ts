/**
 * Stripe → QuickBooks ingress (slice 6): the provider-specific edges only.
 *  - POST /webhooks/stripe/:integrationId — Stripe webhooks (raw body; Stripe-Signature with the per-endpoint
 *    secret), recorded durably, then executed on the shared queue;
 *  - POST /api/customer/connections/stripe — the customer's restricted key (proven with GET /v1/account);
 *  - POST /api/customer/connections/quickbooks/authorize, GET /api/oauth/quickbooks/callback — Intuit OAuth 2.0.
 * Onboarding, discovery, confirmation, monitoring and maintenance after connecting are the shared capabilities.
 */
import { and, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { QUEUES } from '@mi/contracts';
import {
  completeQboAuthorization,
  connectStripe,
  ingestStripeWebhook,
  qboAuthorizeUrl,
} from '@mi/adopted-ledgerly';
import { auditLog, connections, incidents, type Db } from '@mi/database';
import { randomToken, sha256Hex } from '@mi/integration-shopify-netsuite';
import { describeError } from '@mi/observability';
import { requireRole } from './auth.ts';
import type { ApiDeps } from './app.ts';
import { returnPage } from './customer-routes.ts';

/** After the customer re-authorizes, open reauthorization events of the tenant continue at once. */
async function resumeReauthorization(db: Db, deps: ApiDeps, tenantId: string) {
  const open = await db
    .select({ id: incidents.id })
    .from(incidents)
    .where(
      and(
        eq(incidents.tenantId, tenantId),
        eq(incidents.kind, 'connection_auth'),
        ne(incidents.status, 'resolved'),
      ),
    );
  for (const i of open)
    await deps.boss.send(
      QUEUES.adoptedMaintenance,
      { incidentId: i.id },
      { singletonKey: `adopted-maint:${i.id}` },
    );
}

export async function registerStripeQuickbooksRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const db = deps.db;
  const cipher = deps.config.cipher!;
  const endpoints = deps.config.endpoints;
  const auth = requireRole(db, 'customer');
  const audit = (userId: string, action: string, details: Record<string, unknown>) =>
    db
      .insert(auditLog)
      .values({ actorUserId: userId, actorRole: 'customer', action, targetType: 'connection', details });

  /* ------------------------------ webhooks (raw body) ------------------------------ */
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, body, done) =>
      done(null, body),
    );
    scope.post(
      '/webhooks/stripe/:integrationId',
      { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const params = z.object({ integrationId: z.string().uuid() }).safeParse(req.params);
        if (!params.success || !Buffer.isBuffer(req.body)) return reply.code(404).send();
        const result = await ingestStripeWebhook({
          db,
          cipher,
          integrationId: params.data.integrationId,
          rawBody: req.body,
          signature: req.headers['stripe-signature'] as string | undefined,
          correlationId: req.id,
        });
        if (result.execute && result.deliveryId)
          await deps.boss.send(
            QUEUES.adoptedExecute,
            { deliveryId: result.deliveryId, trigger: { kind: 'webhook' } },
            { singletonKey: `adopted:${result.deliveryId}` },
          );
        req.log.info(
          { disposition: result.disposition, deliveryId: result.deliveryId, status: result.httpStatus },
          'stripe webhook',
        );
        if (result.httpStatus !== 200) return reply.code(result.httpStatus).send({ error: result.error });
        return reply.code(200).send({ received: true, disposition: result.disposition });
      },
    );
  });

  /* ------------------------------ Stripe key ------------------------------ */
  app.post('/api/customer/connections/stripe', { preHandler: auth }, async (req, reply) => {
    const body = z
      .object({ apiKey: z.string().regex(/^(rk|sk)_(test|live)_[A-Za-z0-9]{8,200}$/) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'A Stripe restricted key (rk_…) is required' });
    try {
      const conn = await connectStripe(db, cipher, endpoints, req.user!.tenantId!, body.data.apiKey);
      await audit(req.user!.id, 'connection.stripe.verified', { account: conn.externalAccount });
      await resumeReauthorization(db, deps, req.user!.tenantId!);
      return { status: conn.status, account: conn.externalAccount };
    } catch (err) {
      return reply.code(400).send({ error: `Stripe did not accept the key: ${describeError(err).message}` });
    }
  });

  /* ------------------------------ QuickBooks OAuth 2.0 ------------------------------ */
  const redirectUri = () => `${deps.config.env.PUBLIC_BASE_URL}/api/oauth/quickbooks/callback`;
  app.post('/api/customer/connections/quickbooks/authorize', { preHandler: auth }, async (req) => {
    const tenantId = req.user!.tenantId!;
    const state = randomToken(24);
    const values = {
      oauthStateHash: sha256Hex(state),
      oauthStateExpiresAt: new Date(Date.now() + 10 * 60_000),
      updatedAt: new Date(),
    };
    await db
      .insert(connections)
      .values({ tenantId, providerId: 'quickbooks', status: 'pending', ...values })
      .onConflictDoUpdate({ target: [connections.tenantId, connections.providerId], set: values });
    await audit(req.user!.id, 'connection.quickbooks.authorize_started', {});
    return { url: qboAuthorizeUrl(endpoints, redirectUri(), `${tenantId}.${state}`) };
  });

  // Authenticated by the single-use state bound to the tenant's pending connection (top-level redirect).
  app.get('/api/oauth/quickbooks/callback', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const [tenantId, state] = String(q['state'] ?? '').split('.');
    const valid = !!tenantId && !!state && /^[0-9a-f-]{36}$/.test(tenantId);
    const fail = async (msg: string) =>
      reply.redirect(
        `${valid ? await returnPage(db, tenantId!) : '/app/connections'}?error=${encodeURIComponent(msg)}`,
      );
    if (!valid) return fail('Invalid state');
    const [conn] = await db
      .select()
      .from(connections)
      .where(and(eq(connections.tenantId, tenantId!), eq(connections.providerId, 'quickbooks')));
    if (
      !conn?.oauthStateHash ||
      conn.oauthStateHash !== sha256Hex(state!) ||
      (conn.oauthStateExpiresAt?.getTime() ?? 0) < Date.now()
    )
      return fail('The QuickBooks authorization request expired; start again');
    await db
      .update(connections)
      .set({ oauthStateHash: null, oauthStateExpiresAt: null })
      .where(eq(connections.id, conn.id));
    if (q['error'])
      return fail(
        q['error'] === 'access_denied' ? 'QuickBooks access was not granted' : `QuickBooks: ${q['error']}`,
      );
    if (!q['code'] || !q['realmId']) return fail('QuickBooks did not return an authorization');
    try {
      await completeQboAuthorization(db, cipher, endpoints, {
        tenantId: tenantId!,
        code: q['code'],
        realmId: q['realmId'],
        redirectUri: redirectUri(),
      });
    } catch (err) {
      return fail(`QuickBooks authorization failed: ${describeError(err).message}`);
    }
    await db.insert(auditLog).values({
      actorRole: 'customer',
      action: 'connection.quickbooks.authorized',
      targetType: 'connection',
      targetId: conn.id,
      details: { realmId: q['realmId'] },
    });
    await resumeReauthorization(db, deps, tenantId!);
    return reply.redirect(`${await returnPage(db, tenantId!)}?connected=quickbooks`);
  });
}

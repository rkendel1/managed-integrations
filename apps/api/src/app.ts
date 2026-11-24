import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { QUEUES } from '@mi/contracts';
import { createRegistry, type IntegrationRegistry } from '@mi/integrations';
import { discoverAll, type WorkServices } from '@mi/managed';
import { auditLogTelemetrySink } from '@mi/capabilities';
import { auditLog, tenants, users, type Db } from '@mi/database';
import type { ServiceConfig } from '@mi/integration-shopify-netsuite';
import { newCorrelationId, redact, withCorrelation } from '@mi/observability';
import {
  createSession,
  destroySession,
  hashPassword,
  loadSession,
  SESSION_COOKIE,
  verifyPassword,
} from './auth.ts';
import { registerAdoptedWebhookRoutes } from './adopted-webhook-routes.ts';
import { registerCustomerRoutes } from './customer-routes.ts';
import { registerStripeQuickbooksRoutes } from './stripe-quickbooks-routes.ts';
import { registerOperatorRoutes } from './operator-routes.ts';
import { registerAppPortRoutes } from './appport-routes.ts';
import { createApiAppPortRuntime, pinoToAppPortLogger } from './appport-runtime.ts';

export interface ApiDeps {
  db: Db;
  boss: PgBoss;
  config: ServiceConfig;
  /** Built web UI directory (served at /). */
  webDir?: string;
  logLevel?: string;
  /** Override the AppPort invocation evidence sink (tests). */
  invocationEvidence?: import('@appport/core').TelemetrySink;
  /** Override the integration registry (tests). */
  registry?: IntegrationRegistry;
}

export async function buildApp(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.logLevel ?? deps.config.env.LOG_LEVEL,
      redact: {
        paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'],
        censor: '[REDACTED]',
      },
      serializers: {
        req: (r) => ({
          method: r.method,
          url: String(redact(r.url)).replace(/([?&](code|hmac|state)=)[^&]+/g, '$1[REDACTED]'),
        }),
      },
    },
    genReqId: (req) =>
      typeof req.headers['x-request-id'] === 'string' && /^[\w-]{8,64}$/.test(req.headers['x-request-id'])
        ? req.headers['x-request-id']
        : newCorrelationId(),
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  app.addHook('onRequest', (req, reply, done) => {
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    withCorrelation({ correlationId: req.id }, () => done());
  });

  // Internal errors are never exposed to callers; they get a correlation id to quote.
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err: { name: err.name, message: String(redact(err.message)) } }, 'request failed');
      return reply.code(500).send({ error: 'Internal error', requestId: req.id });
    }
    return reply.code(status).send({ error: err.message });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await deps.db.execute(sql`select 1`);
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  /* ------------------------------ integrations (slice 6) ------------------------------ */
  // The same registry the worker uses; in the API it serves discovery, onboarding confirmation,
  // operator inspection and correction decisions. Durable work is only ever queued from here.
  const services: WorkServices = {
    enqueueExecution: async (deliveryId, trigger) => {
      await deps.boss.send(
        QUEUES.adoptedExecute,
        { deliveryId, trigger },
        { singletonKey: `adopted:${deliveryId}` },
      );
    },
    enqueueReconciliation: async (runId) => {
      await deps.boss.send(QUEUES.adoptedReconcile, { runId }, { singletonKey: `adopted-recon:${runId}` });
    },
    enqueueRecovery: async (itemId) => {
      await deps.boss.send(QUEUES.adoptedRecover, { itemId }, { singletonKey: `adopted-recover:${itemId}` });
    },
    enqueueMaintenance: async (incidentId) => {
      await deps.boss.send(
        QUEUES.adoptedMaintenance,
        { incidentId },
        { singletonKey: `adopted-maint:${incidentId}` },
      );
    },
  };
  const registry: IntegrationRegistry =
    deps.registry ??
    createRegistry({
      db: deps.db,
      cipher: deps.config.cipher!,
      endpoints: deps.config.endpoints,
      services,
      webhookBaseUrl: deps.config.env.WEBHOOK_BASE_URL ?? deps.config.env.PUBLIC_BASE_URL,
      workerId: 'api',
      reconcileIntervalMinutes: deps.config.env.RECONCILE_INTERVAL_MINUTES,
    });

  /* ------------------------------ AppPort: capabilities + MCP ------------------------------ */
  const appPort = createApiAppPortRuntime({
    registry,
    enqueueMaintenance: services.enqueueMaintenance,
    db: deps.db,
    logger: pinoToAppPortLogger({
      debug: (obj, msg) => app.log.debug(obj, msg),
      info: (obj, msg) => app.log.info(obj, msg),
      warn: (obj, msg) => app.log.warn(obj, msg),
      error: (obj, msg) => app.log.error(obj, msg),
    }),
    // Retry requests run through the same durable job the webhook path uses.
    enqueueDeliveryExecution: async (deliveryId, trigger) => {
      await deps.boss.send(
        QUEUES.adoptedExecute,
        { deliveryId, trigger },
        { singletonKey: `adopted:${deliveryId}` },
      );
    },
    enqueueReconciliationScan: async (runId) => {
      await deps.boss.send(QUEUES.adoptedReconcile, { runId }, { singletonKey: `adopted-recon:${runId}` });
    },
    reconcileIntervalMinutes: deps.config.env.RECONCILE_INTERVAL_MINUTES,
    runOnboardingDiscovery: async (tenantId) => {
      await discoverAll(deps.db, tenantId, registry.onboardable());
    },
    enqueueOnboardingActivation: async (tenantId, flowType) => {
      await deps.boss.send(
        QUEUES.onboardingActivate,
        { tenantId, flowType },
        { singletonKey: `onboarding:${tenantId}:${flowType}` },
      );
    },
    enqueueAdaptationValidation: async (adaptationId) => {
      await deps.boss.send(
        QUEUES.adoptedAdaptationValidate,
        { adaptationId },
        { singletonKey: `adaptation:${adaptationId}` },
      );
    },
    enqueueRecovery: async (itemId) => {
      await deps.boss.send(QUEUES.adoptedRecover, { itemId }, { singletonKey: `adopted-recover:${itemId}` });
    },
    telemetry:
      deps.invocationEvidence ??
      auditLogTelemetrySink(deps.db, (err) =>
        app.log.error({ err: String(err) }, 'invocation evidence write failed'),
      ),
  });
  registerAppPortRoutes(app, appPort);

  /* ------------------------------ auth ------------------------------ */
  const secureCookie = deps.config.production;
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = z
        .object({ email: z.string().email().max(200), password: z.string().min(1).max(200) })
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'email and password are required' });
      const [user] = await deps.db.select().from(users).where(eq(users.email, body.data.email.toLowerCase()));
      const ok = user ? await verifyPassword(body.data.password, user.passwordHash) : false;
      if (!user || !ok) return reply.code(401).send({ error: 'Invalid email or password' });
      const s = await createSession(deps.db, user.id);
      reply.setCookie(SESSION_COOKIE, s.token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookie,
        path: '/',
        expires: s.expiresAt,
      });
      return { user: { email: user.email, role: user.role }, csrfToken: s.csrfToken };
    },
  );
  // Self-service signup (slice 5): a new customer gets a tenant, a user and an onboarding, then connects.
  const signupAllowed = deps.config.env.ALLOW_SIGNUP
    ? deps.config.env.ALLOW_SIGNUP === 'true'
    : !deps.config.production;
  app.post(
    '/api/auth/signup',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!signupAllowed) return reply.code(404).send({ error: 'Not found' });
      const body = z
        .object({
          company: z.string().trim().min(2).max(120),
          email: z.string().email().max(200),
          password: z.string().min(12).max(200),
        })
        .safeParse(req.body);
      if (!body.success)
        return reply
          .code(400)
          .send({ error: 'Company, e-mail and a password of at least 12 characters are required' });
      const email = body.data.email.toLowerCase();
      const [exists] = await deps.db.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (exists)
        return reply.code(409).send({ error: 'An account with this e-mail already exists; sign in instead' });
      const base =
        body.data.company
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 40) || 'tenant';
      const passwordHash = await hashPassword(body.data.password);
      const user = await deps.db.transaction(async (tx) => {
        const [t] = await tx
          .insert(tenants)
          .values({
            name: body.data.company,
            slug: `${base}-${randomBytes(3).toString('hex')}`,
            lifecycle: 'active',
          })
          .returning();
        const [u] = await tx
          .insert(users)
          .values({ email, passwordHash, role: 'customer', tenantId: t!.id })
          .returning();
        await tx.insert(auditLog).values({
          actorUserId: u!.id,
          actorRole: 'customer',
          action: 'tenant.signup',
          targetType: 'tenant',
          targetId: t!.id,
          details: { company: body.data.company },
        });
        return u!;
      });
      const s = await createSession(deps.db, user.id);
      reply.setCookie(SESSION_COOKIE, s.token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookie,
        path: '/',
        expires: s.expiresAt,
      });
      return { user: { email: user.email, role: user.role }, csrfToken: s.csrfToken };
    },
  );
  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(deps.db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/api/auth/me', async (req, reply) => {
    const u = await loadSession(deps.db, req.cookies[SESSION_COOKIE]);
    if (!u) return reply.code(401).send({ error: 'Not authenticated' });
    return { user: { email: u.email, role: u.role }, csrfToken: u.csrfToken };
  });

  await registerAdoptedWebhookRoutes(app, deps);
  await registerCustomerRoutes(app, deps);
  await registerStripeQuickbooksRoutes(app, deps);
  await registerOperatorRoutes(app, deps);

  /* ------------------------------ web UI ------------------------------ */
  if (deps.webDir && existsSync(join(deps.webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: deps.webDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}

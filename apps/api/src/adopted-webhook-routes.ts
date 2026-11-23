/**
 * Provider webhook ingress for the ADOPTED Shopify → NetSuite executor. Authenticated by the
 * Shopify HMAC (verified by the upstream implementation inside `ingestShopifyWebhook`), not by a
 * user session. The raw body is required for HMAC verification, so this scope parses no JSON.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { QUEUES } from '@mi/contracts';
import { ingestShopifyWebhook } from '@mi/adopted-order-sync';
import type { ApiDeps } from './app.ts';

export async function registerAdoptedWebhookRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, body, done) =>
      done(null, body),
    );
    scope.post(
      '/webhooks/shopify/:integrationId',
      { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const params = z.object({ integrationId: z.string().uuid() }).safeParse(req.params);
        if (!params.success || !Buffer.isBuffer(req.body)) return reply.code(404).send();
        const result = await ingestShopifyWebhook({
          db: deps.db,
          cipher: deps.config.cipher!,
          integrationId: params.data.integrationId,
          rawBody: req.body,
          headers: req.headers,
          webhookSecret: deps.config.endpoints.shopifyClientSecret,
          correlationId: req.id,
        });
        if (result.execute && result.deliveryId) {
          await deps.boss.send(
            QUEUES.adoptedExecute,
            { deliveryId: result.deliveryId, trigger: { kind: 'webhook' } },
            { singletonKey: `adopted:${result.deliveryId}` },
          );
        }
        req.log.info(
          { disposition: result.disposition, deliveryId: result.deliveryId, status: result.httpStatus },
          'shopify webhook',
        );
        if (result.httpStatus !== 200) return reply.code(result.httpStatus).send({ error: result.error });
        return reply.code(200).send({ received: true, disposition: result.disposition });
      },
    );
  });
}

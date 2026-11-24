import express from 'express';
import { stripeRouter } from './routes/stripe';
import { stripeWebhookHandler } from './webhooks/stripeWebhook';

export function buildApp() {
  const app = express();

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Important: Stripe webhook route must use `express.raw(...)` BEFORE any json body parser.
  app.post('/v1/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

  // Default JSON parser for non-webhook routes (webhook route uses its own raw parser)
  app.use(express.json());

  app.use('/v1/stripe', stripeRouter);

  // Basic 404
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  // Basic error handler
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Avoid leaking internals; keep it production-ish
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}


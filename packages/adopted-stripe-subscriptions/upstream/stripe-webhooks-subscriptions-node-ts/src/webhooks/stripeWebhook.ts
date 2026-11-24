import type { RequestHandler } from 'express';
import Stripe from 'stripe';
import { env } from '../config/env';
import { prisma } from '../db/prisma';
import { stripe } from '../stripe/stripe';
import { processStripeEvent } from './stripeEventProcessor';

export const stripeWebhookHandler: RequestHandler = async (req, res) => {
  const signature = req.header('stripe-signature');
  if (!signature) return res.status(400).json({ error: 'Missing stripe-signature header' });

  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody)) return res.status(400).json({ error: 'Expected raw body' });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid Stripe signature' });
  }

  // Idempotency: store every event by its Stripe event id.
  // If Stripe retries delivery, we won't re-process already processed events.
  try {
    await prisma.stripeEvent.createMany({
      data: [
        {
          stripeEventId: event.id,
          type: event.type,
          livemode: event.livemode,
          payload: event as unknown as object
        }
      ],
      skipDuplicates: true
    });
  } catch (err) {
    // If we can't persist the event, we cannot guarantee idempotency.
    // Returning 500 will trigger Stripe retries.
    return res.status(500).json({ error: 'Failed to persist event' });
  }

  const existing = await prisma.stripeEvent.findUnique({
    where: { stripeEventId: event.id }
  });

  if (existing?.status === 'processed' || existing?.status === 'ignored') {
    return res.json({ received: true, deduped: true });
  }

  // Record attempt. If processing fails we return 500 so Stripe retries delivery.
  await prisma.stripeEvent.update({
    where: { stripeEventId: event.id },
    data: { attemptCount: { increment: 1 } }
  });

  try {
    const result = await processStripeEvent(event);

    await prisma.stripeEvent.update({
      where: { stripeEventId: event.id },
      data: {
        status: result.outcome === 'ignored' ? 'ignored' : 'processed',
        processedAt: new Date(),
        lastError: null
      }
    });

    return res.json({ received: true });
  } catch (err) {
    await prisma.stripeEvent.update({
      where: { stripeEventId: event.id },
      data: {
        status: 'failed',
        lastError: (err as Error)?.message ?? String(err)
      }
    });
    return res.status(500).json({ error: 'Processing failed (will retry)' });
  }
};


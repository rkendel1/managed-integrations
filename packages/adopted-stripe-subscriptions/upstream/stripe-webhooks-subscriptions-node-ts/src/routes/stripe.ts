import express from 'express';
import { z } from 'zod';
import { stripe } from '../stripe/stripe';

export const stripeRouter = express.Router();

stripeRouter.post('/payment-intent', async (req, res, next) => {
  try {
    const Body = z.object({
      amount: z.number().int().positive(),
      currency: z.string().min(3).max(3).default('usd')
    });
    const body = Body.parse(req.body);

    const pi = await stripe.paymentIntents.create({
      amount: body.amount,
      currency: body.currency
    });

    res.json({ id: pi.id, client_secret: pi.client_secret, status: pi.status });
  } catch (err) {
    next(err);
  }
});

stripeRouter.post('/checkout-session', async (req, res, next) => {
  try {
    const Body = z.object({
      priceId: z.string().min(1),
      successUrl: z.string().url(),
      cancelUrl: z.string().url(),
      customerEmail: z.string().email().optional(),
      // mode: subscription by default
      mode: z.enum(['subscription', 'payment']).default('subscription')
    });
    const body = Body.parse(req.body);

    const session = await stripe.checkout.sessions.create({
      mode: body.mode,
      customer_email: body.customerEmail,
      line_items: [{ price: body.priceId, quantity: 1 }],
      success_url: body.successUrl,
      cancel_url: body.cancelUrl
    });

    res.json({ id: session.id, url: session.url });
  } catch (err) {
    next(err);
  }
});


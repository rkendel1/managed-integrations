/** The managed Stripe-dependent application's configuration (integration row) and identity. */
import { z } from 'zod';

export const STRIPE_APP_FLOW_TYPE = 'adopted.stripe_subscriptions_app';
export const STRIPE_APP_CONTRACT_VERSION = 'stripe-subscriptions-app@1';

/** The Stripe events the application handles (src/webhooks/stripeEventProcessor.ts). */
export const APP_EVENT_TYPES = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.created',
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.processing',
  'payment_intent.canceled',
  'payment_intent.requires_action',
  'payment_intent.created',
  'checkout.session.completed',
] as const;

export const StripeAppConfigSchema = z.object({
  /** Our Stripe webhook endpoint for this customer's application (secret encrypted, bound to the integration). */
  webhook: z
    .object({
      endpointId: z.string(),
      url: z.string(),
      apiVersion: z.string(),
      secretCiphertext: z.string(),
    })
    .nullable()
    .default(null),
  /** The customer's previous deployment's endpoint we found at Stripe (discovery evidence), if any. */
  previousEndpoint: z.object({ id: z.string(), url: z.string(), apiVersion: z.string() }).nullable().default(null),
});
export type StripeAppConfig = z.infer<typeof StripeAppConfigSchema>;
export const appWebhookSecretAad = (integrationId: string) => `integration:${integrationId}:stripe-app-webhook`;

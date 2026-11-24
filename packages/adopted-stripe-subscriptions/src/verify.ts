/**
 * Provider verification for the Stripe-dependent application: does the application's own record of a Stripe
 * object say what STRIPE says about it? The expectation is derived from Stripe's data with Stripe's documented
 * semantics for every API version (a subscription's period end is on the subscription before 2025-03-31.basil
 * and on its items after; an invoice's subscription is under `parent` after basil; `paid` became
 * `status === 'paid'`) — independently of the application's code, so a 200 from the application proves nothing
 * by itself.
 *
 * Invariant (per record): Subscription status, period end, cancel-at-period-end and customer; Invoice status,
 * subscription, paid, amount due and currency; PaymentIntent status, amount and currency — equal Stripe's.
 */
import type { ModelName } from './store.ts';

type O = Record<string, any>;
export interface Expectation {
  model: ModelName;
  key: string;
  fields: Record<string, string | number | boolean | null>;
}
const iso = (s: unknown) => (typeof s === 'number' ? new Date(s * 1000).toISOString() : null);

export function expectationOf(o: O): Expectation | null {
  if (o?.object === 'subscription')
    return {
      model: 'subscription',
      key: o.id,
      fields: {
        status: o.status,
        currentPeriodEnd: iso(o.current_period_end ?? o.items?.data?.[0]?.current_period_end),
        cancelAtPeriodEnd: o.cancel_at_period_end ?? false,
        stripeCustomerId: typeof o.customer === 'string' ? o.customer : (o.customer?.id ?? null),
      },
    };
  if (o?.object === 'invoice')
    return {
      model: 'invoice',
      key: o.id,
      fields: {
        status: o.status ?? 'unknown',
        stripeSubscriptionId:
          (typeof o.subscription === 'string' ? o.subscription : o.subscription?.id) ??
          o.parent?.subscription_details?.subscription ??
          null,
        paid: o.paid ?? o.status === 'paid',
        amountDue: o.amount_due ?? null,
        currency: o.currency ?? null,
      },
    };
  if (o?.object === 'payment_intent')
    return {
      model: 'paymentIntent',
      key: o.id,
      fields: { status: o.status, amount: o.amount ?? null, currency: o.currency ?? null },
    };
  return null;
}

const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v === undefined ? null : v);

export interface Mismatch {
  record: string;
  field: string;
  application: unknown;
  stripe: unknown;
}
export function compare(e: Expectation, record: Record<string, unknown> | null): Mismatch[] {
  if (!record) return [{ record: e.key, field: '(record)', application: null, stripe: 'exists' }];
  return Object.entries(e.fields)
    .filter(([f, v]) => norm(record[f]) !== v)
    .map(([f, v]) => ({ record: e.key, field: f, application: norm(record[f]), stripe: v }));
}

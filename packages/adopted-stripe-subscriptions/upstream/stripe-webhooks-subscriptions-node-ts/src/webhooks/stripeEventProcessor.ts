import Stripe from 'stripe';
import { prisma } from '../db/prisma';

function asDateFromUnixSeconds(seconds: number | null | undefined) {
  if (!seconds) return null;
  return new Date(seconds * 1000);
}

export async function processStripeEvent(event: Stripe.Event) {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      await prisma.subscription.upsert({
        where: { stripeSubscriptionId: sub.id },
        create: {
          stripeSubscriptionId: sub.id,
          stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
          status: sub.status,
          currentPeriodEnd: asDateFromUnixSeconds(sub.current_period_end),
          cancelAtPeriodEnd: sub.cancel_at_period_end ?? false
        },
        update: {
          stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
          status: sub.status,
          currentPeriodEnd: asDateFromUnixSeconds(sub.current_period_end),
          cancelAtPeriodEnd: sub.cancel_at_period_end ?? false
        }
      });
      return { outcome: 'processed' as const };
    }

    case 'invoice.created':
    case 'invoice.finalized':
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
    case 'invoice.payment_failed': {
      const inv = event.data.object as Stripe.Invoice;
      await prisma.invoice.upsert({
        where: { stripeInvoiceId: inv.id },
        create: {
          stripeInvoiceId: inv.id,
          stripeCustomerId: typeof inv.customer === 'string' ? inv.customer : inv.customer?.id,
          stripeSubscriptionId:
            typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id ?? null,
          status: inv.status ?? 'unknown',
          currency: inv.currency ?? null,
          amountDue: inv.amount_due ?? null,
          paid: inv.paid ?? null,
          hostedInvoiceUrl: inv.hosted_invoice_url ?? null
        },
        update: {
          stripeCustomerId: typeof inv.customer === 'string' ? inv.customer : inv.customer?.id,
          stripeSubscriptionId:
            typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id ?? null,
          status: inv.status ?? 'unknown',
          currency: inv.currency ?? null,
          amountDue: inv.amount_due ?? null,
          paid: inv.paid ?? null,
          hostedInvoiceUrl: inv.hosted_invoice_url ?? null
        }
      });
      return { outcome: 'processed' as const };
    }

    case 'payment_intent.succeeded':
    case 'payment_intent.payment_failed':
    case 'payment_intent.processing':
    case 'payment_intent.canceled':
    case 'payment_intent.requires_action':
    case 'payment_intent.created': {
      const pi = event.data.object as Stripe.PaymentIntent;
      await prisma.paymentIntent.upsert({
        where: { stripePaymentIntentId: pi.id },
        create: {
          stripePaymentIntentId: pi.id,
          stripeCustomerId: typeof pi.customer === 'string' ? pi.customer : pi.customer?.id,
          status: pi.status,
          currency: pi.currency ?? null,
          amount: pi.amount ?? null
        },
        update: {
          stripeCustomerId: typeof pi.customer === 'string' ? pi.customer : pi.customer?.id,
          status: pi.status,
          currency: pi.currency ?? null,
          amount: pi.amount ?? null
        }
      });
      return { outcome: 'processed' as const };
    }

    case 'checkout.session.completed': {
      // Useful for connecting initial subscription/invoice/payment intent.
      // We persist the event regardless, so this can be used later for reconciliation.
      return { outcome: 'processed' as const };
    }

    default:
      return { outcome: 'ignored' as const };
  }
}


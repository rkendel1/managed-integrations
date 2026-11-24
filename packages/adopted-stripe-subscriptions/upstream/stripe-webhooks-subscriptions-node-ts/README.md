# Stripe Webhooks + Subscriptions (Production-ish)
[![CI](https://github.com/abdelrahmansapryalwtany/stripe-webhooks-subscriptions-node-ts/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/abdelrahmansapryalwtany/stripe-webhooks-subscriptions-node-ts/actions/workflows/ci.yml)

Express + TypeScript API example that supports:

- **Checkout Session** creation (subscription or one-time payment)
- **PaymentIntent** creation (sandbox)
- **Stripe Webhook** handler:
  - Signature verification (raw body)
  - **Idempotency** (dedupe by `event.id` in PostgreSQL)
  - **Retries** (returns `500` on processing failures so Stripe retries)
- Persisted **Stripe events** + basic **status transitions** for:
  - `Subscription`
  - `Invoice`
  - `PaymentIntent`

## Requirements

- Node.js 20+
- Docker (for PostgreSQL)
- Stripe CLI (optional but recommended for local webhook testing)

## Setup

1) Install dependencies:

```bash
npm install
```

2) Start PostgreSQL:

```bash
docker compose up -d
```

3) Create `.env` locally (this repo ships `env.example`; copy it and fill Stripe secrets):

```powershell
copy env.example .env
```

4) Run migrations + generate Prisma client:

```bash
npx prisma migrate dev --name init
```

5) Start the API:

```bash
npm run dev
```

Health check:

- `GET /health`

## API

Base path: `http://localhost:3000`

### Create PaymentIntent

`POST /v1/stripe/payment-intent`

Body:

```json
{ "amount": 2000, "currency": "usd" }
```

### Create Checkout Session

`POST /v1/stripe/checkout-session`

Body:

```json
{
  "priceId": "price_...",
  "mode": "subscription",
  "successUrl": "https://example.com/success",
  "cancelUrl": "https://example.com/cancel",
  "customerEmail": "test@example.com"
}
```

### Stripe Webhook

`POST /v1/stripe/webhook`

This endpoint **must** receive the raw request body and a `stripe-signature` header (Stripe sends this).

## Local webhook testing (Stripe CLI)

1) Forward webhooks to your local server:

```bash
stripe listen --forward-to localhost:3000/v1/stripe/webhook
```

2) Use the printed `whsec_...` to set `STRIPE_WEBHOOK_SECRET` in `.env`.

3) Trigger sample events:

```bash
stripe trigger payment_intent.succeeded
stripe trigger invoice.payment_failed
stripe trigger customer.subscription.created
```

## Tests

```bash
npm test
```

Tests use **Testcontainers** to spin up an ephemeral Postgres and run migrations inside the test process.

## Postman

Postman artifacts are in `postman/`.


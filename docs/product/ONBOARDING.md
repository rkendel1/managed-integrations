# Slice 5 — Frictionless onboarding

**Connect → Discover → Confirm → Protect** on one page (`/app/welcome`), resumable at every step
(`onboardings` table). Customers are never asked about webhooks, mappings, schemas, retries or
compatibility.

## Steps

| Step     | What happens                                                                                                                                                                                                                             | Customer actions |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Sign up  | `/signup` creates tenant, user and onboarding (off in production unless `ALLOW_SIGNUP=true`)                                                                                                                                             | 1                |
| Connect  | Shopify: OAuth (shop name → approve `read_orders`). NetSuite: account domain, integration client id, certificate id → we generate a key pair → the customer's admin uploads the certificate → verify (NetSuite M2M)                      | 5                |
| Discover | Automatic once both are connected (no action)                                                                                                                                                                                            | 0                |
| Confirm  | One summary: the integration we found, what we maintain, the access we use, what we verify (versioned responsibilities) → "Maintain this integration"                                                                                    | 1                |
| Protect  | Automatic: register our order notification (Shopify Admin API `webhookSubscriptionCreate`), baseline reconciliation of the discovered window, record earlier orders as history, independent second check, then management becomes active | 0                |

Happy path: **7 actions, 3 genuine decisions** (authorize Shopify, authorize NetSuite, confirm). Measured by
the onboarding API test and `make demo-onboarding`.

## Discovery: what it can and cannot establish

Only what the customer's authorizations let us read:

- Shopify Admin API: recent orders (30 days, up to 100, excluding the last 10 minutes);
- NetSuite SuiteQL: sales orders referencing them by external id or order number.

| Finding                                                                                                                            | Outcome                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Orders in NetSuite with the adopted implementation's signature (externalId `shopify-<order id>` and the order number as reference) | `found` → confirm (confidence _established_ if ≥ 80% of recent orders and ≥ 3) |
| That, plus orders written under another reference scheme                                                                           | `ambiguous` → choose                                                           |
| Only another scheme                                                                                                                | `unsupported` → we cannot adopt that code; choose a managed integration        |
| Nothing in NetSuite                                                                                                                | `not_found` → choose a managed integration (starts from now)                   |
| No recent Shopify orders                                                                                                           | `insufficient_evidence` → choose                                               |
| Already managed                                                                                                                    | `already_managed`                                                              |

We do not claim to see webhook subscriptions of the customer's other apps (Shopify does not expose them to
another app). A connection alone is never treated as an integration; the evidence is orders that actually
reached NetSuite.

## Activation prerequisites (all durable facts)

Connections authorized; the confirmed candidate and accepted responsibilities (with version, user, time); our
order notification registered; a completed baseline reconciliation; earlier orders recorded as delivered
history (attempts 0, `origin: baseline`, never presented as our executions); an independent second check
completed. Only then: integration `active`, onboarding `managed`.

Orders from before the takeover that never reached NetSuite are reported in the baseline and are not sent
without the customer asking. A _new_ integration starts from the confirmation time.

## Coverage

All results are fixture-backed (Shopify and NetSuite fixtures). The customer's "existing integration" is
their own deployment of the pinned upstream code, run by the test/demo before signup.

# Slice 6 — Second integration: selection and provenance

**Selected:** [`jakethehoffer/ledgerly`](https://github.com/jakethehoffer/ledgerly) @ `3101182eadc9e3a94b6d9c2f5bb2d0dd299e4090`
(v0.18.1, **Apache-2.0**): Stripe events → balanced double-entry journal entries → QuickBooks Online
`JournalEntry`. Adopted for the Stripe → QuickBooks integration, unmodified, as a commit-pinned git dependency
(`packages/adopted-ledgerly`). Everything below was verified against deterministic fixtures, not live Stripe
or QuickBooks.

## A. Search

`gh api search/repositories` (2026-11-24): "stripe quickbooks sync", "stripe xero sync", "stripe hubspot sync",
"stripe webhook quickbooks", "stripe to xero", "stripe payouts quickbooks", "stripe netsuite".

| Repository                                     | License    | Lang | Shape                                                                     | Decision                                               |
| ---------------------------------------------- | ---------- | ---- | ------------------------------------------------------------------------- | ------------------------------------------------------ |
| **jakethehoffer/ledgerly**                     | Apache-2.0 | TS   | Stripe events → QBO/Xero journal entries; library + receiver; 180 commits | **Selected**                                           |
| mjrobbins18/stripe-quickbooks-sync             | MIT        | Py   | batch sync (fees, refunds, payouts); 2 commits                            | credible, but a second runtime (Python) and batch-only |
| yarbroughrh/stripe-payouts-to-quickbooks       | MIT        | Py   | payouts → journal entries, single file                                    | payouts only                                           |
| derrtaderr/stripe-to-hubspot-sync              | MIT        | JS   | Stripe/BigQuery usage onto HubSpot companies                              | CRM enrichment, not a transaction integration          |
| cdifulv/stripe-qb-api                          | MIT        | TS   | 99 LOC skeleton                                                           | too little to adopt                                    |
| ubukhari/tieout                                | MIT        | TS   | reconciliation report tool                                                | does not move transactions                             |
| whummer/stripe-xero-sync, latin-guru/…, others | none       | —    | —                                                                         | no license → cannot be used                            |

Source-level inspection of ledgerly (clone at the commit): `src/engine.ts` (`mapEvent`, asserts every entry
balances), `src/events/*` (18 event types), `src/exporters/qbo.ts` (`toQbo`, DocNumber = last 21 characters of
the event id), `src/server/dispatchers/qbo.ts` (POST `journalentry?minorversion=70&requestid=…`),
`src/server/expand.ts` (retrieves nested Stripe objects; invoices at its pinned version `2024-06-20`). No runtime
dependencies; `stripe@16` is a type/SDK peer.

**Inherited tests:** running ledgerly's own test suite in this environment was refused by the permission policy
(installing and executing a third-party repository's dev toolchain). Not worked around. Instead, its 29 golden
QuickBooks outputs (`test/fixtures/*.qbo.json`, vendored unmodified in `packages/adopted-ledgerly/test/upstream-fixtures`)
are reproduced through **our** artifact loader by `packages/adopted-ledgerly/test/golden.test.ts` (29/29).

## B. Why it proves portability (differs from Shopify → NetSuite on every axis)

| Characteristic    | Shopify → NetSuite (shopify-erp-order-sync)              | Stripe → QuickBooks (ledgerly)                                                      |
| ----------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Providers         | Shopify, NetSuite                                        | Stripe, QuickBooks Online                                                           |
| Authentication    | Shopify OAuth (expiring offline token), NetSuite M2M JWT | Stripe restricted key; Intuit OAuth 2.0 with **rotating** refresh tokens            |
| Transaction model | order → one sales order                                  | event → 0..n **balanced** journal entries (excluded, refused and deferred cases)    |
| Events / recovery | webhook; recovery from Admin API order reads             | webhook; recovery by replaying the **Stripe Events API** (30-day retention)         |
| Verification      | sales order lines = Shopify items/qty/price              | entry exactly once, **debits = credits**, accounts and amounts = Stripe balance txn |
| Idempotency       | NetSuite upsert by external id                           | QuickBooks `requestid` + DocNumber look-up before posting                           |
| Repair types      | field-moved adapter; precision patch                     | reauthorization (customer); retired destination version (reviewed patch)            |

## C. Provenance

`packages/adopted-ledgerly/src/provenance.ts`: repository, commit, license, entry points, behaviour not used, and
the sha256 of **35 executed files** (the import graph of the four entry points), taken from the installed package
after verifying it is byte-identical to an independent clone (`diff -r src`). `pinnedDrift()` re-checks them at
every inspection and validation; a patched artifact is a content-addressed copy (`@mi/managed` `materializeArtifact`).

## D. Provider changes evaluated (honestly)

- **Stripe `2025-03-31.basil` removed `Invoice.charge`** (Stripe changelog). Evaluated as the repair scenario and
  **rejected**: ledgerly's own `expand.ts` retrieves invoices at `2024-06-20`, so the change does not break it.
  Presenting it as a repair would be manufactured.
- **QuickBooks minor versions 1–74 retired on 2025-08-01** (Intuit): values below 75 are ignored and served as 75. ledgerly hardcodes `70`. Real, low impact: handled by the reviewed patch `p0001-qbo-minor-version-75`.
- **Lost QuickBooks authorization** (refresh token expired or the customer disconnected the app → `invalid_grant`):
  the meaningful failure for this integration; handled end to end (customer reconnects; zero loss proven).

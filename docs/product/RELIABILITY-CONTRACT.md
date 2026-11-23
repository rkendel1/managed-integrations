# Reliability contract — version 1.0.0

The authoritative, machine-readable contract is `CONTRACT_V1` in `packages/contracts/src/index.ts`. It is
stored immutably in `integration_contracts` (with a sha256 of its canonical JSON) and rendered to the
customer on the Integration page. This document explains it; if they differ, the code is authoritative.

| Area               | Commitment (implemented behaviour)                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scope**          | Shopify Order → NetSuite salesOrder. Fields: externalId `shopify-<legacyResourceId>`, otherRefNum = order name, tranDate, configured entity/subsidiary, memo, lines via SKU map (quantity, pre-discount unit price). Excluded: refunds, fulfillment, inventory, catalog, discounts/shipping/tax lines, customer matching, post-delivery edits.                         |
| **Direction**      | Read-only on Shopify. NetSuite writes only salesOrder upserts with our externalId prefix. Never deletes.                                                                                                                                                                                                                                                               |
| **Freshness**      | Sync every 5 min (1 min in the demo stack); data no older than 30 min, else a `freshness_breach` incident.                                                                                                                                                                                                                                                             |
| **Completeness**   | Only established by reconciliation: source orders in a window vs delivery evidence vs NetSuite records (by externalId and order reference). If any side cannot be read, outcome is `partial`/`unknown`, never `consistent`.                                                                                                                                            |
| **Correctness**    | Pre-delivery validation (currency, mapped SKUs, positive quantities). Post-delivery: NetSuite lines and computed total compared with what was sent and with source quantities. HTTP success is not treated as proof.                                                                                                                                                   |
| **Idempotency**    | One delivery row per (integration, source order); NetSuite `PUT salesOrder/eid:<externalId>` upsert, so retries and crash-after-write cannot duplicate.                                                                                                                                                                                                                |
| **Recovery**       | Transient/rate-limit retries with exponential backoff + jitter, Retry-After as a floor. Cursor never passes an order without a durable terminal outcome. Interrupted runs detected by lease expiry and resumed. Missing records re-delivered. Unknown failures → incident + internal maintenance; fixes released only after independent validation and human approval. |
| **Compatibility**  | Contract versions are semantic and immutable; implementation versions are immutable artifacts (commit + sha256) with canary and rollback. Shopify API version pinned (2026-10) and reviewed at least yearly.                                                                                                                                                           |
| **Responsibility** | We own detection, recovery, provider changes, cursor/idempotency/reconciliation correctness and communication. Customer owns authorization, SKU map, NetSuite configuration, and business decisions on rejected records.                                                                                                                                               |

Definitions used in reconciliation: **missing** (expected, not in NetSuite, not rejected), **duplicate**
(>1 NetSuite order references the Shopify order), **inconsistent** (lines/total differ), **stale** (source
changed after delivery), **unexpected** (delivered but no longer in source window), **unresolved** (known
rejection, or a NetSuite record without our externalId).

We do not claim perfect reliability. Unknown states are reported as unknown.

## Capability surface (SLICE 1)

`integrations.list@1` is a **read-only projection** of durable integration state. It does not extend or
weaken the commitments above: freshness and completeness are still established by the sync engine and
reconciliation, not by the capability. The capability adds an authority boundary — a caller only sees
its own tenant's integrations, and every consumer (UI, MCP) passes the same check. Capability
availability is not yet a contractual uptime commitment.

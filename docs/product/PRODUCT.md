# Product

## Thesis

Software and integrations are increasingly cheap to create; durable value shifts to **ongoing
responsibility for outcomes**. We sell that responsibility: a defined data flow between business systems
stays correct, complete, current, recoverable and maintained — within an explicit reliability contract.

## Customer and promise

A merchant running Shopify for commerce and NetSuite as ERP who wants orders in NetSuite without owning
an integration. Promise: _Your application stays connected. We keep the integrations working._

The customer: connects both systems, maintains their SKU → item map and NetSuite configuration, and acts
when we tell them a decision is theirs. They do **not** debug integrations, chase API changes, track
cursors, investigate missing records, or operate an integration platform.

## Boundary (unchanged from the specification)

We are a managed service, not an iPaaS, connector marketplace, workflow builder, SDK, customer-side agent
or consulting firm. Customers never connect repositories, receive PRs, or run our code.

## First flow (candidate — not market-validated)

Shopify orders → NetSuite sales orders: backfill, incremental sync, pagination, durable cursor,
idempotent delivery, retries, rate limits, record outcomes, history, freshness, reconciliation, failure
detection and recovery. Refunds, fulfillment, inventory, catalog, arbitrary mappings and other providers
are out of scope.

## Business model (unvalidated)

Illustrative $1,000–$2,000+/month per managed integration. Viability depends on keeping human
intervention, custom code and onboarding effort per customer low; the operator console's _Economics_
view reports what is measurable from durable state (incidents/tenant, MTTR, automatic recovery rate,
agent repair rate, validation pass rate, model cost, human decisions). Human hours, hosting cost and
contribution margin are **not** measured automatically yet.

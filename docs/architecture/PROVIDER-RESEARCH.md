# Provider research (official documentation, captured 2026-11-23)

Full summaries with URLs: `docs/provider-docs/shopify/admin-graphql-orders.md`,
`docs/provider-docs/netsuite/rest-sales-orders.md`.

**Verified and relied on:** Shopify GraphQL Admin API (REST is legacy), version 2026-10,
`orders(first, after, query, sortKey: UPDATED_AT)`, field names used in our query, calculated-cost rate
limiting with `THROTTLED`, `read_orders` + 60-day limit without `read_all_orders`, expiring offline tokens
(1h access / 90-day rotating refresh, mandatory for apps created on or after 2026-12-01). NetSuite
`PUT /record/v1/salesOrder/eid:{externalId}` upsert; 204 + Location on create; SuiteQL with
`Prefer: transient` and offset divisible by limit; OAuth 2.0 client credentials (M2M, certificate-signed
JWT, 60-min tokens, no refresh token); TBA closed to new integrations from 2027.1; error shape
`o:errorDetails[].o:errorCode`, 429 `CONCURRENCY_LIMIT_EXCEEDED`.

**Unverified (implemented defensively, must be confirmed in a sandbox):**

- Exact quoting of ISO timestamps in Shopify `updated_at:` search (we use `updated_at:>='<iso>'`).
- Whether Shopify throttling arrives as HTTP 200 + `THROTTLED` or HTTP 429 (both handled).
- Whether NetSuite upsert-update returns `Location` (we fall back to GET by externalId).
- NetSuite JWT `aud` value and accepted algorithms (we send `aud` = token URL, PS256; configurable in code).
- salesOrder required fields for the customer's account (entity, subsidiary for OneWorld; custom fields).
- SuiteQL column names `transaction.externalid/otherrefnum/type='SalesOrd'` and `transactionline`
  `mainline/item/quantity/rate/linesequencenumber`; sign of `transactionline.quantity` (we compare magnitudes).
- Retry-After on NetSuite 429.

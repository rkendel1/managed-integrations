# Shopify Admin GraphQL — orders (summary of official docs, captured 2026-11-23)

- REST Admin API is legacy since 2024-10-01; new public apps must use GraphQL since 2025-04-01.
  https://shopify.dev/docs/api/admin-rest
- Endpoint: `POST https://{store}.myshopify.com/admin/api/{version}/graphql.json`, header `X-Shopify-Access-Token`.
  Latest stable version: 2026-10 (supported until 2027-10-16). Quarterly releases, ≥12 months support.
  https://shopify.dev/docs/api/usage/versioning
- `orders(first, after, query, sortKey, reverse)`; `sortKey: UPDATED_AT`; search filter `updated_at:>=...`.
  https://shopify.dev/docs/api/admin-graphql/latest/queries/orders
- Order fields: `id`, `legacyResourceId`, `name`, `createdAt`, `updatedAt`, `cancelledAt`, `currencyCode`,
  `totalPriceSet: MoneyBag`, `email`, `lineItems`. https://shopify.dev/docs/api/admin-graphql/latest/objects/Order
- LineItem fields: `sku` (nullable), `title`, `quantity`, `originalUnitPriceSet: MoneyBag` (pre-discount).
  https://shopify.dev/docs/api/admin-graphql/latest/objects/LineItem
- Rate limits: calculated query cost, `extensions.cost.throttleStatus {maximumAvailable, currentlyAvailable, restoreRate}`,
  error code `THROTTLED`, max single query cost 1000 (`MAX_COST_EXCEEDED`).
  https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits
- Scopes: `read_orders`; only last 60 days without `read_all_orders`.
- Expiring offline tokens (`expiring=1`): access 1h, refresh 90d, refresh rotates. Required for apps created on/after 2026-12-01.
  https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens

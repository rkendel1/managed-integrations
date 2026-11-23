# FIXTURE webhook payload changelog (fictional — deterministic test fixture only)

> This file describes a **controlled, fictional** change made by `packages/test-fixtures` (webhook version
> `2027-01`). It exists to exercise the maintenance lifecycle of the adopted Shopify → NetSuite flow. It is
> not a statement about any real Shopify API version. Real Shopify `orders/create` payloads do carry both
> `line_items[].price` and `line_items[].price_set` today.

## Payload field changes

| Topic         | Version | Removed field      | Replacement field                        | Notes                                                                                      |
| ------------- | ------- | ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| orders/create | 2027-01 | line_items[].price | line_items[].price_set.shop_money.amount | Same value: the line's unit price before discounts, in the shop currency (decimal string). |

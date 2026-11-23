# FIXTURE schema changelog (fictional — deterministic test fixture only)

> This file describes a **controlled, fictional** change made by `packages/test-fixtures` (profile `drift`).
> It exists to exercise the reliability and maintenance pipeline. It is not a statement about any real
> Shopify API version.

## Field changes

| Type     | Removed field        | Replacement field       | Notes                                                                                     |
| -------- | -------------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| LineItem | originalUnitPriceSet | preDiscountUnitPriceSet | Same `MoneyBag` shape (`shopMoney { amount currencyCode }`); same pre-discount semantics. |

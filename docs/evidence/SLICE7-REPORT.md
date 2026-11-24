# Slice 7 — completion report (three-sided change resilience, provider-centric adoption)

Commits `ebd6931` … `1e6290a` on `claude/wizardly-fermat-x6gekb`; verification closed in slice 8 (below). All
provider behaviour is fixture-backed; nothing ran against live accounts.

1. **Inventory and model.** Before/after inventory, boundaries (source · target · provider · integration ·
   combined), `providers[]` with roles, contract observations, five correction kinds, decisions with authority,
   whole-path coordination: `docs/architecture/THREE-SIDED.md`.
2. **Source-only change** — Shopify field moved (slice-4 adapter), event now records boundary `source`, provider
   `shopify`.
3. **Target-only changes** — QuickBooks account made inactive (610): held, customer decision, failed validation
   rejected, configuration validated/activated, recovered, verified, history untouched, rollback. NetSuite
   OneWorld: held (not rejected), customer decision, configuration, reviewed patch p0002 validated whole-path,
   operator activation, released, verified, rollback.
4. **Integration code/dependency changes** — Stripe app patch p0001 (basil field locations) validated by replay;
   quickbooks-mcp dependency change d0001 (node-quickbooks 2.0.48 → 2.0.50, upstream v0.12.0) validated by
   request-level replay; immutability (pinned files unchanged) and rollback for both.
5. **Combined source + target** — OneWorld and Shopify payload change together: neither validates nor releases
   on part of the path (`blockingEvents`); corrected together, every order delivered once with Shopify's prices
   in the chosen subsidiary.
6. **Required scenarios** — validation failure, rollback, unsupported change, replay/recovery, duplicate delivery,
   incomplete source population, incorrect destination data despite success: mapped in THREE-SIDED.md §4.
7. **Provider-centric adoption (scope correction)** — two real open-source applications that depend on one
   provider, not pipelines: stripe-webhooks-subscriptions-node-ts @ 4812d25 (Stripe: both) and quickbooks-mcp @
   ce1317e (QuickBooks: both), each with its own artifact, provenance, execution path and provider verification,
   maintained through a provider-side and an application-side change (`docs/adoption/PROVIDER-APPLICATIONS.md`).
   Stripe → QuickBooks kept.
8. **Customer and operator views** — customer: outcome first, no internals (tested), a decision panel for
   questions only the customer can answer; operator: boundary, provider, impact and every correction with its
   validation for any finding shape.
9. **Generic vs specific** — THREE-SIDED.md §3; measured LOC in `docs/architecture/ADOPTION-ECONOMICS.md` §1.
10. **SaaSKit** — inspection and baseline (33/33 of its own tests) only; hosting it under management with
    application-side and Stripe-side changes was **not built** in slice 7 (`docs/adoption/SAASKIT.md`).
11. **Verification (closed in slice 8)** — see `docs/evidence/ACCEPTANCE.md`, Slice 7 and Slice 8 sections:
    fresh Docker rebuild, every demo including `demo-applications`, Playwright, Vitest. The first
    `demo-applications` run on a rebuilt stack failed at its own wait condition (it waited for state `resolved`;
    the customer view presents a resolved event as `completed`); the event had in fact resolved. Fixed in the
    demo and rerun.
12. **Limitations** — `docs/evidence/KNOWN-LIMITATIONS.md` (Slice 7).

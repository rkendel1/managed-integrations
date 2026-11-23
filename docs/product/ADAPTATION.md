# Slice 5 — Managed integration adaptation

The question this answers, for every managed integration, at any time:

> What exact code is running, what provider contracts does it depend on, what adapters or patches have
> changed its behaviour, and what evidence proves those changes are safe?

Operator answer: `adaptations.inspect` (MCP `adaptations_inspect`; Operator → Tenants → Maintenance).

## 1. The adopted code and what it depends on

- **Adopted artifact**: `Milo-ai-HQ/shopify-erp-order-sync` @ `d01b51d` (MIT), installed unmodified as a
  commit-pinned dependency; every executed file's sha256 is recorded in `provenance.ts` and re-checked on
  every inspection and validation.
- **Provider contract it depends on**: `UPSTREAM_INPUT_CONTRACT` (`input-contract.ts`) — every Shopify
  payload field upstream `src/mapping.js` reads, its expected type and precision, and the exact upstream
  expression that reads it (located in the pinned file at runtime, e.g. `src/mapping.js:11`).
- **Running artifact**: `artifact.ts` — `adopted:d01b51d95993` (the installed package, untouched) or a
  content-addressed patched copy such as `adopted:d01b51d95993+p0001`. Every delivery attempt records the
  artifact id and the adaptations in force.

## 2. Three levels of intervention

| Level           | When                                                                                                                                            | Mechanism                                                                                                                                                                                                                                                                                                                                              | Activation                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **Adapter**     | A provider field moved / was renamed and keeps its meaning                                                                                      | `field_moved`: copy the documented replacement into the field upstream reads, before upstream runs. Never overwrites; a conflict between the two is held, never resolved silently; null, empty and non-scalar values are never copied; idempotent                                                                                                      | Automatic after a full validation (maintenance), or operator |
| **Patch**       | The defect is inside upstream; an adapter cannot fix it                                                                                         | A reviewed file in `packages/adopted-order-sync/patches/` naming the artifact, file, base and result sha256, the exact text replaced (must occur once), original and replacement behaviour, reason, provider evidence, assumptions, validation requirements and rollback. Applied to a content-addressed copy; the installed package is never modified | Operator only                                                |
| **Unsupported** | Conflicting values, a changed meaning or representation, several fields at once, no reviewed correction, or a correction previously rolled back | Recorded with its reason; the affected orders stay held; the maintenance event escalates to a person                                                                                                                                                                                                                                                   | —                                                            |

There is no runtime code rewriting: only catalogued, reviewed patches can be proposed.

## 3. Lifecycle and records

One table, `adaptations`, is the single authority (the slice-4 `config.inputCompat` rules were migrated into
it). Each row: kind, status, base artifact, dependency (provider, topic, versions, fields), code path,
spec, rationale, evidence (changelog entry and hash, baseline equivalence, patch evidence), validation,
append-only history (`{at, from, to, actor, note}`), activation and rollback times, and the maintenance
event that motivated it. Every transition is also written to the audit log.

```
proposed → validating → validated → active → rolled_back
                     ↘ rejected            unsupported (terminal, with reason)
```

The maintenance event (incident) remains the single maintenance record; its `correction` fact points at
the adaptation.

## 4. Validation before activation (persisted on the adaptation)

1. applies to the adopted artifact (commit; field read by upstream / patch base hash);
2. original adopted code unchanged (and, for a patch, the patched artifact reproduces the reviewed result exactly);
3. regression: every stored order maps identically before and after (real upstream code);
4. affected (held) orders satisfy the contract and map without error;
5. business data preserved: mapped quantities and prices equal Shopify's own order record (Admin API);
6. no conflicting data accepted;
7. rollback target available (the previous runtime loads; upstream files match the pin).

A check that cannot run (e.g. no affected orders) is `not_applicable`: validation then _requires a decision_
and activation needs `acceptLimitations: true` from an operator. After activation, the maintenance event's
verification (second reconciliation, line-level NetSuite comparison, accounting, duplicates) is written back
to the adaptation as `postActivation`.

## 5. Rollback

Rollback switches the adaptation off; the next execution runs the previous known-good runtime (verified to
load first). Orders already written are not rewritten; affected new orders are held again, and maintenance
will **not** re-apply a correction an operator rolled back (it records it as unsupported and escalates).

## 6. First corrections

- **Adapter (proven in slice 4, now in the registry)**: `line_items[].price ← line_items[].price_set.shop_money.amount`
  for the fictional fixture webhook version `2027-01`.
- **Patch p0001** (`patches/p0001-preserve-price-precision.json`): upstream `src/mapping.js:11` rounds every
  price to 2 decimals (`round2(Number(l.price))`), which loses money in three-decimal currencies (ISO 4217: KWD,
  BHD, JOD, OMR, TND). The patch keeps Shopify's decimal. Proven in tests with a KWD order (12.345): held,
  patch proposed by maintenance, validated (8 checks), activated by an operator, NetSuite rate exactly 12.345,
  rolled back (original code runs again; new KWD orders are held). Not verified against a live store.

## 7. Authority

All adaptation capabilities require `integrations.read:any` / `integrations.operate:any` (operators only).
Customers cannot create, activate or roll back corrections and never see patch mechanics; they see the
maintenance outcome.

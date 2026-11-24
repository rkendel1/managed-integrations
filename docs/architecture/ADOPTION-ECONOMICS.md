# Slice 8 — adoption economics and OpenAPI

Starting point verified: branch `claude/wizardly-fermat-x6gekb`, HEAD `1e6290a`, clean, equal to the remote.
Everything is fixture-backed or measured on recorded traffic; no live Stripe, QuickBooks, Shopify or NetSuite
account was used.

## 1. Where integration-specific code actually goes (measured)

Authored TypeScript per adoption (`src/`, excluding vendored upstream code, tests and fixtures), attributed by
each file's primary purpose:

| Category (file-level attribution)                                           | Shopify→NetSuite | Stripe→QuickBooks | Stripe subscriptions app | QuickBooks tools app |
| --------------------------------------------------------------------------- | ---------------: | ----------------: | -----------------------: | -------------------: |
| Wiring: provenance, artifact, descriptor, contract, runtime, index          |              811 |               856 |                      399 |                  321 |
| Ingress and execution (webhooks, executor, writes, hosting, app store)      |              438 |               503 |                      664 |                  268 |
| Provider field contract (hand-coded): `input-contract.ts`, `upstream.d.ts`   |              393 |                 0 |                        0 |                    0 |
| Verification and reconciliation                                             |              916 |               495 |                       71 |      (in executor) |
| Maintenance: detect, impact, correct, validate, recover, verify, account    |            2,009 |             1,580 |                      559 |                  369 |
| Onboarding and discovery                                                    |              616 |               463 |                      176 |                   56 |
| **Total**                                                                   |        **5,183** |         **3,897** |                **1,869** |            **1,014** |

Shared code they rely on: `@mi/managed` 2,255 · `@mi/provider-connections` 419 (moved out of ledgerly in slice 7,
not new) · `@mi/integration-shopify-netsuite` clients (NetSuite 266, Shopify 142, http 83, retry 78) ·
`@mi/capabilities` 3,165.

What the numbers say:

- **HTTP/API plumbing is not where the cost is.** The adopted applications bring their own clients (ledgerly's
  dispatcher, stripe-node, node-quickbooks); Managed Integrations' own provider plumbing is about 570 lines
  (NetSuite/Shopify clients, http, retry) plus OAuth/credential custody (419). OpenAPI-generated bindings can
  replace at most that, and only for providers that publish a usable contract (Shopify Admin is GraphQL; NetSuite
  and QuickBooks publish none).
- **The cost is maintenance and verification semantics**: 39–52% of each adoption is its maintenance driver
  (2,009 / 1,580 / 559 / 369) and up to 18% is verification/reconciliation. Each driver re-implements the same
  sequence — phase machine (`setProgress` 3–18 times), `escalate` (3–14), accounting (1–4), the resolution guard
  and the recovery → verification → resolved transitions — around integration-specific detection, verification
  and recovery. This is the largest source of repeated work, and it is not an API-contract problem.
- **The marginal cost is already falling** (5,183 → 3,897 → 1,869 → 1,014) because slices 5–7 moved lifecycle,
  artifacts, accounting, events, boundaries and provider connections into shared code; the remainder is the
  per-adoption sequencing above plus genuine semantics.
- **Hand-coded provider contracts** (Shopify's input contract, 393 lines; the Stripe app's shape/drift code,
  about 80 lines) are what OpenAPI replaces — where the provider publishes one.

## 2. AppPort, as installed

Installed: `@appport/core` 1.13.0, `schema` 1.2.2, `protocol` 1.8.0, `authorization` 1.4.0, `server` 1.5.0,
`client` 1.2.0, `transport-http` 1.1.11, `mcp` 1.5.0 (all Apache-2.0). Published but not installed:
`@appport/services` 0.21.0 (ISC; peer-depends on `@feltdb/core` — not usable here), `generators` 1.0.13
(manifest → client/types), `testing` 1.6.0 (conformance suites incl. the external-call recorder), `runtime`
0.20.0. There is no `@appport/openapi`.

What the installed core already provides, and Managed Integrations had not used before this slice:

| Need                                        | AppPort 1.13 mechanism                                                                                       | Used now                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| Provider operations as capabilities         | `defineProvider`, `providerCapability`, `instantiateProvider` (credentials in host custody)                  | yes — `@mi/openapi` bindings   |
| External effects                            | `effect.begin()` → succeeded / failed (`effectFailed`) / unknown; `ExternalCallRecorder` (durable start first) | yes (in-memory recorder in tests) |
| Unknown-outcome settlement                  | capability `verify`, `verifyExternalCall`, settlement once, never re-run                                     | not yet                        |
| Idempotency                                 | `IdempotencyStore`, key reuse / outcome-unknown errors                                                       | via capability `idempotency`   |
| Invocation status (reconciliation)          | `appport.invocation.status` capability                                                                       | no                             |
| Schemas from JSON Schema                    | `fromJSONSchema` (the manifest subset, §32)                                                                  | no (see gaps)                  |
| MCP exposure                                | `@appport/mcp` bridge (already serving our capabilities)                                                     | yes                            |
| Dependency resolution                       | `resolver` (requirement manifests, compatibility, resolved dependency)                                       | no (see §7)                    |

Gaps (real, documented, not worked around): the recorder in production needs a durable store (the
`ExternalCallRecorder` contract is there; Managed Integrations has none yet); OpenAPI schemas are not passed
through `fromJSONSchema` because Stripe's request schemas use constructs beyond the manifest subset (untested
here, so bindings validate with contract conformance instead); `@appport/services` cannot be adopted without
FeltDB.

## 3. OpenAPI: decision

**Adopt, narrowly.** Parsing, validation, `$ref` resolution and bundling: `@apidevtools/swagger-parser` 13.1.0
(MIT, maintained, OpenAPI 2/3.0/3.1; validated the 6.4 MB Stripe document in about 1.1 s). Types:
`openapi-typescript` 7.13.0 (MIT, types only, no runtime), for the used subset only. Not adopted:
`@hey-api/openapi-ts` (an SDK generator — a second client we would own), `openapi-fetch` (our bindings are AppPort
capabilities, not a fetch client), `openapi-diff` (2025, does not attribute to applications), `oasdiff` (Go; the
npm entry is a placeholder). Built ourselves, because nothing existing does it: the deterministic normalized
contract, the per-application impact attribution, conformance of recorded traffic, and the binding to AppPort
providers — 894 lines in `@mi/openapi`.

Not an `@appport/` package: the surface that is genuinely AppPort's (provider capabilities, effects) is already in
`@appport/core`; what remains is Managed Integrations' adoption evidence (provenance, overlays, impact,
maintenance events). Extraction can be reconsidered if a second product needs it.

## 4. The pipeline (`packages/openapi`)

Acquire (`source.ts`: bytes kept, sha256, location incl. git commit, licence, authority official / community /
derived) → Normalize (`normalize.ts`: operations, request/response fields, schemas, security, webhooks, JSON
pointers; effect class and pagination labelled `inferred`; contract hash) → Discover (`subset`) → Bind
(`bind.ts`: AppPort provider capabilities; pre-flight conformance; `effect.begin()` before writes; 4xx =
`effectFailed`, 5xx after begin = unknown; destructive operations never bound by inference) → Define semantics
(`overlay.ts`: reviewed statements with status known / inferred / unverified / unsupported / requires_decision;
`known` needs a source) → Validate (`conformance.ts` on recorded traffic; generated types for the subset,
reproducible, provenance header) → Adopt / maintain (`diff.ts` + `maintain.ts`: contracts kept as contract
observations, impact attributed, a maintenance event only for an affected application).

## 5. Benchmarks

**SaaSKit → Stripe** (`rkendel1/saaskit` @ `8ead17d`, isolated copy, never modified — its own acceptance test
writes a transcript file, restored after each run). Contract: `stripe/openapi` v1267 (official, MIT, API
2024-06-20, the version SaaSKit pins). SaaSKit ran unchanged under a transparent fetch recorder: **33/33** of its
own tests, **70 exchanges**, all with `Stripe-Version: 2024-06-20`, every write with an idempotency key, **0
request violations** against the contract. The simulator's responses are measured against real Stripe: it omits
fields Stripe marks required (`created`, `livemode`, `capture_method`, …) and returns non-Stripe fields
(`pi_metadata`, `description` on a checkout session) — SaaSKit reads none of them, so its behaviour is
unaffected, but the simulator is not a faithful Stripe. Generated bindings build the same request SaaSKit's
hand-written client sends (same form keys, same idempotency key); SaaSKit's client is not replaced — adoption does
not require it to become OpenAPI-first.

**QuickBooks (quickbooks-mcp)**: Intuit publishes no OpenAPI. The community spec was measured unusable (82/167
duplicate paths, 112/113 writes without a request schema, 0/167 typed responses —
`runs/openapi-qbo-community-spec.json`). A **derived** contract (88 lines, cited to Intuit's documentation,
labelled derived) for the 3 operations the application uses: its real node-quickbooks traffic conforms, and the
same binding mechanism (JSON body, OAuth bearer, effect recording) creates and reads invoices. A normalizer gap
found only by this provider (request bodies given by `$ref`) was fixed.

| Metric                                  | Stripe subscriptions app (slice 7, hand-built) | SaaSKit → Stripe (pipeline)                                | quickbooks-mcp (slice 7) | quickbooks-mcp (pipeline)                    |
| --------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- | ------------------------ | -------------------------------------------- |
| Provider contract knowledge             | hand-coded shapes/drift (~80 TS)              | official contract, 0 authored                              | none                     | derived contract, 88 lines JSON (cited)      |
| Usage (what the app depends on)          | implicit in code                               | 6 operations + 28 cited reads; 33 sent fields observed     | implicit                 | 3 operations                                 |
| Business semantics                       | in TS drivers                                  | overlay: 27 statements (25 known, 1 inferred, 1 decision)  | in TS                    | overlay: 13 statements (11 known, 1 unverified, 1 unsupported) |
| Client / bindings authored               | 0 (app's own)                                  | 0 (generated AppPort capabilities)                         | 0 (app's own)            | 0 (generated AppPort capabilities)           |
| Contract change detection                | after traffic shows drift                      | before traffic: diff + attribution                         | none                     | diff + attribution                           |
| Hosting, execution, recovery, verification drivers | 1,869 TS                              | **not built** for SaaSKit (see limitations)                | 1,014 TS                 | unchanged (1,014 TS)                         |

So the pipeline removes provider-contract authoring and adds predictive change detection; it does not reduce the
maintenance-driver code, which remains the dominant marginal cost.

## 6. Change maintenance from the contract

`stripe/openapi` v1267 → v1618 (2025-03-31.basil): **1,752 changes, 484 breaking** in the contract. Attribution:
SaaSKit — **unaffected** (nothing it sends or reads changed). Stripe subscriptions app — **exactly 3 breaking
changes**, `invoice.subscription` (stripeEventProcessor.ts:46), `invoice.paid` (:50),
`subscription.current_period_end` (:21): precisely what slice 7's reviewed patch p0001 corrects. These were the
fields slice 7 modelled in its fixtures; the official contracts confirm them independently. `checkContractChange`
keeps both contracts (with the used subsets) as contract observations, opens one reviewable
`provider_contract_change` event for the affected application only, and creates no correction. Correction,
validation, activation, recovery, verification and rollback of that exact change are proven by slice 7's
Stripe-side test; contract change, impact, correction, validation, activation and verified outcome remain
separate recorded facts.

## 7. MCP (adoption aid, never the execution authority)

- **Stripe**: the npm packages `@stripe/mcp` 0.3.4 and `@stripe/agent-toolkit` 0.9.1 (MIT) are marked deprecated
  in favour of Stripe's hosted server `https://mcp.stripe.com` (README, `stripe/ai`). Remote, OAuth/restricted
  key, Stripe-versioned; useful to explore an account during adoption; it adds no contract metadata beyond the
  OpenAPI document.
- **QuickBooks**: `intuit/quickbooks-online-mcp-server` @ `31a1dd5` (Apache-2.0 repository; package
  `@qboapi/qbo-mcp-server` 0.0.1 says MIT), ~140 tools on node-quickbooks, zod input schemas per tool (e.g.
  `create_invoice`: customer_ref, line_items, doc_number, tax fields). Useful as discovery and test material
  (which fields Intuit's own tooling sends); tool-level, not an API contract. The adopted quickbooks-mcp is itself
  an MCP server, which Managed Integrations hosts and exposes through AppPort's MCP bridge — one implementation.
- Recommendation: no runtime dependency on any provider MCP server; production transactions go through bound
  operations with recorded effects, idempotency and verification.

## 8. Resolver (future value only — nothing implemented)

Proven dependency-selection cases from slices 7–8: the provider base URL (fixture vs sandbox vs production:
`STRIPE_BASE_URL_OVERRIDE`, `QBO_BASE_URL_OVERRIDE`, `STRIPE_API_BASE` in SaaSKit), the client library version
(node-quickbooks 2.0.48 vs 2.0.50, selected per artifact), the provider contract version (2024-06-20 vs basil),
and credentials (connection per tenant). The first and last are ordinary configuration. The artifact's dependency
set is already pinned per artifact by our own mechanism. A stable runtime reference would remove hard-coding only
where one application instance must switch provider environments without redeploying — not yet observed.
AppPort core already ships a requirement resolver; if that need appears, use it rather than add `ref://`.

## 9. Limitations and gaps

See `docs/evidence/KNOWN-LIMITATIONS.md` (Slice 8).

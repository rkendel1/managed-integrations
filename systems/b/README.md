# Managed Integrations — the application (FeltKit)

This is the primary application of the repository. It takes operational responsibility for a customer's
integrations — adopted open-source integration code, run unmodified at a pinned commit — and keeps them
correct when the source, the target, the provider or the code changes. System A (`apps/`, `packages/` at the
repository root) is the PostgreSQL reference implementation it was built to match; see
[`docs/experiment/PARITY.md`](../../docs/experiment/PARITY.md).

Built on FeltKit 0.4.0: FeltDB is the only store, FeltKit owns accounts, sessions, workspaces (tenancy),
durable work, the AppPort and MCP surfaces and the deploy artifact. This application owns the product logic.

## Run it

From the repository root (the provider simulators live in `packages/test-fixtures`):

```bash
make app-install
```

```bash
make app-dev
```

The app is on <http://127.0.0.1:3100>; the simulators are on ports 5010–5040 (Shopify ×5, NetSuite,
Stripe, QuickBooks), each in memory. `make app-dev` **destroys** development state (`.feltkit/development`)
and restarts everything. It reads secrets from `systems/b/.env.scenarios`, which `make app-secrets` creates
once with the simulators' client secrets and a fresh keyring (gitignored; never commit it).

| Check | Command | Needs |
|---|---|---|
| Function and unit tests | `make app-test` | nothing running |
| All ten shared scenarios, after one reset | `make app-scenarios` | — (it resets) |
| Browser journeys | `make app-e2e` | — (it resets) |
| Typecheck, prebuilt artifacts current, code classification | `make app-check` | — |

Each scenario writes its evidence (every step with its time and data) to `docs/evidence/runs/system-b/`.

## What it does

| Integration (`integrations.kind`) | Adopted code | Target |
|---|---|---|
| `order_sync` | `Milo-ai-HQ/shopify-erp-order-sync` @ `d01b51d` (MIT) | Shopify orders → NetSuite sales orders |
| `ledgerly` | `jakethehoffer/ledgerly` @ `3101182` | Stripe → QuickBooks journal entries |
| `stripe_app` | `stripe-webhooks-subscriptions-node-ts` @ `4812d25` (vendored) | a hosted Stripe application |
| `qbo_tools` | `quickbooks-mcp` @ `ce1317e` (vendored) | QuickBooks invoices as tools |
| `native_sync` | our own polling engine (declared query spec) | Shopify → NetSuite |

Each one runs through the same mechanisms:

- **Receipt and delivery.** Provider webhooks are verified by provider-specific signatures, sealed, deduplicated
  and delivered as durable work; a delivery is one per source transaction, with its attempt history.
- **Maintenance events.** A change at a boundary (`source`, `target`, `provider`, `integration`) opens one
  event per change, not per transaction. The driver investigates (naming the line of adopted code), corrects,
  validates, activates, recovers and verifies, then accounts for every affected transaction.
- **Corrections registry** (`corrections`): `adapter`, `patch`, `configuration`, `decision`, `unsupported`, each
  with validation evidence and a full history; activation and rollback are recorded with who did them.
  - A **decision** is a business question only the customer may answer (`maintenance.decide`; staff are refused),
    with options read from the customer's own system.
  - A **configuration** records the settings before and after, is validated against the target before it is
    switched on, and is rolled back exactly.
  - A **patch** is a reviewed exact-text change to the pinned source, built as a content-addressed artifact
    beside it (`runtime/artifacts.ts`; the installed code is never modified). Patches need an operator.
- **Whole path or nothing.** Held work is released only when no other change of the same integration still
  awaits its correction (`blockingEvents` in `feltkit/target.ts`).
- **Reconciliation** reads the source independently of webhooks and recovers what never arrived, exactly once.
- **Onboarding** discovers an existing deployment from what the customer's own code already wrote.
- **Repair agent (S1 only):** EVE (`agent-eve/`, Node 24, its own server) proposes a change to the native
  engine's declared query specification; the application validates it deterministically, an operator approves,
  a canary verifies. Without the agent, a deterministic playbook proposes.

## Where things are

| Path | What |
|---|---|
| `feltkit/app.ts` | Roles, tenancy, the `runtime` component, every collection (the data model) |
| `feltkit/*.ts` | Functions (queries/mutations), 24 of them published as AppPort capabilities |
| `feltkit/target.ts` | Decisions, configurations and whole-path release for target-side changes |
| `runtime/component.ts` | The FeltKit component: webhook routes, OAuth callbacks, sealed secrets, the work loop |
| `runtime/maintain.ts`, `runtime/target.ts` | The maintenance driver (deterministic) |
| `runtime/order-sync.ts`, `ledgerly*.ts`, `apps*.ts`, `native.ts` | Running each adopted code base; their reviewed patches |
| `runtime/patches/` | Reviewed patches stored as data |
| `runtime/generated/artifacts.json` | Every reviewed artifact variant, prebuilt (`node scripts/build-artifacts.ts`; deployments carry no sources) |
| `src/` | The customer (`/app`) and operator (`/ops`) UI |
| `tests/` | Function tests (fresh FeltDB each) and runtime unit tests |
| `scenarios/` | The shared scenarios S1–S10, driving the app only through its public surfaces and the simulators |
| `e2e/` | Browser journeys (Playwright) |

## Roles

Each customer company is a FeltKit workspace. Its people hold `owner` (`mi.decide`, `mi.configure`, …); the
provider's staff are invited into it as `operator` (`mi.maintain`, `mi.read.evidence`); the runtime component is
a member as `runtime`. Another company's records are `NOT_FOUND`. In development, staff are the declared dev
users `staff-1` and `staff-2`; in production they need accounts with a verified address (FINDINGS F14).

## Deploying

`npx feltkit deploy` builds and boot-verifies a deployment artifact (container target by default). Production
needs `FELTKIT_CREDENTIAL_MI_KEYRING` (comma-separated `keyId:base64(32 bytes)`, first is primary),
`FELTKIT_CREDENTIAL_SHOPIFY_CLIENT_SECRET`, `FELTKIT_CREDENTIAL_QBO_CLIENT_SECRET`, the providers' real URLs
and client ids (`SHOPIFY_CLIENT_ID`, `QBO_*`, `STRIPE_API_BASE`) and `MI_PUBLIC_URL`. FeltKit's own deployment
guide: `npx feltkit docs PATH-TO-PRODUCTION`.

## Known limits

Stated in [`docs/experiment/PARITY.md`](../../docs/experiment/PARITY.md) ("Not at parity") and
[`docs/experiment/FINDINGS.md`](../../docs/experiment/FINDINGS.md). In short: nothing has run against real provider
accounts; the container image of the deployment was not built in this environment (F7); the production staff
path needs a mail service (F14); EVE is a second runtime to operate (F15–F18).

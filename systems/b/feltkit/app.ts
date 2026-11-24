/**
 * System B — managed integrations on FeltKit.
 *
 * Tenancy is FeltKit's: each customer company is a workspace. Its people hold `owner`; the provider's
 * staff join it by invitation as `operator`; the integration runtime (the `runtime` component, a
 * declared principal) is added as `runtime`. Every collection below except `adoptions` belongs to a
 * workspace, so FeltKit scopes every read and write to the caller's current one.
 */
import { feltkit, s } from "@feltdb/feltkit";

export const app = feltkit({
  name: "managed-integrations-b",
  description: "Managed integrations: adopted integration code operated, maintained and verified for each customer.",
  roles: {
    person: [],
    owner: ["mi.read", "mi.connect", "mi.configure", "mi.decide", "mi.operate", "tenant.*"],
    operator: ["mi.read", "mi.read.evidence", "mi.operate", "mi.maintain", "tenant.members.read"],
    runtime: ["mi.runtime", "mi.read", "jobs.create", "jobs.execute"],
    admin: ["credential.*", "configuration.*", "jobs.*", "schedules.*", "webhooks.*", "feltkit.operations.*"],
  },
  auth: {
    accounts: { roles: ["person"] },
    tenant: { name: "company", roles: ["owner", "operator", "runtime"], create: "anyone" },
  },
  dev: {
    users: [
      { id: "platform-admin", name: "Platform admin", roles: ["admin"] },
      // Provider staff in development; in production staff are accounts with a verified address.
      { id: "staff-1", name: "Operator One", roles: ["person"] },
      { id: "staff-2", name: "Operator Two", roles: ["person"] },
    ],
  },
  services: {
    configuration: true,
  },
  components: {
    runtime: {
      entry: "runtime/component.ts",
      routes: ["/rt/"],
      required: true,
      principal: { id: "component:runtime", roles: ["runtime"] },
      credentials: ["mi-keyring", "shopify-client-secret", "qbo-client-secret", "repair-agent"],
      network: "egress",
      description: "Receives provider webhooks, holds customer provider credentials, runs adopted integration code.",
    },
  },
});

const id = s.string();
const at = s.number();

/** Customer provider connections. Secrets are sealed by the runtime component; FeltDB holds ciphertext only. */
export const connections = app.collection(
  "connections",
  {
    tenantId: s.optional(s.string()),
    provider: s.enum(["shopify", "netsuite", "stripe", "quickbooks"]),
    status: s.enum(["pending", "connected", "verified", "error", "revoked", "disconnected"]),
    account: s.optional(s.string()),
    sealed: s.optional(s.string()),
    publicKeyPem: s.optional(s.string()),
    detail: s.optional(s.string()),
    updatedAt: at,
  },
  { tenant: true, unique: [["tenantId", "provider"]] },
);

/** One managed integration per workspace and kind: the adopted code it runs and the customer's settings. */
export const integrations = app.collection(
  "integrations",
  {
    tenantId: s.optional(s.string()),
    kind: s.enum(["order_sync", "ledgerly", "stripe_app", "qbo_tools", "native_sync"]),
    enabled: s.boolean(),
    settings: s.record(s.unknown()),
    status: s.enum(["protected", "maintaining", "verified", "customer_action", "checking"]),
    upstream: s.object({ repository: s.string(), commit: s.string() }),
    createdAt: at,
  },
  { tenant: true, unique: [["tenantId", "kind"]] },
);

/** Every inbound provider event, sealed, with what was done with it. */
export const receipts = app.collection(
  "receipts",
  {
    tenantId: s.optional(s.string()),
    integrationId: id,
    providerEventId: s.string(),
    topic: s.string(),
    apiVersion: s.optional(s.string()),
    sourceId: s.string(),
    origin: s.enum(["webhook", "reconciliation"]),
    sealed: s.string(),
    disposition: s.enum(["accepted", "duplicate_webhook", "already_delivered", "ignored_topic", "joined_recovery"]),
    receivedAt: at,
  },
  { tenant: true, unique: [["tenantId", "integrationId", "providerEventId"]] },
);

/** One delivery per source transaction (idempotencyKey = integration:source), with its attempt history. */
export const deliveries = app.collection(
  "deliveries",
  {
    tenantId: s.optional(s.string()),
    integrationId: id,
    sourceId: s.string(),
    reference: s.string(),
    idempotencyKey: s.string(),
    receiptId: id,
    status: s.enum(["queued", "running", "delivered", "rejected", "failed", "held", "awaiting_authorization"]),
    automaticAttempts: s.integer(),
    destinationRef: s.optional(s.string()),
    lastError: s.optional(s.string()),
    heldBy: s.optional(s.string()),
    nextAttemptAt: s.optional(at),
    attempts: s.array(
      s.object({ at, outcome: s.string(), detail: s.optional(s.string()), by: s.string(), correction: s.optional(s.string()) }),
    ),
    updatedAt: at,
  },
  { tenant: true, unique: [["tenantId", "idempotencyKey"]], indexes: [{ fields: ["integrationId", "status"] }] },
);

export const reconRuns = app.collection(
  "recon_runs",
  {
    integrationId: id,
    status: s.enum(["running", "completed", "failed"]),
    window: s.object({ from: s.string(), to: s.string() }),
    counts: s.record(s.integer()),
    requestedBy: s.string(),
    startedAt: at,
    finishedAt: s.optional(at),
    error: s.optional(s.string()),
  },
  { tenant: true },
);

export const reconItems = app.collection(
  "recon_items",
  {
    tenantId: s.optional(s.string()),
    runId: id,
    integrationId: id,
    sourceId: s.string(),
    reference: s.string(),
    classification: s.enum(["delivered", "missing_delivery", "pending_delivery", "failed_delivery", "destination_exists_untracked", "excluded"]),
    recovery: s.enum(["none", "requested", "recovered", "failed"]),
    deliveryId: s.optional(id),
    verifiedAt: s.optional(at),
  },
  { tenant: true, unique: [["tenantId", "runId", "sourceId"]] },
);

/**
 * A maintenance event: something changed at a boundary (source, target, provider, integration code) and
 * the integration is being kept whole. Timeline entries marked customerVisible form the customer's view.
 */
export const events = app.collection(
  "events",
  {
    integrationId: id,
    kind: s.string(),
    boundary: s.enum(["source", "target", "provider", "integration", "combined"]),
    status: s.enum(["detected", "investigating", "requires_action", "recovery", "verification", "resolved"]),
    dedupeKey: s.string(),
    /** Where the maintenance driver is (investigate, correct, validate, activate, recover, verify, account). */
    phase: s.optional(s.string()),
    reconRunId: s.optional(s.string()),
    finding: s.optional(s.record(s.unknown())),
    accounting: s.optional(s.object({ affected: s.integer(), delivered: s.integer(), unresolved: s.integer(), duplicates: s.integer() })),
    timeline: s.array(s.object({ at, status: s.string(), text: s.string(), customerVisible: s.boolean() })),
    openedAt: at,
    resolvedAt: s.optional(at),
  },
  { tenant: true, indexes: [{ fields: ["integrationId", "status"] }] },
);

/** Corrections: how a change is answered. Every transition is recorded in history. */
export const corrections = app.collection(
  "corrections",
  {
    integrationId: id,
    eventId: s.optional(id),
    kind: s.enum(["adapter", "patch", "configuration", "decision", "unsupported"]),
    status: s.enum(["proposed", "validating", "validated", "active", "rejected", "rolled_back", "unsupported"]),
    scopeKey: s.string(),
    spec: s.record(s.unknown()),
    validation: s.optional(s.object({ passed: s.boolean(), checks: s.array(s.object({ name: s.string(), result: s.enum(["passed", "failed", "not_applicable"]), detail: s.string() })) })),
    question: s.optional(s.object({ text: s.string(), options: s.array(s.string()), authority: s.enum(["customer", "operator"]) })),
    answer: s.optional(s.object({ choice: s.string(), by: s.string(), at })),
    /** What was observed after activation (e.g. the next request declared the patched behaviour). */
    postActivation: s.optional(s.record(s.unknown())),
    history: s.array(s.object({ at, from: s.string(), to: s.string(), by: s.string(), note: s.optional(s.string()) })),
    createdAt: at,
  },
  { tenant: true, indexes: [{ fields: ["integrationId", "status"] }] },
);

/** Onboarding position per workspace and kind. */
export const onboardings = app.collection(
  "onboardings",
  {
    tenantId: s.optional(s.string()),
    kind: s.string(),
    status: s.enum(["connect", "discovering", "confirm", "activating", "managed", "blocked"]),
    discovery: s.optional(s.record(s.unknown())),
    confirmedVersion: s.optional(s.integer()),
    steps: s.record(s.enum(["pending", "done", "failed"])),
    updatedAt: at,
  },
  { tenant: true, unique: [["tenantId", "kind"]] },
);

/**
 * One-time tickets a person's browser presents to the runtime component's routes (the FeltKit pattern for
 * reaching a component without a FeltKit session token). Not workspace-scoped: the component redeems a
 * ticket before it knows the workspace; the record carries it.
 */
export const tickets = app.collection(
  "tickets",
  { workspace: s.string(), purpose: s.string(), subject: s.string(), principal: s.string(), expiresAt: at, usedAt: s.optional(at) },
);

/** A hosted application's own records (what its database held), written only through its own code. */
export const appRecords = app.collection(
  "app_records",
  {
    tenantId: s.optional(s.string()),
    integrationId: s.string(),
    model: s.string(),
    key: s.string(),
    data: s.record(s.unknown()),
    sourceEventId: s.optional(s.string()),
    verified: s.optional(s.object({ at: s.number(), matches: s.boolean(), differs: s.array(s.string()) })),
    updatedAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "integrationId", "model", "key"]], indexes: [{ fields: ["integrationId", "model"] }] },
);

/** Requests to a hosted application's operations (deduplicated by the caller's request id). */
export const appRequests = app.collection(
  "app_requests",
  {
    tenantId: s.optional(s.string()),
    integrationId: s.string(),
    requestId: s.string(),
    operation: s.string(),
    input: s.record(s.unknown()),
    status: s.enum(["queued", "running", "succeeded", "failed", "awaiting_authorization", "unknown"]),
    result: s.optional(s.record(s.unknown())),
    attempts: s.array(s.object({ at: s.number(), outcome: s.string(), detail: s.optional(s.string()), correction: s.optional(s.string()) })),
    requestedBy: s.string(),
    heldBy: s.optional(s.string()),
    updatedAt: s.number(),
  },
  { tenant: true, unique: [["tenantId", "integrationId", "requestId"]] },
);

/** Runs of the native polling sync (cursor held unless every order in the window was delivered). */
export const syncRuns = app.collection(
  "sync_runs",
  {
    integrationId: s.string(),
    status: s.enum(["running", "succeeded", "failed"]),
    trigger: s.string(),
    engineVersion: s.integer(),
    canary: s.optional(s.integer()),
    cursorBefore: s.string(),
    cursorAfter: s.optional(s.string()),
    delivered: s.integer(),
    records: s.array(s.object({ sourceId: s.string(), reference: s.string(), outcome: s.string(), destinationRef: s.optional(s.string()) })),
    errorClass: s.optional(s.string()),
    errorMessage: s.optional(s.string()),
    startedAt: s.number(),
    finishedAt: s.optional(s.number()),
  },
  { tenant: true, indexes: [{ fields: ["integrationId", "startedAt"] }] },
);

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();

/* ----------------------------------- Identity & access ----------------------------------- */

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  lifecycle: text('lifecycle').notNull().default('onboarding'), // onboarding|active|suspended|offboarded
  settings: jsonb('settings').notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull(), // customer|operator
  tenantId: uuid('tenant_id').references(() => tenants.id),
  createdAt: createdAt(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(), // sha256 of the opaque session token
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  csrfToken: text('csrf_token').notNull(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: createdAt(),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorUserId: uuid('actor_user_id'),
    actorRole: text('actor_role').notNull(), // operator|customer|system
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    details: jsonb('details').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_target_idx').on(t.targetType, t.targetId)],
);

/* ----------------------------------- Providers & connections ----------------------------------- */

export const providers = pgTable('providers', {
  id: text('id').primaryKey(), // shopify|netsuite
  displayName: text('display_name').notNull(),
  apiVersion: text('api_version').notNull(),
  capabilities: jsonb('capabilities').notNull().default([]),
  documentation: jsonb('documentation').notNull().default([]),
  updatedAt: updatedAt(),
});

export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id),
    /** pending|authorized|verified|error|revoked|disconnected */
    status: text('status').notNull().default('pending'),
    /** Shop domain or NetSuite account id. Not secret. */
    externalAccount: text('external_account'),
    /** Provider API base URL (validated against an allowlist; SSRF protection). */
    baseUrl: text('base_url'),
    grantedScopes: text('granted_scopes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** AES-256-GCM envelope; never returned by any API. */
    credentialsCiphertext: text('credentials_ciphertext'),
    credentialsKeyId: text('credentials_key_id'),
    accessTokenExpiresAt: ts('access_token_expires_at'),
    refreshTokenExpiresAt: ts('refresh_token_expires_at'),
    oauthStateHash: text('oauth_state_hash'),
    oauthStateExpiresAt: ts('oauth_state_expires_at'),
    lastVerifiedAt: ts('last_verified_at'),
    verificationError: text('verification_error'),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('connections_tenant_provider_uq').on(t.tenantId, t.providerId)],
);

/* ----------------------------------- Contracts, versions, integrations ----------------------------------- */

export const integrationContracts = pgTable('integration_contracts', {
  version: text('version').primaryKey(),
  flowType: text('flow_type').notNull(),
  definition: jsonb('definition').notNull(),
  /** sha256 of the canonical JSON definition — makes accidental mutation detectable. */
  definitionSha256: text('definition_sha256').notNull(),
  publishedAt: createdAt(),
});

export const integrationVersions = pgTable('integration_versions', {
  id: text('id').primaryKey(), // impl-<sha12>
  sourceCommit: text('source_commit').notNull(),
  artifactPath: text('artifact_path').notNull(),
  artifactSha256: text('artifact_sha256').notNull(),
  /** candidate|validated|canary|released|rolled_back|retired */
  releaseState: text('release_state').notNull().default('candidate'),
  parentVersionId: text('parent_version_id'),
  createdAt: createdAt(),
});

export const integrations = pgTable(
  'integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    flowType: text('flow_type').notNull(),
    /** Customer-facing name; the AppPort capability contracts it. */
    displayName: text('display_name').notNull().default(''),
    config: jsonb('config').notNull(),
    /** Incremented on every configuration change (durable, optimistic by nature). */
    configVersion: integer('config_version').notNull().default(1),
    enabled: boolean('enabled').notNull().default(false),
    /** setup|active|paused */
    lifecycle: text('lifecycle').notNull().default('setup'),
    contractVersion: text('contract_version')
      .notNull()
      .references(() => integrationContracts.version),
    implementationVersionId: text('implementation_version_id').references(() => integrationVersions.id),
    /** When set, the next sync runs as a canary on this version before promotion. */
    canaryVersionId: text('canary_version_id').references(() => integrationVersions.id),
    /** healthy|degraded|failing|unknown — derived, recomputed by the reliability check */
    health: text('health').notNull().default('unknown'),
    /** Durable cursor: ISO timestamp watermark on Shopify updatedAt (inclusive). */
    cursorWatermark: text('cursor_watermark'),
    cursorUpdatedAt: ts('cursor_updated_at'),
    backfillCompletedAt: ts('backfill_completed_at'),
    lastSuccessfulSyncAt: ts('last_successful_sync_at'),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: ts('lease_expires_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('integrations_tenant_flow_uq').on(t.tenantId, t.flowType)],
);

/* ----------------------------------- Execution ----------------------------------- */

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id),
    /** backfill|incremental|redelivery|canary */
    mode: text('mode').notNull(),
    status: text('status').notNull().default('queued'),
    trigger: text('trigger').notNull(), // schedule|manual|recovery|release|resume
    implementationVersionId: text('implementation_version_id'),
    workerId: text('worker_id'),
    traceId: text('trace_id'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    heartbeatAt: ts('heartbeat_at'),
    cursorBefore: text('cursor_before'),
    cursorAfter: text('cursor_after'),
    pagesFetched: integer('pages_fetched').notNull().default(0),
    observedCount: integer('observed_count').notNull().default(0),
    deliveredCount: integer('delivered_count').notNull().default(0),
    alreadyDeliveredCount: integer('already_delivered_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    rejectedCount: integer('rejected_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    errorClass: text('error_class'),
    errorMessage: text('error_message'),
    /** Sanitised evidence: page boundaries, throttle observations, retry counts. */
    evidence: jsonb('evidence').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('sync_runs_integration_idx').on(t.integrationId, t.createdAt)],
);

export const deliveries = pgTable(
  'deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id),
    /** `${integrationId}:${sourceId}` — the durable idempotency key. */
    idempotencyKey: text('idempotency_key').notNull().unique(),
    sourceId: text('source_id').notNull(),
    sourceLegacyId: text('source_legacy_id').notNull(),
    sourceName: text('source_name').notNull(),
    sourceCreatedAt: ts('source_created_at').notNull(),
    /** updatedAt of the source version that was delivered (or attempted). */
    sourceUpdatedAt: ts('source_updated_at').notNull(),
    /** Latest updatedAt observed in the source; > sourceUpdatedAt means changed after delivery. */
    latestSourceUpdatedAt: ts('latest_source_updated_at').notNull(),
    externalId: text('external_id').notNull(),
    destinationId: text('destination_id'),
    outcome: text('outcome').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastErrorClass: text('last_error_class'),
    lastError: text('last_error'),
    validation: jsonb('validation').notNull().default({}),
    /** Non-PII summary used by reconciliation: line count, computed total, currency. */
    summary: jsonb('summary').notNull().default({}),
    firstSyncRunId: uuid('first_sync_run_id'),
    lastSyncRunId: uuid('last_sync_run_id'),
    deliveredAt: ts('delivered_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('deliveries_integration_outcome_idx').on(t.integrationId, t.outcome),
    index('deliveries_integration_source_idx').on(t.integrationId, t.sourceId),
  ],
);

export const deliveryAttempts = pgTable(
  'delivery_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => deliveries.id),
    syncRunId: uuid('sync_run_id').references(() => syncRuns.id),
    attemptNo: integer('attempt_no').notNull(),
    outcome: text('outcome').notNull(), // delivered|rejected|failed|skipped
    httpStatus: integer('http_status'),
    errorClass: text('error_class'),
    errorMessage: text('error_message'),
    destinationId: text('destination_id'),
    implementationVersionId: text('implementation_version_id'),
    evidence: jsonb('evidence').notNull().default({}),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at').notNull(),
  },
  (t) => [index('delivery_attempts_delivery_idx').on(t.deliveryId)],
);

export const observations = pgTable(
  'observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    integrationId: uuid('integration_id'),
    syncRunId: uuid('sync_run_id'),
    provider: text('provider').notNull(), // shopify|netsuite|internal
    kind: text('kind').notNull(), // error|schema_change|anomaly|rate_limit|info
    errorClass: text('error_class'),
    code: text('code'),
    message: text('message').notNull(),
    /** Sanitised via @mi/observability redact() before insert. */
    data: jsonb('data').notNull().default({}),
    traceId: text('trace_id'),
    implementationVersionId: text('implementation_version_id'),
    createdAt: createdAt(),
  },
  (t) => [index('observations_integration_idx').on(t.integrationId, t.createdAt)],
);

/* ----------------------------------- Reliability ----------------------------------- */

export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    integrationId: uuid('integration_id').references(() => integrations.id),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('detected'),
    severity: text('severity').notNull(), // low|medium|high|critical
    title: text('title').notNull(),
    reason: text('reason').notNull(),
    errorClass: text('error_class'),
    /** At most one open incident per dedupe key (partial unique index). */
    dedupeKey: text('dedupe_key').notNull(),
    affectedScope: jsonb('affected_scope').notNull().default({}),
    impact: text('impact'),
    customerSummary: text('customer_summary'),
    customerAction: text('customer_action'),
    evidence: jsonb('evidence').notNull().default({}),
    implementationVersionId: text('implementation_version_id'),
    resolution: text('resolution'),
    verification: jsonb('verification'),
    detectedAt: ts('detected_at').notNull().defaultNow(),
    resolvedAt: ts('resolved_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('incidents_open_dedupe_uq')
      .on(t.dedupeKey)
      .where(sql`status <> 'resolved'`),
    index('incidents_integration_idx').on(t.integrationId, t.status),
  ],
);

export const incidentEvents = pgTable(
  'incident_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actor: text('actor').notNull(), // system|operator:<id>|customer:<id>
    note: text('note').notNull(),
    customerVisible: boolean('customer_visible').notNull().default(true),
    evidence: jsonb('evidence').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('incident_events_incident_idx').on(t.incidentId, t.createdAt)],
);

export const reconciliationRuns = pgTable(
  'reconciliation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id),
    incidentId: uuid('incident_id'),
    trigger: text('trigger').notNull(), // schedule|manual|incident|release
    status: text('status').notNull().default('running'), // running|completed|failed
    outcome: text('outcome'), // consistent|discrepancies|partial|unknown
    windowFrom: ts('window_from').notNull(),
    windowTo: ts('window_to').notNull(),
    expectedCount: integer('expected_count').notNull().default(0),
    sourceCount: integer('source_count').notNull().default(0),
    destinationCount: integer('destination_count').notNull().default(0),
    matchedCount: integer('matched_count').notNull().default(0),
    missing: jsonb('missing').notNull().default([]),
    duplicates: jsonb('duplicates').notNull().default([]),
    inconsistent: jsonb('inconsistent').notNull().default([]),
    stale: jsonb('stale').notNull().default([]),
    unexpected: jsonb('unexpected').notNull().default([]),
    unresolved: jsonb('unresolved').notNull().default([]),
    recoveryEnqueued: integer('recovery_enqueued').notNull().default(0),
    errorMessage: text('error_message'),
    evidence: jsonb('evidence').notNull().default({}),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('reconciliation_runs_integration_idx').on(t.integrationId, t.startedAt)],
);

/* ----------------------------------- Maintenance & release ----------------------------------- */

export const maintenanceRuns = pgTable('maintenance_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  incidentId: uuid('incident_id').references(() => incidents.id),
  integrationId: uuid('integration_id').references(() => integrations.id),
  trigger: text('trigger').notNull(), // incident|operator
  /** queued|investigating|candidate_submitted|no_candidate|failed */
  status: text('status').notNull().default('queued'),
  planner: text('planner'), // playbook|anthropic
  baseVersionId: text('base_version_id'),
  agentSessionRef: text('agent_session_ref'),
  /** Sanitised summary of the bounded context the agent received. */
  context: jsonb('context').notNull().default({}),
  toolCalls: jsonb('tool_calls').notNull().default([]),
  hypothesis: text('hypothesis'),
  outcome: text('outcome'),
  cost: jsonb('cost').notNull().default({}),
  humanDecisions: jsonb('human_decisions').notNull().default([]),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  createdAt: createdAt(),
});

export const repairCandidates = pgTable('repair_candidates', {
  id: uuid('id').primaryKey().defaultRandom(),
  maintenanceRunId: uuid('maintenance_run_id')
    .notNull()
    .references(() => maintenanceRuns.id),
  baseVersionId: text('base_version_id').notNull(),
  baseCommit: text('base_commit').notNull(),
  branch: text('branch').notNull(),
  commitSha: text('commit_sha'),
  diff: text('diff').notNull(),
  changedFiles: text('changed_files').array().notNull(),
  hypothesis: text('hypothesis').notNull(),
  agentTestResults: jsonb('agent_test_results').notNull().default({}),
  /** submitted|validating|validated|validation_failed|approved|rejected|released|rolled_back */
  status: text('status').notNull().default('submitted'),
  integrationVersionId: text('integration_version_id'),
  decidedBy: uuid('decided_by'),
  decidedAt: ts('decided_at'),
  decisionNote: text('decision_note'),
  createdAt: createdAt(),
});

export const validationRuns = pgTable('validation_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  repairCandidateId: uuid('repair_candidate_id')
    .notNull()
    .references(() => repairCandidates.id),
  contractVersion: text('contract_version').notNull(),
  /** sha256 over the authoritative test suite files at the base commit. */
  testSuiteSha256: text('test_suite_sha256').notNull(),
  candidateCommit: text('candidate_commit').notNull(),
  status: text('status').notNull().default('running'), // running|passed|failed|error
  protectedPathsOk: boolean('protected_paths_ok'),
  results: jsonb('results').notNull().default({}),
  outputArtifact: text('output_artifact'),
  sandbox: jsonb('sandbox').notNull().default({}),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
});

export const releases = pgTable('releases', {
  id: uuid('id').primaryKey().defaultRandom(),
  repairCandidateId: uuid('repair_candidate_id').references(() => repairCandidates.id),
  integrationVersionId: text('integration_version_id')
    .notNull()
    .references(() => integrationVersions.id),
  previousVersionId: text('previous_version_id'),
  integrationId: uuid('integration_id')
    .notNull()
    .references(() => integrations.id),
  /** approved|canary|canary_failed|released|rolled_back */
  status: text('status').notNull(),
  approvedBy: uuid('approved_by').notNull(),
  approvedAt: ts('approved_at').notNull(),
  canarySyncRunId: uuid('canary_sync_run_id'),
  canaryResult: jsonb('canary_result'),
  postReleaseReconciliationId: uuid('post_release_reconciliation_id'),
  rollbackReason: text('rollback_reason'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

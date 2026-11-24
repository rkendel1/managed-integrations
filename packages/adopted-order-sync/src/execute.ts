/**
 * Executes one durable delivery with the ADOPTED upstream code. Managed Integrations supplies:
 * an atomic claim, the decrypted original payload, the tenant's configuration, and a freshly
 * minted NetSuite access token from the tenant's connection. The upstream code performs the
 * mapping, the NetSuite lookups, the upsert and its own retries, and returns its own result,
 * which is recorded verbatim as execution evidence.
 */
import { and, eq, inArray, lt } from 'drizzle-orm';
import type { UpstreamSyncResult } from 'shopify-sync/types';
import {
  deliveries,
  deliveryAttempts,
  integrations,
  observations,
  webhookReceipts,
  type Db,
} from '@mi/database';
import {
  ConnectionCredentials,
  type CredentialCipher,
  type ProviderEndpointConfig,
} from '@mi/integration-shopify-netsuite';
import { describeError, redact } from '@mi/observability';
import { AdoptedConfigSchema } from './contract.ts';
import { ADOPTED } from './provenance.ts';
import { type ContractViolation } from './input-contract.ts';
import { evaluateInput, runtimeFor, type RuntimeSelection } from './adaptation.ts';

// The shared execution boundary (claim, retry scheduling, retry requests) lives in @mi/managed.
import { claimDelivery, STUCK_AFTER_MS } from '@mi/managed';
export {
  MAX_AUTOMATIC_EXECUTIONS,
  nextAutomaticRetryDelaySeconds,
  requestDeliveryRetry,
  STUCK_AFTER_MS,
  type RetryRequestResult,
} from '@mi/managed';

export interface ExecutionTrigger {
  kind: 'webhook' | 'automatic_retry' | 'manual_retry' | 'reconciliation_recovery' | 'maintenance_recovery';
  maintenanceEventId?: string;
  runId?: string;
  principalId?: string;
  appportRequestId?: string;
  reason?: string;
}

export interface ExecuteParams {
  db: Db;
  cipher: CredentialCipher;
  endpoints: ProviderEndpointConfig;
  deliveryId: string;
  trigger: ExecutionTrigger;
}

export type ExecuteResult =
  | { executed: false; reason: 'not_claimable' }
  | {
      executed: true;
      /** held: the input does not satisfy what the adopted code reads; upstream was not run. */
      outcome: 'delivered' | 'rejected' | 'failed' | 'held';
      attemptNo: number;
      violations?: ContractViolation[];
      upstream: UpstreamSyncResult | null;
      errorClass: string | null;
      message: string | null;
    };

export async function executeDelivery(p: ExecuteParams): Promise<ExecuteResult> {
  const { db } = p;
  // Atomic claim: only one executor may run a delivery; stuck executions become claimable again.
  const claimed = await claimDelivery(db, p.deliveryId);
  if (!claimed) return { executed: false, reason: 'not_claimable' };
  const attemptNo = claimed.attempts;
  const startedAt = new Date();
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, claimed.integrationId));

  let upstream: UpstreamSyncResult | null = null;
  let outcome: 'delivered' | 'rejected' | 'failed' | 'held';
  let errorClass: string | null = null;
  let message: string | null = null;
  let violations: ContractViolation[] | undefined;
  let compatApplied: { target: string; source: string; count: number }[] = [];
  let apiVersion: string | null = null;
  // What runs: the adopted artifact (original or patched) and the active adapters (adaptations registry).
  let runtime: RuntimeSelection | null = null;
  try {
    const [receipt] = await db
      .select()
      .from(webhookReceipts)
      .where(eq(webhookReceipts.id, claimed.receiptId!));
    if (!receipt) throw Object.assign(new Error('Webhook receipt missing for delivery'), { mi: 'unknown' });
    const raw = Buffer.from(
      p.cipher.decrypt<string>(receipt.payloadCiphertext, `receipt:${receipt.id}`),
      'base64',
    );
    const config = AdoptedConfigSchema.parse(integ!.config);
    apiVersion = receipt.apiVersion;

    // Adoption boundary: apply validated compatibility rules, then check the input contract BEFORE upstream
    // runs. Upstream does not validate its input (a missing price becomes a null NetSuite rate), so an
    // input that violates the contract is held — nothing is written — and maintenance takes over.
    runtime = await runtimeFor(db, integ!.id);
    const adapted = evaluateInput(JSON.parse(raw.toString('utf8')), runtime);
    compatApplied = adapted.applied;
    const found = adapted.violations;
    if (found.length) {
      violations = found;
      throw Object.assign(
        new Error(
          `Input does not satisfy the adopted contract: ${found.map((v) => `${v.path} ${v.observed}`).join(', ')}`,
        ),
        { mi: 'input_contract' },
      );
    }

    // Managed Integrations owns authorization: resolve the tenant's NetSuite connection and mint a token.
    const creds = new ConnectionCredentials(db, p.cipher, p.endpoints);
    const conn = await creds.load(integ!.tenantId, 'netsuite');
    if (!conn?.baseUrl)
      throw Object.assign(new Error('NetSuite is not connected for this tenant'), { mi: 'authentication' });
    const accessToken = await creds.netsuiteAuth(conn).getAccessToken();

    // ---- upstream code from here on ----
    let order;
    try {
      order = runtime.artifact.modules.toCanonicalOrder(adapted.payload, {
        customerByEmail: config.customerByEmail,
        defaultCustomer: config.defaultCustomer,
      });
    } catch (err) {
      // Deterministic data problem (e.g. no line with a SKU): re-running cannot help.
      throw Object.assign(new Error(describeError(err).message), { mi: 'invalid_data' });
    }
    const m = runtime.artifact.modules;
    upstream = await m.syncOrder(m.createNetSuiteAdapter({ baseUrl: conn.baseUrl, accessToken }), order);
    // ---- end upstream ----

    if (upstream.status === 'created' || upstream.status === 'duplicate') {
      outcome = 'delivered';
    } else if (upstream.status === 'rejected') {
      outcome = 'rejected';
      errorClass = 'invalid_data';
      message = upstream.message;
    } else {
      // status 'failed': upstream classified it retryable and exhausted its own retries.
      outcome = 'failed';
      errorClass = 'transient';
      message = (upstream as { message: string }).message;
    }
  } catch (err) {
    const cls =
      (err as { mi?: string }).mi ??
      ((err as { errorClass?: string }).errorClass === 'authentication' ? 'authentication' : 'unknown');
    errorClass = cls;
    message = describeError(err).message;
    outcome = cls === 'invalid_data' ? 'rejected' : cls === 'input_contract' ? 'held' : 'failed';
  }

  const finishedAt = new Date();
  const destinationId = upstream && 'erpOrder' in upstream ? (upstream.erpOrder.id ?? null) : null;
  const evidence = {
    adopted: { repository: ADOPTED.repository, commit: ADOPTED.commit },
    trigger: p.trigger,
    upstreamResult: upstream ? (redact(upstream) as object) : null,
    apiVersion,
    // Exactly what ran: artifact id (pinned commit + patches) and the adaptations in force.
    artifact: runtime
      ? {
          id: runtime.artifact.id,
          patches: runtime.artifact.patches.map((x) => x.id),
          adaptations: runtime.adaptationIds,
        }
      : null,
    ...(compatApplied.length ? { inputCompatApplied: compatApplied } : {}),
    ...(violations ? { contractViolations: violations } : {}),
  };
  await db.transaction(async (tx) => {
    await tx
      .update(deliveries)
      .set({
        outcome,
        destinationId: destinationId ?? claimed.destinationId,
        lastErrorClass: errorClass,
        lastError: message ? String(redact(message)).slice(0, 1000) : null,
        ...(outcome === 'delivered' ? { deliveredAt: finishedAt } : {}),
        updatedAt: finishedAt,
      })
      .where(eq(deliveries.id, claimed.id));
    await tx.insert(deliveryAttempts).values({
      deliveryId: claimed.id,
      attemptNo,
      outcome,
      errorClass,
      errorMessage: message ? String(redact(message)).slice(0, 1000) : null,
      destinationId,
      implementationVersionId: runtime?.artifact.id ?? `adopted:${ADOPTED.commit.slice(0, 12)}`,
      evidence,
      startedAt,
      finishedAt,
    });
    // A held input is recorded by the maintenance event (finding), not as an execution error.
    if (outcome !== 'delivered' && outcome !== 'held') {
      await tx.insert(observations).values({
        tenantId: integ!.tenantId,
        integrationId: integ!.id,
        provider: errorClass === 'authentication' ? 'netsuite' : 'adopted',
        kind: 'error',
        errorClass,
        code: upstream?.status ?? 'EXECUTION_ERROR',
        message: `Order ${claimed.sourceName}: ${String(redact(message ?? 'failed'))}`.slice(0, 2000),
        data: { deliveryId: claimed.id, attemptNo, adoptedCommit: ADOPTED.commit },
        implementationVersionId: `adopted:${ADOPTED.commit.slice(0, 12)}`,
      });
    }
    if (outcome === 'delivered') {
      await tx
        .update(integrations)
        .set({ lastSuccessfulSyncAt: finishedAt, updatedAt: finishedAt })
        .where(eq(integrations.id, integ!.id));
    }
  });
  return {
    executed: true,
    outcome,
    attemptNo,
    upstream,
    errorClass,
    message,
    ...(violations ? { violations } : {}),
  };
}

/** Deliveries waiting longer than the stuck threshold (for operator visibility). */
export async function findStuckDeliveries(db: Db, integrationId: string) {
  return db
    .select()
    .from(deliveries)
    .where(
      and(
        eq(deliveries.integrationId, integrationId),
        inArray(deliveries.outcome, ['pending', 'running']),
        lt(deliveries.updatedAt, new Date(Date.now() - STUCK_AFTER_MS)),
      ),
    );
}

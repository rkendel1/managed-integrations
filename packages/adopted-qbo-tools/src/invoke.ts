/**
 * The application's create_invoice tool, run on the customer's behalf. Each request is a durable delivery
 * keyed by the caller's request id; it runs the application's own handler with the application's own client;
 * the invoice is then read back from QuickBooks and compared with the request.
 *
 * Exactly-once: QuickBooks invoice creation through this client is NOT idempotent (no requestid), so a
 * request is never re-sent once QuickBooks may have processed it. A request held for lost authorization was
 * refused by QuickBooks (invalid_grant at refresh, or 401 on the call): QuickBooks processed nothing, so it is
 * safe to run once after reconnection.
 */
import { eq } from 'drizzle-orm';
import { adaptations, deliveries, deliveryAttempts, integrations, type Db } from '@mi/database';
import type { CredentialCipher, ProviderEndpointConfig } from '@mi/integration-shopify-netsuite';
import { observeContract, openReauthorizationEvent, type ExecutionTrigger, type ReviewedDependencyChange } from '@mi/managed';
import { describeError, redact } from '@mi/observability';
import { AuthorizationLost, QuickBooksAccess } from '@mi/provider-connections';
import { and, inArray } from 'drizzle-orm';
import { dependencyChangeCatalog } from './artifact.ts';
import { QBO_TOOLS } from './descriptor.ts';
import { loadApplication } from './host.ts';

export interface HostDeps {
  db: Db;
  cipher: CredentialCipher;
  endpoints: ProviderEndpointConfig;
}
export interface InvoiceInput {
  txn_date: string;
  customer_name?: string;
  customer_id?: string;
  doc_number?: string;
  memo?: string;
  lines: { item_name?: string; item_id?: string; amount?: number; qty?: number; unit_price?: number; description?: string }[];
}

/** Active reviewed dependency changes of this integration: the artifact it runs. */
export async function activeChanges(db: Db, integrationId: string) {
  const rows = await db
    .select()
    .from(adaptations)
    .where(and(eq(adaptations.integrationId, integrationId), eq(adaptations.status, 'active'), inArray(adaptations.kind, ['patch'])));
  const catalog = dependencyChangeCatalog();
  return {
    ids: rows.map((r) => r.id),
    changes: rows.map((r) => catalog.find((c) => c.id === (r.spec as { dependencyChangeId?: string }).dependencyChangeId)!).filter(Boolean) as ReviewedDependencyChange[],
  };
}

/** What QuickBooks must show for a request: the customer, each line's item and amount, the total, the number. */
export function verifyInvoice(input: InvoiceInput, inv: Record<string, any> | null) {
  if (!inv) return { verified: false, problems: ['invoice not found in QuickBooks'] };
  const problems: string[] = [];
  const want = input.customer_id ?? input.customer_name;
  if (inv.CustomerRef?.value !== want && inv.CustomerRef?.name !== want) problems.push(`customer is ${inv.CustomerRef?.name}`);
  const lines = (inv.Line ?? []).filter((l: any) => l.DetailType === 'SalesItemLineDetail');
  const cents = (x: number) => Math.round(x * 100);
  const wantAmounts = input.lines.map((l) => (l.amount !== undefined ? l.amount : (l.qty ?? 1) * l.unit_price!));
  if (lines.length !== input.lines.length) problems.push(`${lines.length} lines, ${input.lines.length} requested`);
  input.lines.forEach((l, i) => {
    const got = lines[i];
    if (!got) return;
    const item = l.item_id ?? l.item_name;
    if (got.SalesItemLineDetail?.ItemRef?.value !== item && got.SalesItemLineDetail?.ItemRef?.name !== item) problems.push(`line ${i + 1} item is ${got.SalesItemLineDetail?.ItemRef?.name}`);
    if (cents(got.Amount) !== cents(wantAmounts[i]!)) problems.push(`line ${i + 1} amount is ${got.Amount}`);
  });
  if (cents(inv.TotalAmt) !== cents(wantAmounts.reduce((a, b) => a + b, 0))) problems.push(`total is ${inv.TotalAmt}`);
  if (input.doc_number && inv.DocNumber !== input.doc_number) problems.push(`number is ${inv.DocNumber}`);
  return { verified: problems.length === 0, problems };
}

export async function readInvoice(deps: HostDeps, tenantId: string, id: string) {
  const qbo = new QuickBooksAccess(deps.db, deps.cipher, deps.endpoints, tenantId);
  const { creds, apiBase } = await qbo.current();
  const res = await qbo.fetch(`${apiBase}/v3/company/${encodeURIComponent(creds.realmId)}/invoice/${encodeURIComponent(id)}?minorversion=75`);
  if (!res.ok) return null;
  return ((await res.json()) as { Invoice?: Record<string, any> }).Invoice ?? null;
}

export type RequestOutcome = 'delivered' | 'failed' | 'rejected' | 'awaiting_authorization';

/** Runs one recorded request (new, or released after reconnection). */
export async function executeRequest(deps: HostDeps, deliveryId: string, trigger: ExecutionTrigger) {
  const { db } = deps;
  const [d] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  if (!d || !['pending', 'awaiting_authorization'].includes(d.outcome)) return { executed: false as const, outcome: d?.outcome };
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, d.integrationId));
  const input = (d.summary as { input: InvoiceInput }).input;
  const startedAt = new Date();
  let outcome: RequestOutcome;
  let errorClass: string | null = null;
  let message: string | null = null;
  let invoiceId: string | null = null;
  let output = '';
  let verification: Record<string, unknown> = {};
  let artifactId = 'unknown';
  let reauthEventId: string | null = null;
  try {
    // Authorization first: if it is gone, nothing is sent and the request is held.
    const qbo = new QuickBooksAccess(db, deps.cipher, deps.endpoints, integ!.tenantId);
    let { creds, apiBase, connectionId } = await qbo.current();
    const { changes } = await activeChanges(db, integ!.id);
    const app = await loadApplication(changes, integ!.id);
    artifactId = app.artifact.id;
    await observeContract(db, { integrationId: integ!.id, boundary: 'integration', contract: 'quickbooks-mcp.artifact', shape: app.artifact.id, sample: { dependencies: app.artifact.dependencies } });
    let client = app.client({ accessToken: creds.accessToken, realmId: creds.realmId, apiBase });
    await observeContract(db, { integrationId: integ!.id, boundary: 'provider', provider: 'quickbooks', contract: 'quickbooks.client', shape: { minorversion: client['minorversion'] }, version: String(client['minorversion']), sample: { client: `node-quickbooks ${app.artifact.dependencies['node-quickbooks']}` } });
    const isAuthFault = (err: unknown) =>
      (err as { Fault?: { type?: string } }).Fault?.type === 'AUTHENTICATION' || /\b401\b|AuthenticationFailed/.test(String((err as Error)?.message ?? ''));
    try {
      let r;
      try {
        r = await app.handleCreateInvoice(client, { ...input, draft: false });
      } catch (err) {
        // QuickBooks refused the token (401): it processed nothing. Refresh; if authorization is gone the request
        // is held, otherwise it runs once more with the new token.
        if (!isAuthFault(err)) throw err;
        ({ creds, apiBase, connectionId } = await qbo.refresh(connectionId, true));
        client = app.client({ accessToken: creds.accessToken, realmId: creds.realmId, apiBase });
        r = await app.handleCreateInvoice(client, { ...input, draft: false });
      }
      output = r.content.map((c) => c.text).join('\n');
      invoiceId = /txnId=(\d+)/.exec(output)?.[1] ?? null;
    } catch (err) {
      if (err instanceof AuthorizationLost) throw err;
      const fault = (err as { Fault?: { Error?: { code?: string; Message?: string; Detail?: string }[]; type?: string } }).Fault;
      message = fault ? `${fault.Error?.[0]?.Message} (${fault.Error?.[0]?.code}): ${fault.Error?.[0]?.Detail}` : describeError(err).message;
      throw Object.assign(new Error(message), { fault, refused: !!fault && fault.type === 'ValidationFault' || /not found/i.test(message) });
    }
    const inv = invoiceId ? await readInvoice(deps, integ!.tenantId, invoiceId) : null;
    verification = { invoiceId, ...verifyInvoice(input, inv), total: inv?.TotalAmt ?? null };
    outcome = verification['verified'] ? 'delivered' : 'failed';
    if (!verification['verified']) {
      errorClass = 'verification';
      message = `QuickBooks shows something else: ${(verification['problems'] as string[]).join('; ')}`;
    }
  } catch (err) {
    if (err instanceof AuthorizationLost) {
      outcome = 'awaiting_authorization';
      errorClass = 'authentication';
      message = err.message;
      reauthEventId = (await openReauthorizationEvent(db, integ!, QBO_TOOLS, [{ provider: 'quickbooks', state: /invalid_grant|revoked/i.test(err.message) ? 'revoked' : 'expired', detail: err.message }])).id;
    } else if ((err as { refused?: boolean }).refused) {
      outcome = 'rejected';
      errorClass = 'refused';
      message = (err as Error).message;
    } else {
      // The request may have reached QuickBooks: never re-sent automatically (invoice create is not idempotent).
      outcome = 'failed';
      errorClass = 'unknown_outcome';
      message = (err as Error).message;
    }
  }
  const finishedAt = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(deliveries)
      .set({
        outcome,
        lastErrorClass: errorClass,
        lastError: message ? String(redact(message)).slice(0, 1000) : null,
        destinationId: invoiceId,
        validation: { ...verification, output: output.slice(0, 2000) },
        attempts: d.attempts + (outcome === 'awaiting_authorization' ? 0 : 1),
        ...(outcome === 'delivered' ? { deliveredAt: finishedAt } : {}),
        updatedAt: finishedAt,
      })
      .where(eq(deliveries.id, d.id));
    await tx.insert(deliveryAttempts).values({
      deliveryId: d.id,
      attemptNo: d.attempts + 1,
      outcome,
      errorClass,
      errorMessage: message ? String(redact(message)).slice(0, 1000) : null,
      destinationId: invoiceId,
      implementationVersionId: artifactId,
      evidence: { trigger, artifact: artifactId, verification, quickbooksProcessed: outcome === 'awaiting_authorization' ? false : 'see verification' },
      startedAt,
      finishedAt,
    });
  });
  return { executed: true as const, outcome, errorClass, message, invoiceId, verification, output, reauthEventId };
}

/** A new request from the customer: recorded once per request id, then run. */
export async function invokeCreateInvoice(
  deps: HostDeps,
  p: { integrationId: string; input: InvoiceInput; requestId: string; principalId: string },
) {
  const { db } = deps;
  const key = `${p.integrationId}:request:${p.requestId}`;
  const now = new Date();
  const label = `Invoice request ${p.input.doc_number ?? p.requestId}`;
  const [fresh] = await db
    .insert(deliveries)
    .values({
      integrationId: p.integrationId,
      idempotencyKey: key,
      sourceId: `request:${p.requestId}`,
      sourceLegacyId: p.requestId,
      sourceName: label,
      sourceCreatedAt: now,
      sourceUpdatedAt: now,
      latestSourceUpdatedAt: now,
      externalId: p.input.doc_number ?? p.requestId,
      outcome: 'pending',
      summary: { operation: 'create_invoice', input: p.input, by: p.principalId },
    })
    .onConflictDoNothing()
    .returning();
  if (!fresh) {
    const [prev] = await db.select().from(deliveries).where(eq(deliveries.idempotencyKey, key));
    return { deliveryId: prev!.id, outcome: prev!.outcome, output: (prev!.validation ?? {}) as Record<string, unknown>, verification: (prev!.validation ?? {}) as Record<string, unknown>, replayed: true };
  }
  const r = await executeRequest(deps, fresh.id, { kind: 'manual_retry', principalId: p.principalId });
  return {
    deliveryId: fresh.id,
    outcome: r.outcome ?? 'pending',
    output: { text: r.executed ? r.output : '', invoiceId: r.executed ? r.invoiceId : null, ...(r.executed && r.message ? { message: r.message } : {}), ...(r.executed && r.reauthEventId ? { reauthEventId: r.reauthEventId } : {}) },
    verification: r.executed ? r.verification : {},
    replayed: false,
  };
}

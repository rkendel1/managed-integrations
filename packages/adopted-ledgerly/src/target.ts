/**
 * Target-boundary maintenance for Stripe → QuickBooks (slice 7).
 *
 * 1. target_contract_change — QuickBooks stops accepting what the integration writes because the customer's
 *    company changed (here: an account the mapping posts to was made inactive; Intuit refuses with 610).
 *    Invariant: the same Stripe money lands on the same KIND of account, balanced, exactly once; nothing already
 *    in the books is rewritten. Which account replaces it is a financial decision → the customer decides among
 *    evidence-backed candidates (active accounts of the same type); the resulting configuration correction is
 *    validated (and rejected if it breaks the invariant, e.g. a different account type), then held work is
 *    released, reconciled and verified, and accounted for.
 * 2. destination_mismatch — QuickBooks accepted the write (success response) but keeps different accounts or
 *    amounts. We never edit or delete entries in the customer's books: unsupported automatic correction; the
 *    affected entries are listed, the customer is asked to review, and NO zero-loss claim is made.
 */
import { and, eq } from 'drizzle-orm';
import { deliveries, incidents, integrations, type Db } from '@mi/database';
import {
  acceptContract,
  correctionsOf,
  escalate,
  fingerprintOf,
  MAINTENANCE_ACTOR,
  note,
  openMaintenanceEvent,
  recordAdaptation,
  requestDecision,
  setFacts,
  type AdaptationRow,
  type DecisionSpec,
} from '@mi/managed';
import { transitionIncident, type IncidentRow } from '@mi/reliability';
import {
  accountsById,
  activateLedgerlyAdaptation,
  allAccounts,
  BASE_ARTIFACT,
  validateLedgerlyAdaptation,
  type AccountMapSpec,
} from './adaptation.ts';
import { LedgerlyConfigSchema } from './contract.ts';
import { recoverAndVerify, type LedgerlyAdvance, type MaintainDeps, type Progress } from './maintenance.ts';
import { QuickBooksAccess } from './providers.ts';

interface TargetFinding {
  provider: 'quickbooks';
  contract: string;
  observed: { code: string; detail: string };
  inactiveAccounts: { qboId: string; name: string; code: string; type: string }[];
  firstTransaction: string;
  lastAcceptedAt: string | null;
  detectedAt: string;
}

/** Detection: a write was refused for a target-contract reason; confirm it against QuickBooks itself. */
export async function recordTargetContractChange(
  deps: Pick<MaintainDeps, 'db' | 'cipher' | 'endpoints'>,
  deliveryId: string,
  fault: { code: string; detail: string; accountIds: string[] },
) {
  const { db } = deps;
  const [d] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, d!.integrationId));
  const config = LedgerlyConfigSchema.parse(integ!.config);
  const qbo = new QuickBooksAccess(db, deps.cipher, deps.endpoints, integ!.tenantId);
  // Evidence beyond the error message: QuickBooks' own account records.
  const accts = await accountsById(qbo, fault.accountIds.filter(Boolean));
  const inactive = accts
    .filter((a) => !a.Active)
    .map((a) => ({
      qboId: a.Id,
      name: a.Name,
      type: a.AccountType,
      code: Object.entries(config.accountMap).find(([, v]) => v.qboId === a.Id)?.[0] ?? '?',
    }));
  const [lastOk] = await db
    .select({ at: deliveries.deliveredAt })
    .from(deliveries)
    .where(and(eq(deliveries.integrationId, integ!.id), eq(deliveries.outcome, 'delivered')))
    .orderBy(deliveries.deliveredAt)
    .limit(1);
  const finding: TargetFinding = {
    provider: 'quickbooks',
    contract: 'JournalEntry create: account references',
    observed: { code: fault.code, detail: fault.detail },
    inactiveAccounts: inactive,
    firstTransaction: d!.sourceName,
    lastAcceptedAt: lastOk?.at?.toISOString() ?? null,
    detectedAt: new Date().toISOString(),
  };
  const names = inactive.map((a) => a.name).join(', ') || 'an account';
  const { incident } = await openMaintenanceEvent(db, {
    tenantId: integ!.tenantId,
    integrationId: integ!.id,
    kind: 'target_contract_change',
    boundary: 'target', provider: 'quickbooks',
    severity: 'high',
    title: 'QuickBooks no longer accepts the account mapping',
    reason: `QuickBooks refused a journal entry (${fault.code}): ${names} is inactive`,
    customerSummary: `An account in QuickBooks that your Stripe entries post to (${names}) was made inactive. Affected transactions are held safely.`,
    customerNote: `An account in your QuickBooks (${names}) was made inactive, so QuickBooks stopped accepting the entries that use it. We are holding those transactions safely; nothing is lost.`,
    classifyAs: 'investigating',
    classificationNote: 'Target acceptance changed; affected transactions held (nothing written).',
    finding,
  });
  return incident;
}

/** Detection: a write succeeded but the record QuickBooks keeps differs from what was sent. */
export async function recordDestinationMismatch(db: Db, deliveryId: string, m: { journalEntryIds: string[]; detail: string }) {
  const [d] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, d!.integrationId));
  const { incident } = await openMaintenanceEvent(db, {
    tenantId: integ!.tenantId,
    integrationId: integ!.id,
    kind: 'destination_mismatch',
    boundary: 'target', provider: 'quickbooks',
    severity: 'high',
    title: 'QuickBooks keeps different entries than were written',
    reason: m.detail,
    customerSummary: 'Some entries in QuickBooks differ from what we wrote. Please review them.',
    customerNote: 'QuickBooks accepted entries we wrote, but now holds different accounts or amounts for them — something in your company changes entries after they are saved. We have not changed anything in your books.',
    customerAction: 'Review the listed entries in QuickBooks.',
    classifyAs: 'requires_action',
    classificationNote: 'Write succeeded but read-back verification failed; no automatic correction of the customer’s books.',
    finding: { provider: 'quickbooks', transactions: [d!.sourceName], journalEntryIds: m.journalEntryIds, detail: m.detail, detectedAt: new Date().toISOString() },
  });
  return incident;
}

const optionsFor = async (deps: MaintainDeps, integ: typeof integrations.$inferSelect, acct: TargetFinding['inactiveAccounts'][number], exclude: string[]) => {
  const qbo = new QuickBooksAccess(deps.db, deps.cipher, deps.endpoints, integ.tenantId);
  const all = await allAccounts(qbo);
  // Candidates: active accounts of the SAME type (the money keeps its accounting meaning); the customer chooses.
  return all
    .filter((a) => a.Active && a.AccountType === acct.type && a.Id !== acct.qboId && !exclude.includes(a.Id))
    .map((a) => ({ id: a.Id, label: a.Name, detail: a.AccountType }));
};

export async function advanceTargetContract(deps: MaintainDeps, inc: IncidentRow, prog: Progress): Promise<LedgerlyAdvance> {
  const { db } = deps;
  const f = inc.finding as TargetFinding;
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, inc.integrationId!));
  if (!f.inactiveAccounts.length) return escalate(db, inc, 'QuickBooks refused writes but no inactive account could be confirmed');
  const acct = f.inactiveAccounts[0]!;
  if (!inc.impactAssessment) {
    const held = await db
      .select({ id: deliveries.id, name: deliveries.sourceName })
      .from(deliveries)
      .where(and(eq(deliveries.integrationId, inc.integrationId!), eq(deliveries.outcome, 'held'), eq(deliveries.lastErrorClass, 'target_contract')));
    const impact = {
      boundary: 'target', provider: 'quickbooks',
      contract: f.contract,
      operations: [`JournalEntry create with ${acct.name} (${acct.code})`],
      affectedTransactions: held.map((h) => h.name),
      unaffected: 'transactions that do not post to this account continue normally',
      codePath: 'none: the adopted code is unchanged; the account comes from the integration configuration (accountMap)',
    };
    await setFacts(db, inc.id, { impactAssessment: impact, investigation: { heldTransactions: held.length, inactive: f.inactiveAccounts } });
    return { state: 'continue', detail: 'impact assessed' };
  }
  const corrections = await correctionsOf(db, inc.id);
  const decisions = corrections.filter((c) => c.kind === 'decision');
  const configs = corrections.filter((c) => c.kind === 'configuration');
  const lastDecision = decisions.at(-1);
  const lastConfig = configs.at(-1);
  const needDecision = !lastDecision || (lastConfig?.status === 'rejected' && (lastConfig.spec as unknown as AccountMapSpec).decisionId === lastDecision.id);
  if (needDecision) {
    const rejected = configs.filter((c) => c.status === 'rejected').map((c) => (c.spec as unknown as AccountMapSpec).to.qboId);
    const options = await optionsFor(deps, integ!, acct, rejected);
    if (!options.length) {
      const reason = `No active ${acct.type} account can replace ${acct.name}; a person must decide`;
      await recordAdaptation(db, { integrationId: integ!.id, maintenanceEventId: inc.id, kind: 'unsupported', boundary: 'target', provider: 'quickbooks', artifact: BASE_ARTIFACT, dependency: { provider: 'quickbooks', contract: f.contract }, codePath: {}, spec: { reason }, rationale: reason, actor: MAINTENANCE_ACTOR });
      return escalate(db, inc, reason);
    }
    const dec = await requestDecision(db, {
      integrationId: integ!.id,
      maintenanceEventId: inc.id,
      boundary: 'target', provider: 'quickbooks',
      question: `${acct.name} was made inactive in QuickBooks. Which account should Stripe entries that used it post to from now on?`,
      options,
      authority: 'customer',
      rationale: lastConfig?.status === 'rejected' ? 'The previous choice failed validation; choose again' : 'Financial treatment: only the customer can choose the account',
      impact: inc.impactAssessment as Record<string, unknown>,
      actor: MAINTENANCE_ACTOR,
    });
    await db.update(incidents).set({ customerAction: `Choose the QuickBooks account that replaces ${acct.name}.`, updatedAt: new Date() }).where(eq(incidents.id, inc.id));
    if (inc.status !== 'requires_action')
      await transitionIncident(db, inc.id, 'requires_action', { actor: MAINTENANCE_ACTOR, note: 'Waiting for the customer to choose an account', customerVisible: false });
    await note(db, inc, lastConfig?.status === 'rejected' ? 'The account you chose could not be used safely (different account type). Please choose again.' : `Please choose which QuickBooks account replaces ${acct.name}.`, true, { step: 'decision_requested', decisionId: dec.id });
    return { state: 'noop', detail: 'waiting for the customer to decide' };
  }
  if (lastDecision.status === 'proposed') return { state: 'noop', detail: 'waiting for the customer to decide' };
  const choice = (lastDecision.spec as unknown as DecisionSpec).choice!;
  if (!lastConfig || (lastConfig.spec as unknown as AccountMapSpec).decisionId !== lastDecision.id) {
    const chosen = ((lastDecision.spec as unknown as DecisionSpec).options.find((o) => o.id === choice))!;
    const spec: AccountMapSpec = { type: 'account_map', code: acct.code, from: { qboId: acct.qboId, name: acct.name }, to: { qboId: choice, name: chosen.label }, decisionId: lastDecision.id };
    await recordAdaptation(db, {
      integrationId: integ!.id,
      maintenanceEventId: inc.id,
      kind: 'configuration',
      boundary: 'target', provider: 'quickbooks',
      artifact: BASE_ARTIFACT,
      dependency: { provider: 'quickbooks', contract: f.contract, observed: f.observed },
      codePath: { configuration: `accountMap.${acct.code}` },
      spec: spec as unknown as Record<string, unknown>,
      rationale: `Post ${acct.code} entries to ${chosen.label} instead of the inactive ${acct.name} (customer decision ${lastDecision.id})`,
      impact: inc.impactAssessment as Record<string, unknown>,
      evidence: { finding: f, decision: lastDecision.spec },
      actor: MAINTENANCE_ACTOR,
    });
    await db.update(incidents).set({ customerAction: null, updatedAt: new Date() }).where(eq(incidents.id, inc.id));
    return { state: 'continue', detail: 'configuration proposed from the customer decision' };
  }
  if (lastConfig.status === 'proposed' || lastConfig.status === 'validating') {
    const v = await validateLedgerlyAdaptation(db, deps.cipher, deps.endpoints, lastConfig.id);
    await setFacts(db, inc.id, { validation: v.validation });
    if (v.status !== 'validated') {
      await note(db, inc, 'Validation of the chosen account failed; transactions stay held.', false, { step: 'validation_failed', checks: (v.validation as { checks: unknown }).checks });
      return { state: 'continue', detail: 'validation failed; asking again' };
    }
    await note(db, inc, 'We checked the new account against your earlier transactions: amounts, sides and balance are unchanged and existing entries stay as they are.', true, { step: 'tested', checks: (v.validation as { checks: unknown }).checks });
    return { state: 'continue', detail: 'validated' };
  }
  if (lastConfig.status === 'validated') {
    // Authority: the customer decided; the configuration is validated and reversible → switched on by maintenance.
    const row: AdaptationRow = await activateLedgerlyAdaptation(db, lastConfig.id, MAINTENANCE_ACTOR, `Customer decision ${lastDecision.id}; validated`);
    await setFacts(db, inc.id, {
      correction: { adaptationId: row.id, kind: 'configuration', decisionId: lastDecision.id, boundary: 'target configuration (account mapping)', upstreamModified: false, derivedAt: row.createdAt.toISOString(), activatedAt: row.activatedAt!.toISOString() },
    });
    await acceptContract(db, inc.integrationId!, 'quickbooks.journalentry.write', fingerprintOf(`refused:${f.observed.code}`));
    return { state: 'continue', detail: 'configuration active' };
  }
  if (lastConfig.status !== 'active') return escalate(db, inc, `correction ${lastConfig.status}`);
  const [first] = await db.select().from(deliveries).where(and(eq(deliveries.integrationId, inc.integrationId!), eq(deliveries.sourceName, f.firstTransaction)));
  const from = new Date(Math.min(Date.parse(f.detectedAt), first?.sourceCreatedAt.getTime() ?? Date.now()) - 3600_000);
  return recoverAndVerify(deps, inc, prog, from, 'QuickBooks account replaced by the customer’s choice; held transactions posted and verified.', lastConfig.id);
}

export async function advanceDestinationMismatch(deps: MaintainDeps, inc: IncidentRow): Promise<LedgerlyAdvance> {
  const { db } = deps;
  if (inc.correction) return { state: 'escalated', detail: 'with a person' };
  const f = inc.finding as { transactions: string[]; journalEntryIds: string[]; detail: string };
  const reason =
    'QuickBooks keeps different accounts or amounts than were written. We do not edit or delete entries in the customer’s books; the entries are listed for review.';
  const row = await recordAdaptation(db, {
    integrationId: inc.integrationId!,
    maintenanceEventId: inc.id,
    kind: 'unsupported',
    boundary: 'target', provider: 'quickbooks',
    artifact: BASE_ARTIFACT,
    dependency: { provider: 'quickbooks', contract: 'JournalEntry as stored' },
    codePath: {},
    spec: { reason, journalEntryIds: f.journalEntryIds },
    rationale: reason,
    impact: { affectedTransactions: f.transactions, journalEntryIds: f.journalEntryIds },
    actor: MAINTENANCE_ACTOR,
  });
  await setFacts(db, inc.id, {
    impactAssessment: { boundary: 'target', provider: 'quickbooks', affectedTransactions: f.transactions, journalEntryIds: f.journalEntryIds, detail: f.detail },
    correction: { adaptationId: row.id, kind: 'unsupported', derivable: false, reason, upstreamModified: false, derivedAt: new Date().toISOString() },
  });
  return escalate(db, inc, reason);
}


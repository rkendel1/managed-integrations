/**
 * A changed provider contract as a maintenance INPUT, on the existing lifecycle (@mi/managed): the contracts are
 * kept as contract observations (baseline → observed), the change is attributed to the adopted application, and a
 * reviewable maintenance event is opened only when the application is affected. Nothing beyond "impact
 * identified" is implied: correction, validation, activation and verification stay with the event's lifecycle and
 * need their own evidence.
 */
import { and, eq } from 'drizzle-orm';
import { contractObservations, integrations, type Db } from '@mi/database';
import { observeContract, openMaintenanceEvent } from '@mi/managed';
import { diffContracts, impactOf, type ImpactReport, type UsageManifest } from './diff.ts';
import { subset, type NormalizedContract } from './normalize.ts';

export async function checkContractChange(
  db: Db,
  p: { integrationId: string; provider: string; from: NormalizedContract; to: NormalizedContract; usage: UsageManifest },
): Promise<{ report: ImpactReport; eventId: string | null; changes: number }> {
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, p.integrationId));
  if (!integ) throw new Error('Unknown integration');
  const contract = `openapi:${p.provider}`;
  const keys = p.usage.operations.map((o) => o.key);
  const schemas = [...new Set(p.usage.reads.map((r) => r.schema))];
  const keep = (c: NormalizedContract) => {
    const ops = keys.filter((k) => c.operations[k]);
    const sub = subset(c, ops, schemas.filter((s) => c.schemas[s]));
    return { version: c.version, contractHash: c.contractHash, source: c.source, usedSubset: { operations: sub.operations, schemas: sub.schemas } };
  };
  // The contract the application was adopted against is the baseline (kept, never overwritten).
  const [baseline] = await db.select().from(contractObservations).where(and(eq(contractObservations.integrationId, p.integrationId), eq(contractObservations.contract, contract)));
  if (!baseline)
    await observeContract(db, { integrationId: p.integrationId, boundary: 'provider', provider: p.provider, contract, version: p.from.version, shape: p.from.contractHash, sample: keep(p.from) });
  const changes = diffContracts(p.from, p.to);
  const report = impactOf(changes, p.usage, p.from, p.to);
  await observeContract(db, { integrationId: p.integrationId, boundary: 'provider', provider: p.provider, contract, version: p.to.version, shape: p.to.contractHash, sample: { ...keep(p.to), impact: { verdict: report.verdict, affected: report.affected.length } } });
  if (report.verdict !== 'affected_breaking') return { report, eventId: null, changes: changes.length };
  const { incident } = await openMaintenanceEvent(db, {
    tenantId: integ.tenantId,
    integrationId: integ.id,
    kind: 'provider_contract_change',
    severity: 'medium',
    title: `${p.provider} contract ${p.from.version} → ${p.to.version} changes what your application uses`,
    reason: `${report.affected.filter((i) => i.change.breaking).length} breaking change(s) to operations or fields the application uses`,
    customerSummary: `${p.provider} published a new version of its API that changes data your application uses. Nothing has changed for you yet; we are assessing it.`,
    customerNote: `${p.provider} published a new API version that changes data your application uses. We are checking exactly what it affects before anything changes.`,
    classifyAs: 'investigating',
    classificationNote: 'Contract change attributed to the application (impact identified; no correction implied)',
    boundary: 'provider',
    provider: p.provider,
    finding: {
      provider: p.provider,
      contract,
      observed: { apiVersion: p.to.version },
      expected: { apiVersion: p.from.version },
      contracts: [{ contract, baselineVersion: p.from.version, observedVersion: p.to.version, removed: report.affected.filter((i) => i.change.kind.endsWith('removed')).map((i) => `${i.change.subject}.${i.change.field ?? ''}`), added: [] }],
      mismatches: [],
      source: { from: p.from.source, to: p.to.source },
      detectedAt: new Date().toISOString(),
      detector: 'contract comparison (no traffic yet)',
    },
  });
  const { setFacts } = await import('@mi/managed');
  await setFacts(db, incident.id, {
    impactAssessment: {
      boundary: 'provider',
      provider: p.provider,
      stage: 'impact identified',
      from: report.from,
      to: report.to,
      affected: report.affected.map((i) => ({ kind: i.change.kind, breaking: i.change.breaking, subject: i.change.subject, field: i.change.field ?? null, usedAt: i.usedAt })),
      unaffectedBreakingElsewhere: report.unaffectedBreaking,
    },
  });
  return { report, eventId: incident.id, changes: changes.length };
}

/**
 * The three maintenance boundaries of an integration (slice 7).
 *
 *   source       — the application the integration reads from: API/contract version, event and payload
 *                  structure, field representation, authentication, delivery behaviour, semantics;
 *   integration  — the adopted implementation: pinned artifact, provenance, dependencies, mapping behaviour,
 *                  integration-owned configuration, active adapters and patches, execution behaviour;
 *   target       — the application the integration writes to: write contract and version, required fields,
 *                  acceptance and business rules, authentication, semantics.
 *
 * `combined` marks a maintenance window in which more than one boundary changed.
 *
 * Provider-centric (slice 7 scope correction): `source` and `target` are ROLES a provider plays in a
 * pipeline; `provider` is a provider an adopted application depends on in any other role (both, or a
 * standalone dependency). Every provider-side fact also names its provider, so "what changed in Stripe" is
 * one query whether Stripe is a pipeline's source or the only dependency of an application.
 *
 * Durable representation: every observation of a contract (a source payload shape, a target's acceptance or
 * rejection class, the artifact that ran) is recorded by fingerprint in `contract_observations`. The first
 * fingerprint seen for a contract is its baseline; a later, different fingerprint is DRIFT — a fact with first
 * and last sighting and a sample, not a log line. A correction that answers the drift accepts the new
 * fingerprint, so "what version is active" is always queryable per boundary.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { contractObservations, type Db } from '@mi/database';

export const BOUNDARIES = ['source', 'integration', 'target', 'provider', 'combined'] as const;
export type Boundary = (typeof BOUNDARIES)[number];

export const fingerprintOf = (v: unknown) =>
  createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 16);

export interface Observation {
  integrationId: string;
  boundary: Exclude<Boundary, 'combined'>;
  contract: string;
  /** The provider; defaults to the contract's first segment ("stripe.event…" → stripe) for provider-side boundaries. */
  provider?: string | null;
  version?: string | null;
  /** What identifies this contract variant: a shape, an acceptance class, an artifact id. */
  shape: unknown;
  sample?: Record<string, unknown>;
}

/** Records an observation. Returns whether it is drift from the contract's baseline. */
export async function observeContract(db: Db, o: Observation) {
  const fingerprint = fingerprintOf(o.shape);
  const [existing] = await db
    .select()
    .from(contractObservations)
    .where(and(eq(contractObservations.integrationId, o.integrationId), eq(contractObservations.contract, o.contract)))
    .orderBy(asc(contractObservations.firstSeenAt))
    .limit(1);
  const [row] = await db
    .insert(contractObservations)
    .values({
      integrationId: o.integrationId,
      boundary: o.boundary,
      provider: o.provider !== undefined ? o.provider : o.boundary === 'integration' ? null : o.contract.split('.')[0]!,
      contract: o.contract,
      version: o.version ?? null,
      fingerprint,
      status: existing ? 'observed' : 'baseline',
      sample: o.sample ?? {},
    })
    .onConflictDoUpdate({
      target: [contractObservations.integrationId, contractObservations.contract, contractObservations.fingerprint],
      set: { count: sql`${contractObservations.count} + 1`, lastSeenAt: new Date(), version: o.version ?? null },
    })
    .returning();
  return { observation: row!, drift: row!.status === 'observed' };
}

/** A correction answered this variant: it becomes an accepted contract (history kept). */
export async function acceptContract(db: Db, integrationId: string, contract: string, fingerprint: string) {
  await db
    .update(contractObservations)
    .set({ status: 'accepted' })
    .where(
      and(
        eq(contractObservations.integrationId, integrationId),
        eq(contractObservations.contract, contract),
        eq(contractObservations.fingerprint, fingerprint),
        eq(contractObservations.status, 'observed'),
      ),
    );
}

/** Per boundary and contract: baseline, every variant seen, and whether unanswered drift exists. */
export async function boundaryState(db: Db, integrationId: string) {
  const rows = await db
    .select()
    .from(contractObservations)
    .where(eq(contractObservations.integrationId, integrationId))
    .orderBy(asc(contractObservations.firstSeenAt));
  const byContract = new Map<string, typeof rows>();
  for (const r of rows) byContract.set(r.contract, [...(byContract.get(r.contract) ?? []), r]);
  return [...byContract.entries()].map(([contract, variants]) => ({
    contract,
    boundary: variants[0]!.boundary,
    provider: variants[0]!.provider,
    baseline: variants.find((v) => v.status === 'baseline') ?? null,
    latest: [...variants].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())[0]!,
    drift: variants.some((v) => v.status === 'observed'),
    variants: variants.map((v) => ({
      fingerprint: v.fingerprint,
      version: v.version,
      status: v.status,
      count: v.count,
      firstSeenAt: v.firstSeenAt.toISOString(),
      lastSeenAt: v.lastSeenAt.toISOString(),
      sample: v.sample,
    })),
  }));
}

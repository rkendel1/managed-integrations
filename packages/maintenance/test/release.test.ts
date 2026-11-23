import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  integrations,
  integrationVersions,
  maintenanceRuns,
  releases,
  repairCandidates,
  validationRuns,
} from '@mi/database';
import {
  buildRuntime,
  sourceImplementation,
  type IntegrationImplementation,
} from '@mi/integration-shopify-netsuite';
import { approveCandidate, rollbackRelease, runRelease } from '../src/release.ts';
import { createHarness, FAST_RETRY, testCipher, type Harness } from '../../../test/support/harness.ts';

const OPERATOR = '00000000-0000-4000-8000-000000000009';
let h: Harness;

async function validatedCandidate(versionId: string) {
  const { db } = h.dbh;
  await db.insert(integrationVersions).values([
    {
      id: 'impl-base',
      sourceCommit: 'a'.repeat(40),
      artifactPath: '/n/a',
      artifactSha256: 'x',
      releaseState: 'released',
    },
    {
      id: versionId,
      sourceCommit: 'b'.repeat(40),
      artifactPath: '/n/a',
      artifactSha256: 'y',
      releaseState: 'validated',
    },
  ]);
  await db
    .update(integrations)
    .set({ implementationVersionId: 'impl-base' })
    .where(eq(integrations.id, h.integrationId));
  const [mr] = await db
    .insert(maintenanceRuns)
    .values({ integrationId: h.integrationId, trigger: 'operator', status: 'candidate_submitted' })
    .returning();
  const [cand] = await db
    .insert(repairCandidates)
    .values({
      maintenanceRunId: mr!.id,
      baseVersionId: 'impl-base',
      baseCommit: 'a'.repeat(40),
      branch: 'repair/t',
      commitSha: 'b'.repeat(40),
      diff: '',
      changedFiles: [],
      hypothesis: 'test',
      status: 'validated',
      integrationVersionId: versionId,
    })
    .returning();
  await db
    .insert(validationRuns)
    .values({
      repairCandidateId: cand!.id,
      contractVersion: '1.0.0',
      testSuiteSha256: 'h',
      candidateCommit: 'b'.repeat(40),
      status: 'passed',
      protectedPathsOk: true,
    });
  return cand!;
}

const runtimeWith = (impl: IntegrationImplementation) => (id: string, o?: { useCanary?: boolean }) =>
  buildRuntime(
    {
      db: h.dbh.db,
      cipher: testCipher,
      endpoints: h.endpoints,
      workerId: 't',
      retry: FAST_RETRY,
      implementationOverride: impl,
    },
    id,
    o,
  );

beforeEach(async () => {
  h = await createHarness();
  h.shopify.control.seedOrders(4, { start: new Date(Date.now() - 3600_000) });
});
afterEach(() => h.close());

describe('release safety', () => {
  it('rolls back automatically when the canary fails, keeping the previous version pinned', async () => {
    const cand = await validatedCandidate('impl-broken');
    const { releaseId } = await approveCandidate(h.dbh.db, {
      candidateId: cand.id,
      operatorUserId: OPERATOR,
    });
    const broken: IntegrationImplementation = {
      ...sourceImplementation,
      ordersQuery: 'query { orders(first: 1) { nodes { doesNotExist } pageInfo { hasNextPage endCursor } } }',
    };
    const r = await runRelease({
      db: h.dbh.db,
      releaseId,
      buildRuntime: runtimeWith(broken),
      retry: FAST_RETRY,
    });
    expect(r.status).toBe('rolled_back');
    const [integ] = await h.dbh.db.select().from(integrations).where(eq(integrations.id, h.integrationId));
    expect(integ!.implementationVersionId).toBe('impl-base');
    expect(integ!.canaryVersionId).toBeNull();
    const [rel] = await h.dbh.db.select().from(releases).where(eq(releases.id, releaseId));
    expect(rel!.status).toBe('rolled_back');
    expect(rel!.rollbackReason).toMatch(/Canary failed/);
    const [v] = await h.dbh.db
      .select()
      .from(integrationVersions)
      .where(eq(integrationVersions.id, 'impl-broken'));
    expect(v!.releaseState).toBe('rolled_back');
    expect(h.netsuite.state.salesOrders.size).toBe(0);
  });

  it('promotes a healthy canary, then an operator can roll back to the previous version', async () => {
    const cand = await validatedCandidate('impl-good');
    const { releaseId } = await approveCandidate(h.dbh.db, {
      candidateId: cand.id,
      operatorUserId: OPERATOR,
    });
    await expect(
      approveCandidate(h.dbh.db, { candidateId: cand.id, operatorUserId: OPERATOR }),
    ).rejects.toThrow(/validated/);
    const r = await runRelease({
      db: h.dbh.db,
      releaseId,
      buildRuntime: runtimeWith(sourceImplementation),
      retry: FAST_RETRY,
      canaryLimit: 2,
    });
    expect(r.status).toBe('released');
    let [integ] = await h.dbh.db.select().from(integrations).where(eq(integrations.id, h.integrationId));
    expect(integ!.implementationVersionId).toBe('impl-good');
    expect(h.netsuite.state.salesOrders.size).toBe(4);

    await rollbackRelease(h.dbh.db, { releaseId, operatorUserId: OPERATOR, reason: 'regression reported' });
    [integ] = await h.dbh.db.select().from(integrations).where(eq(integrations.id, h.integrationId));
    expect(integ!.implementationVersionId).toBe('impl-base');
    const audits = await h.dbh.db.select().from(auditLog).where(eq(auditLog.action, 'release.rollback'));
    expect(audits).toHaveLength(1);
    await expect(
      rollbackRelease(h.dbh.db, { releaseId, operatorUserId: OPERATOR, reason: 'again' }),
    ).rejects.toThrow(/Only a released/);
  });
});

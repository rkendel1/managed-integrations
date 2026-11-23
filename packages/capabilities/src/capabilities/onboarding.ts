/**
 * Customer onboarding capabilities (slice 5): Connect → Discover → Confirm → Protect.
 * Always the caller's own tenant (from trusted identity; no tenant or integration ids in the input), so a
 * customer can never read or confirm another tenant's onboarding. Connecting systems stays on the existing
 * connection routes (OAuth redirects); these capabilities cover what happens after.
 *
 *  onboarding.status@1    where onboarding stands, what we found, what we need, and what we will maintain
 *  onboarding.discover@1  look (again) for the existing integration in the connected systems
 *  onboarding.confirm@1   the customer's explicit decision: maintain this integration, with these responsibilities
 */
import { defineCapability, type CapabilityDefinition } from '@appport/core';
import { errors } from '@appport/protocol';
import { s } from '@appport/schema';
import { and, eq, inArray } from 'drizzle-orm';
import {
  confirmOnboarding,
  getOnboarding,
  OnboardingError,
  RESPONSIBILITIES,
  type Discovery,
} from '@mi/adopted-order-sync';
import { connections, type Db } from '@mi/database';
import { AppPortPermissions, tenantIdOf } from '../identity.ts';

export type RunOnboardingDiscovery = (tenantId: string) => Promise<void>;
export type EnqueueOnboardingActivation = (tenantId: string) => Promise<void>;

const ownTenant = (principal: Parameters<typeof tenantIdOf>[0]) => {
  const t = tenantIdOf(principal);
  if (!t) throw errors.forbidden('Onboarding belongs to a customer account');
  return t;
};

const STEP_TEXT: Record<string, string> = {
  connect: 'Connect Shopify and NetSuite.',
  discovering: 'Looking for your integration…',
  confirm: 'We found your integration. Confirm that you’d like us to maintain it.',
  select: 'Choose the integration you’d like us to maintain.',
  activating: 'Setting up protection: routing new orders to us and checking every recent order.',
  managed: 'Your Shopify → NetSuite integration is under management.',
  blocked: 'Something needs attention before we can continue.',
};

export interface OnboardingView {
  status: string;
  next: string;
  connections: {
    shopify: { connected: boolean; account: string | null };
    netsuite: { connected: boolean; account: string | null };
  };
  discovery: {
    outcome: string;
    window: { from: string; to: string };
    checked: number;
    candidates: { id: string; kind: string; title: string; summary: string; confidence: string | null }[];
  } | null;
  responsibilities: typeof RESPONSIBILITIES;
  confirmation: { candidateId: string; at: string } | null;
  activation: { steps: { label: string; done: boolean }[]; baseline: Record<string, unknown> | null } | null;
  integrationId: string | null;
  problem: string | null;
}

async function view(db: Db, tenantId: string): Promise<OnboardingView> {
  const ob = await getOnboarding(db, tenantId);
  const conns = await db
    .select()
    .from(connections)
    .where(and(eq(connections.tenantId, tenantId), inArray(connections.providerId, ['shopify', 'netsuite'])));
  const c = (p: string) => {
    const r = conns.find((x) => x.providerId === p);
    return {
      connected: !!r && ['authorized', 'verified'].includes(r.status) && !!r.credentialsCiphertext,
      account: r?.externalAccount ?? null,
    };
  };
  const d = ob.discovery as Discovery | null;
  const steps = (ob.activation as { steps?: Record<string, unknown> } | null)?.steps ?? null;
  return {
    status: ob.status,
    next: STEP_TEXT[ob.status] ?? '',
    connections: { shopify: c('shopify'), netsuite: c('netsuite') },
    discovery: d
      ? {
          outcome: d.outcome,
          window: d.window,
          checked: d.sampled,
          candidates: d.candidates.map((x) => ({
            id: x.id,
            kind: x.kind,
            title: x.title,
            summary: x.summary,
            confidence: x.confidence,
          })),
        }
      : null,
    responsibilities: RESPONSIBILITIES,
    confirmation: ob.confirmation
      ? {
          candidateId: (ob.confirmation as { candidateId: string }).candidateId,
          at: (ob.confirmation as { at: string }).at,
        }
      : null,
    activation: steps
      ? {
          steps: [
            { label: 'New Shopify orders come to us', done: !!steps['webhook'] },
            { label: 'Every recent order checked against NetSuite', done: !!steps['history'] },
            { label: 'Independent second check', done: !!steps['baselineResult'] },
          ],
          baseline: (steps['baselineResult'] as Record<string, unknown> | undefined) ?? null,
        }
      : null,
    integrationId: ob.integrationId,
    problem: ob.problem,
  };
}

const viewSchema = s.object({
  status: s.string(),
  next: s.string(),
  connections: s.unknown(),
  discovery: s.unknown(),
  responsibilities: s.unknown(),
  confirmation: s.unknown(),
  activation: s.unknown(),
  integrationId: s.nullable(s.string()),
  problem: s.nullable(s.string()),
});

export function createOnboardingStatusCapability(
  db: Db,
): CapabilityDefinition<Record<string, never>, Record<string, unknown>> {
  return defineCapability({
    name: 'onboarding.status',
    version: 1,
    description:
      'Where the customer’s onboarding stands: connected systems, the integration we found (with the evidence in plain language), what we will maintain and what access we use, setup progress, and the next step.',
    effect: 'observation',
    authorization: [AppPortPermissions.read],
    input: s.object({}),
    output: viewSchema,
    async handler(_input, context) {
      return { ...(await view(db, ownTenant(context.principal))) };
    },
  });
}

export function createOnboardingDiscoverCapability(
  db: Db,
  run: RunOnboardingDiscovery | undefined,
): CapabilityDefinition<Record<string, never>, Record<string, unknown>> {
  return defineCapability({
    name: 'onboarding.discover',
    version: 1,
    description:
      'Looks for the customer’s existing Shopify → NetSuite integration using their authorized connections (recent Shopify orders and the NetSuite sales orders that reference them).',
    effect: 'consequential',
    authorization: [AppPortPermissions.operate],
    input: s.object({}),
    output: viewSchema,
    async handler(_input, context) {
      if (!run) throw errors.internal('Discovery is not available in this process');
      const tenantId = ownTenant(context.principal);
      await run(tenantId);
      return { ...(await view(db, tenantId)) };
    },
  });
}

export function createOnboardingConfirmCapability(
  db: Db,
  enqueue: EnqueueOnboardingActivation | undefined,
): CapabilityDefinition<{ candidateId: string; responsibilitiesVersion: string }, Record<string, unknown>> {
  return defineCapability({
    name: 'onboarding.confirm',
    version: 1,
    description:
      'The customer’s explicit decision: maintain this integration, accepting the listed responsibilities and access (by version). Starts protection; management becomes active only after the first full check.',
    effect: 'consequential',
    authorization: [AppPortPermissions.operate],
    input: s.object({
      candidateId: s.string({ minLength: 3, maxLength: 200 }),
      responsibilitiesVersion: s.string({ maxLength: 20 }),
    }),
    output: viewSchema,
    async handler(input, context) {
      if (!enqueue) throw errors.internal('Activation is not available in this process');
      const tenantId = ownTenant(context.principal);
      try {
        await confirmOnboarding(db, tenantId, { ...input, userId: context.principal?.id ?? 'unknown' });
      } catch (err) {
        if (err instanceof OnboardingError) throw errors.conflict(err.message);
        throw err;
      }
      await enqueue(tenantId);
      return { ...(await view(db, tenantId)) };
    },
  });
}

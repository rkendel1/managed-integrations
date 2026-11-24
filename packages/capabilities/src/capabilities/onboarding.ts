/**
 * Customer onboarding capabilities (slice 5; several integrations per customer since slice 6):
 * Connect → Discover → Confirm → Protect. Always the caller's own tenant (from trusted identity; no tenant
 * or integration ids in the input), so a customer can never read or confirm another tenant's onboarding.
 * Connecting systems stays on the existing connection routes (OAuth redirects); these capabilities cover
 * what happens after. Which discovery and activation run is decided internally, by integration kind; the
 * customer never chooses implementations, adapters or monitoring.
 *
 *  onboarding.status@1    where onboarding stands: connected systems, each integration we found (with the
 *                         evidence in plain language), what we will maintain, setup progress, next step
 *  onboarding.discover@1  look (again) for existing integrations in the connected systems
 *  onboarding.confirm@1   the customer's explicit decision: maintain this integration, with these responsibilities
 */
import { defineCapability, type CapabilityDefinition } from '@appport/core';
import { errors } from '@appport/protocol';
import { s } from '@appport/schema';
import { eq } from 'drizzle-orm';
import { connections, type Db } from '@mi/database';
import {
  confirmOnboarding,
  getOnboarding,
  OnboardingError,
  overallStatus,
  systemsReady,
  type Discovery,
  type IntegrationRegistry,
  type OnboardingImplementation,
  type OnboardingRow,
} from '@mi/managed';
import { AppPortPermissions, tenantIdOf } from '../identity.ts';

export type RunOnboardingDiscovery = (tenantId: string) => Promise<void>;
export type EnqueueOnboardingActivation = (tenantId: string, flowType: string) => Promise<void>;

const ownTenant = (principal: Parameters<typeof tenantIdOf>[0]) => {
  const t = tenantIdOf(principal);
  if (!t) throw errors.forbidden('Onboarding belongs to a customer account');
  return t;
};

function stepText(status: string, impl: OnboardingImplementation): string {
  const d = impl.descriptor;
  return (
    (
      {
        connect: `Connect ${d.providers.map((x) => x.name).join(' and ')}.`,
        discovering: 'Looking for your integration…',
        confirm: 'We found your integration. Confirm that you’d like us to maintain it.',
        select: 'Choose the integration you’d like us to maintain.',
        activating: `Setting up protection: routing new ${d.transactions.many} to us and checking every recent one.`,
        managed: `Your ${d.name} integration is under management.`,
        blocked: 'Something needs attention before we can continue.',
      } as Record<string, string>
    )[status] ?? ''
  );
}
const OVERALL: Record<string, string> = {
  connect: 'Connect the systems your integration uses.',
  discovering: 'Looking for your integrations…',
  confirm: 'We found an integration. Confirm that you’d like us to maintain it.',
  select: 'Choose the integration you’d like us to maintain.',
  activating: 'Setting up protection.',
  managed: 'Your integrations are under management.',
  blocked: 'Something needs attention before we can continue.',
};

interface IntegrationOnboardingView {
  flowType: string;
  name: string;
  process: string;
  systems: string[];
  status: string;
  next: string;
  discovery: {
    outcome: string;
    window: { from: string; to: string };
    checked: number;
    candidates: { id: string; kind: string; title: string; summary: string; confidence: string | null }[];
  } | null;
  responsibilities: OnboardingImplementation['descriptor']['responsibilities'];
  confirmation: { candidateId: string; at: string } | null;
  activation: { steps: { label: string; done: boolean }[]; baseline: Record<string, unknown> | null } | null;
  integrationId: string | null;
  problem: string | null;
}

function viewOne(impl: OnboardingImplementation, ob: OnboardingRow): IntegrationOnboardingView {
  const d = ob.discovery as Discovery | null;
  const act = ob.activation as { steps?: Record<string, unknown>; done?: string[] } | null;
  const done = new Set(act?.done ?? []);
  const managed = ob.status === 'managed';
  return {
    flowType: impl.descriptor.flowType,
    name: impl.descriptor.name,
    process: impl.descriptor.process,
    systems: impl.descriptor.providers.map((x) => x.name),
    status: ob.status,
    next: stepText(ob.status, impl),
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
    responsibilities: impl.descriptor.responsibilities,
    confirmation: ob.confirmation
      ? {
          candidateId: (ob.confirmation as { candidateId: string }).candidateId,
          at: (ob.confirmation as { at: string }).at,
        }
      : null,
    activation: act
      ? {
          steps: impl.steps.map((st) => ({ label: st.label, done: managed || done.has(st.key) })),
          baseline: (act.steps?.['baselineResult'] as Record<string, unknown> | undefined) ?? null,
        }
      : null,
    integrationId: ob.integrationId,
    problem: ob.problem,
  };
}

export interface OnboardingView {
  status: string;
  next: string;
  /** Every business system a supported integration uses, and whether it is connected. */
  systems: { id: string; name: string; connected: boolean; account: string | null }[];
  integrations: IntegrationOnboardingView[];
}

async function view(
  db: Db,
  registry: IntegrationRegistry | undefined,
  tenantId: string,
): Promise<OnboardingView> {
  const impls = registry?.onboardable() ?? [];
  const conns = await db.select().from(connections).where(eq(connections.tenantId, tenantId));
  const connected = new Set(
    conns
      .filter((c) => ['authorized', 'verified'].includes(c.status) && !!c.credentialsCiphertext)
      .map((c) => c.providerId),
  );
  const systems = new Map<string, { id: string; name: string; connected: boolean; account: string | null }>();
  for (const impl of impls)
    for (const p of impl.descriptor.providers)
      systems.set(p.id, {
        id: p.id,
        name: p.name,
        connected: connected.has(p.id),
        account: conns.find((c) => c.providerId === p.id)?.externalAccount ?? null,
      });
  const rows: IntegrationOnboardingView[] = [];
  for (const impl of impls) {
    const ob = await getOnboarding(db, tenantId, impl.descriptor.flowType);
    // An integration kind appears once its systems are connected or something has happened for it.
    if (ob.status === 'connect' && !systemsReady(impl.descriptor, connected)) continue;
    rows.push(viewOne(impl, ob));
  }
  const status = overallStatus(rows);
  return { status, next: OVERALL[status] ?? '', systems: [...systems.values()], integrations: rows };
}

const viewSchema = s.object({
  status: s.string(),
  next: s.string(),
  systems: s.unknown(),
  integrations: s.unknown(),
});

export function createOnboardingStatusCapability(
  db: Db,
  registry: IntegrationRegistry | undefined,
): CapabilityDefinition<Record<string, never>, Record<string, unknown>> {
  return defineCapability({
    name: 'onboarding.status',
    version: 1,
    description:
      'Where the customer’s onboarding stands: the business systems they can connect, each integration we found in them (with the evidence in plain language), what we will maintain and what access we use, setup progress, and the next step.',
    effect: 'observation',
    authorization: [AppPortPermissions.read],
    input: s.object({}),
    output: viewSchema,
    async handler(_input, context) {
      return { ...(await view(db, registry, ownTenant(context.principal))) };
    },
  });
}

export function createOnboardingDiscoverCapability(
  db: Db,
  registry: IntegrationRegistry | undefined,
  run: RunOnboardingDiscovery | undefined,
): CapabilityDefinition<Record<string, never>, Record<string, unknown>> {
  return defineCapability({
    name: 'onboarding.discover',
    version: 1,
    description:
      'Looks for the customer’s existing integrations using their authorized connections (for each supported integration whose systems are connected, the evidence its own discovery reads).',
    effect: 'consequential',
    authorization: [AppPortPermissions.operate],
    input: s.object({}),
    output: viewSchema,
    async handler(_input, context) {
      if (!run) throw errors.internal('Discovery is not available in this process');
      const tenantId = ownTenant(context.principal);
      await run(tenantId);
      return { ...(await view(db, registry, tenantId)) };
    },
  });
}

export function createOnboardingConfirmCapability(
  db: Db,
  registry: IntegrationRegistry | undefined,
  enqueue: EnqueueOnboardingActivation | undefined,
): CapabilityDefinition<
  { candidateId: string; responsibilitiesVersion: string; flowType?: string },
  Record<string, unknown>
> {
  return defineCapability({
    name: 'onboarding.confirm',
    version: 1,
    description:
      'The customer’s explicit decision: maintain this integration, accepting the listed responsibilities and access (by version). Starts protection; management becomes active only after the first full check. flowType names the integration when more than one awaits a decision.',
    effect: 'consequential',
    authorization: [AppPortPermissions.operate],
    input: s.object({
      candidateId: s.string({ minLength: 3, maxLength: 200 }),
      responsibilitiesVersion: s.string({ maxLength: 20 }),
      flowType: s.optional(s.string({ maxLength: 200 })),
    }),
    output: viewSchema,
    async handler(input, context) {
      if (!enqueue) throw errors.internal('Activation is not available in this process');
      const tenantId = ownTenant(context.principal);
      const impls = registry?.onboardable() ?? [];
      let impl = input.flowType ? impls.find((i) => i.descriptor.flowType === input.flowType) : undefined;
      if (!impl) {
        const waiting: OnboardingImplementation[] = [];
        for (const i of impls) {
          const ob = await getOnboarding(db, tenantId, i.descriptor.flowType);
          const d = ob.discovery as Discovery | null;
          if (
            ['confirm', 'select'].includes(ob.status) &&
            d?.candidates.some((c) => c.id === input.candidateId)
          )
            waiting.push(i);
        }
        if (waiting.length !== 1)
          throw errors.conflict(
            waiting.length
              ? 'More than one integration awaits a decision; name it (flowType)'
              : 'Nothing to confirm',
          );
        impl = waiting[0]!;
      }
      try {
        await confirmOnboarding(db, tenantId, impl, {
          candidateId: input.candidateId,
          responsibilitiesVersion: input.responsibilitiesVersion,
          userId: context.principal?.id ?? 'unknown',
        });
      } catch (err) {
        if (err instanceof OnboardingError) throw errors.conflict(err.message);
        throw err;
      }
      await enqueue(tenantId, impl.descriptor.flowType);
      return { ...(await view(db, registry, tenantId)) };
    },
  });
}

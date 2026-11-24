/**
 * The integration maintenance contract (slice 6): the smallest description the generic machinery needs
 * to take responsibility for an integration. It is DATA — what the integration is, what it depends on,
 * what we can observe, recover, verify and correct for it, and what we cannot — so the customer product,
 * the operator view and the generic lifecycles can work with any integration without knowing its
 * providers. Behaviour lives in each integration's runtime (runtime.ts), not here.
 *
 * A descriptor must describe actual capabilities: every `implemented` entry is exercised by that
 * integration's tests; everything else is listed as `not_supported` or under `limitations`.
 */

export interface ProviderRef {
  /** Connection provider id (connections.provider_id). */
  id: string;
  name: string;
}

/** What the customer authorizes when they put the integration under management (versioned). */
export interface Responsibilities {
  version: string;
  maintain: readonly string[];
  access: readonly string[];
  verify: readonly string[];
}

/** Where the executed code comes from. Null for software we wrote ourselves. */
export interface AdoptedProvenance {
  repository: string;
  commit: string;
  license: string;
  package: string;
  /** How it is attached: an unmodified, commit-pinned dependency. */
  attachment: 'dependency';
  /** The only upstream entry points Managed Integrations calls. */
  entryPoints: readonly string[];
  /** Upstream behaviour deliberately not used, and why. */
  notUsed: readonly string[];
}

export const MONITORING_SIGNALS = [
  'source_available',
  'destination_available',
  'credentials',
  'activity',
  'processing',
  'delayed',
  'missing',
  'duplicated',
  'rejected',
  'contract_change',
  'destination_verification',
  'commitment_boundary',
] as const;
export type MonitoringSignal = (typeof MONITORING_SIGNALS)[number];

export const CORRECTION_PATTERNS = [
  'field_moved',
  'precision',
  'api_version_pin',
  'reauthorization',
  'pagination_or_rate_limit',
  'destination_contract',
  'business_meaning',
] as const;
export type CorrectionPattern = (typeof CORRECTION_PATTERNS)[number];

export interface IntegrationDescriptor {
  /** integrations.flow_type: the identity of the integration implementation. */
  flowType: string;
  /** Customer-facing name of a managed integration of this kind. */
  name: string;
  /** What business process it supports, in one sentence. */
  process: string;
  source: ProviderRef;
  destination: ProviderRef;
  /** The business transaction it moves and the destination record it produces. */
  transactions: {
    one: string;
    many: string;
    /** Destination record, e.g. "sales order", "journal entry". */
    record: string;
    /** What "the same business data" means when verified, e.g. "items, quantities and prices". */
    businessData: string;
  };
  /** The implementation that executes, or null when it is ours (native). */
  adopted: AdoptedProvenance | null;
  execution: {
    /** How work arrives: provider notification, schedule, or both. */
    trigger: string;
    /** What enforces exactly-once at the destination. */
    idempotency: string;
  };
  /** Provider contracts the executed code depends on. */
  dependencies: readonly { provider: string; contract: string; version: string; usedFor: string }[];
  capabilities: {
    /** How an existing integration of this kind is recognised from connected systems, or null. */
    discovery: string | null;
    monitoring: readonly { signal: MonitoringSignal; method: string }[];
    recovery: string;
    /** Destination verification independent of execution success. */
    verification: string;
    corrections: readonly {
      pattern: CorrectionPattern;
      status: 'implemented' | 'not_supported';
      note: string;
    }[];
  };
  limitations: readonly string[];
  /** Null when the integration cannot be self-onboarded. */
  responsibilities: Responsibilities | null;
}

export function describedSignals(d: IntegrationDescriptor): Set<MonitoringSignal> {
  return new Set(d.capabilities.monitoring.map((m) => m.signal));
}

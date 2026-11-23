/**
 * The AppPort application: the capability contract and authority boundary shared by every
 * consumer. Transports (HTTP/MCP) and the UI are projections of this object, not alternatives.
 */
import { createApplication, type AppPortApplication } from '@appport/core';
import type { Logger } from '@appport/core';
import type { Db } from '@mi/database';
import { combineAuthorizers } from '@appport/authorization';
import type { TelemetrySink } from '@appport/core';
import { integrationsAuthorizer, resourceTenantAuthorizer } from './authorization.ts';
import {
  createDeliveriesListCapability,
  createDeliveryGetCapability,
  createDeliveryRetryCapability,
  type EnqueueDeliveryExecution,
} from './capabilities/deliveries.ts';
import {
  createReconciliationItemsCapability,
  createReconciliationRecoverCapability,
  createReconciliationRunsCapability,
  createReconciliationStartCapability,
  type EnqueueReconciliationScan,
  type EnqueueRecovery,
} from './capabilities/reconciliation.ts';
import { createIntegrationsListCapability } from './capabilities/integrations-list.ts';
import {
  createMaintenanceEventGetCapability,
  createMaintenanceEvidenceCapability,
  createPortfolioIntegrationCapability,
  createPortfolioListCapability,
} from './capabilities/product.ts';
import {
  createAdaptationActivateCapability,
  createAdaptationProposeCapability,
  createAdaptationRejectCapability,
  createAdaptationRollbackCapability,
  createAdaptationsInspectCapability,
  createAdaptationValidateCapability,
  type EnqueueAdaptationValidation,
} from './capabilities/adaptations.ts';
import {
  createOnboardingConfirmCapability,
  createOnboardingDiscoverCapability,
  createOnboardingStatusCapability,
  type EnqueueOnboardingActivation,
  type RunOnboardingDiscovery,
} from './capabilities/onboarding.ts';

export const APPPORT_APPLICATION = {
  id: 'io.managedintegrations.app',
  name: 'Managed Integrations',
  version: '0.1.0',
} as const;

export interface IntegrationsApplicationOptions {
  db: Db;
  /** Queues a delivery for execution by its executor (provided by the host; absent → retry unavailable). */
  enqueueDeliveryExecution?: EnqueueDeliveryExecution;
  /** Queues the source scan of a reconciliation run (host-provided). */
  enqueueReconciliationScan?: EnqueueReconciliationScan;
  /** Queues the execution of one requested recovery (host-provided). */
  enqueueRecovery?: EnqueueRecovery;
  /** Runs onboarding discovery against the tenant's providers (host-provided). */
  runOnboardingDiscovery?: RunOnboardingDiscovery;
  /** Queues onboarding activation in the worker (host-provided). */
  enqueueOnboardingActivation?: EnqueueOnboardingActivation;
  /** Queues validation of an adaptation in the worker (host-provided). */
  enqueueAdaptationValidation?: EnqueueAdaptationValidation;
  /** How often the worker reconciles (stated to customers as a responsibility). */
  reconcileIntervalMinutes?: number;
  /** Receives one record per capability invocation (persisted as invocation evidence). */
  telemetry?: TelemetrySink;
  /** Optional host logger (for example the API's pino instance), bridged to AppPort's interface. */
  logger?: Logger;
}

export function createIntegrationsApplication(options: IntegrationsApplicationOptions): AppPortApplication {
  return createApplication({
    application: { ...APPPORT_APPLICATION },
    capabilities: [
      createIntegrationsListCapability(options.db),
      createDeliveriesListCapability(options.db),
      createDeliveryGetCapability(options.db),
      createDeliveryRetryCapability(options.db, options.enqueueDeliveryExecution),
      createReconciliationStartCapability(options.db, options.enqueueReconciliationScan),
      createReconciliationRunsCapability(options.db),
      createReconciliationItemsCapability(options.db),
      createReconciliationRecoverCapability(options.db, options.enqueueRecovery),
      createPortfolioListCapability(options.db),
      createPortfolioIntegrationCapability(options.db, options.reconcileIntervalMinutes ?? null),
      createMaintenanceEventGetCapability(options.db),
      createMaintenanceEvidenceCapability(options.db),
      createOnboardingStatusCapability(options.db),
      createOnboardingDiscoverCapability(options.db, options.runOnboardingDiscovery),
      createOnboardingConfirmCapability(options.db, options.enqueueOnboardingActivation),
      createAdaptationsInspectCapability(options.db),
      createAdaptationProposeCapability(options.db, options.enqueueAdaptationValidation),
      createAdaptationValidateCapability(options.db, options.enqueueAdaptationValidation),
      createAdaptationActivateCapability(options.db),
      createAdaptationRollbackCapability(options.db),
      createAdaptationRejectCapability(options.db),
    ],
    authorizer: combineAuthorizers([integrationsAuthorizer(), resourceTenantAuthorizer(options.db)]),
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

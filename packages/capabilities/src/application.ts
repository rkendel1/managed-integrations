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
import { createIntegrationsListCapability } from './capabilities/integrations-list.ts';

export const APPPORT_APPLICATION = {
  id: 'io.managedintegrations.app',
  name: 'Managed Integrations',
  version: '0.1.0',
} as const;

export interface IntegrationsApplicationOptions {
  db: Db;
  /** Queues a delivery for execution by its executor (provided by the host; absent → retry unavailable). */
  enqueueDeliveryExecution?: EnqueueDeliveryExecution;
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
    ],
    authorizer: combineAuthorizers([integrationsAuthorizer(), resourceTenantAuthorizer(options.db)]),
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

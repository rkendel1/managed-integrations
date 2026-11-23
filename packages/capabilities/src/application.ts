/**
 * The AppPort application: the capability contract and authority boundary shared by every
 * consumer. Transports (HTTP/MCP) and the UI are projections of this object, not alternatives.
 */
import { createApplication, type AppPortApplication } from '@appport/core';
import type { Logger } from '@appport/core';
import type { Db } from '@mi/database';
import { integrationsAuthorizer } from './authorization.ts';
import { createIntegrationsListCapability } from './capabilities/integrations-list.ts';

export const APPPORT_APPLICATION = {
  id: 'io.managedintegrations.app',
  name: 'Managed Integrations',
  version: '0.1.0',
} as const;

export interface IntegrationsApplicationOptions {
  db: Db;
  /** Optional host logger (for example the API's pino instance), bridged to AppPort's interface. */
  logger?: Logger;
}

export function createIntegrationsApplication(
  options: IntegrationsApplicationOptions,
): AppPortApplication {
  return createApplication({
    application: { ...APPPORT_APPLICATION },
    capabilities: [createIntegrationsListCapability(options.db)],
    authorizer: integrationsAuthorizer(),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

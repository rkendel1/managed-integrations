/**
 * `@mi/capabilities` — the AppPort-native capability boundary for Managed Integrations.
 *
 * The application, its contracts and its authorizer live here; transports and the UI import
 * them rather than reimplementing business operations.
 */
export {
  APPPORT_APPLICATION,
  createIntegrationsApplication,
  type IntegrationsApplicationOptions,
} from './application.ts';
export { integrationsAuthorizer } from './authorization.ts';
export {
  INTEGRATIONS_LIST,
  createIntegrationsListCapability,
  type IntegrationsListInput,
  type IntegrationsListOutput,
} from './capabilities/integrations-list.ts';
export {
  AppPortPermissions,
  permissionsFor,
  tenantIdOf,
  toAppPortIdentity,
  type AppPortIdentity,
  type AppPortPermission,
  type AuthenticatedCaller,
} from './identity.ts';
export {
  INTEGRATION_LIFECYCLES,
  listIntegrationsForTenant,
  type IntegrationLifecycle,
  type IntegrationSummary,
  type TenantIntegrationList,
} from './repository.ts';
export {
  createAppPortRuntime,
  type AppPortRuntime,
  type AppPortRuntimeOptions,
  type CallerHeaders,
  type ResolveIdentity,
} from './runtime.ts';
export type { Logger as AppPortLogger } from '@appport/core';
export {
  DELIVERY_OUTCOMES,
  createDeliveriesListCapability,
  createDeliveryGetCapability,
  createDeliveryRetryCapability,
  type DeliveriesListOutput,
  type DeliveryGetOutput,
  type DeliveryRetryOutput,
  type EnqueueDeliveryExecution,
} from './capabilities/deliveries.ts';
export { resourceTenantAuthorizer } from './authorization.ts';
export { APPPORT_INVOCATION_ACTION, auditLogTelemetrySink } from './invocation-evidence.ts';
export {
  createReconciliationItemsCapability,
  createReconciliationRecoverCapability,
  createReconciliationRunsCapability,
  createReconciliationStartCapability,
  type EnqueueReconciliationScan,
  type EnqueueRecovery,
  type ReconciliationItemView,
  type ReconciliationRun,
  type RecoverOutput,
} from './capabilities/reconciliation.ts';

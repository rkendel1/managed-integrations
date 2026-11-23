/**
 * One AppPort application, two projections: the HTTP binding (used by the UI) and the MCP
 * handler (used by agents). Both dispatch through `AppPortApplication.handleRequest`, so
 * validation, authorization, timeouts and output validation are identical.
 */
import { createMcpHandler } from '@appport/mcp';
import type { AppPortManifest } from '@appport/protocol';
import { createFetchHandler, createHttpBinding, createServer } from '@appport/server';
import type { Logger } from '@appport/core';
import type { Db } from '@mi/database';
import { createIntegrationsApplication } from './application.ts';
import type { AppPortIdentity } from './identity.ts';

/** Transport headers, as supplied by the HTTP binding or the MCP adapter. */
export type CallerHeaders = Readonly<Record<string, string | string[] | undefined>>;

/**
 * Resolves trusted identity from transport credentials (the application session cookie).
 *
 * Returning `undefined` means anonymous. AppPort's authorizer then refuses any capability that
 * requires permissions; identity is never accepted from capability input or MCP `_meta`.
 */
export type ResolveIdentity = (headers: CallerHeaders) => Promise<AppPortIdentity | undefined>;

export interface AppPortRuntimeOptions {
  db: Db;
  resolveIdentity: ResolveIdentity;
  enqueueDeliveryExecution?: import('./capabilities/deliveries.ts').EnqueueDeliveryExecution;
  enqueueReconciliationScan?: import('./capabilities/reconciliation.ts').EnqueueReconciliationScan;
  enqueueRecovery?: import('./capabilities/reconciliation.ts').EnqueueRecovery;
  reconcileIntervalMinutes?: number;
  enqueueAdaptationValidation?: import('./capabilities/adaptations.ts').EnqueueAdaptationValidation;
  telemetry?: import('@appport/core').TelemetrySink;
  /** Host logger (for example the API's pino instance). */
  logger?: Logger;
}

export interface AppPortRuntime {
  /** The authoritative application: capabilities, schemas and authorization. */
  application: ReturnType<typeof createIntegrationsApplication>;
  /** WHATWG fetch handler for the AppPort HTTP binding (`/appport`, manifest, discovery). */
  httpHandler: (request: Request) => Promise<Response>;
  /** WHATWG fetch handler for MCP Streamable HTTP (`POST /mcp`). */
  mcpHandler: (request: Request) => Promise<Response>;
  /** The manifest every projection derives from. */
  manifest(): AppPortManifest;
}

export function createAppPortRuntime(options: AppPortRuntimeOptions): AppPortRuntime {
  const application = createIntegrationsApplication({
    db: options.db,
    ...(options.enqueueDeliveryExecution
      ? { enqueueDeliveryExecution: options.enqueueDeliveryExecution }
      : {}),
    ...(options.enqueueReconciliationScan
      ? { enqueueReconciliationScan: options.enqueueReconciliationScan }
      : {}),
    ...(options.enqueueRecovery ? { enqueueRecovery: options.enqueueRecovery } : {}),
    ...(options.reconcileIntervalMinutes
      ? { reconcileIntervalMinutes: options.reconcileIntervalMinutes }
      : {}),
    ...(options.enqueueAdaptationValidation
      ? { enqueueAdaptationValidation: options.enqueueAdaptationValidation }
      : {}),
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });

  const server = createServer({
    application,
    authenticate: async ({ headers }) => {
      const identity = await options.resolveIdentity(headers ?? {});
      return identity ?? {};
    },
  });
  const binding = createHttpBinding({ server, maxBodyBytes: 256 * 1024 });
  const httpHandler = createFetchHandler(binding);

  const mcpHandler = createMcpHandler(application, {
    context: async ({ headers }) => {
      const identity = await options.resolveIdentity(headers);
      return identity ? { session: identity.session, principal: identity.principal } : undefined;
    },
  });

  return {
    application,
    httpHandler,
    mcpHandler,
    manifest: () => application.manifest(),
  };
}

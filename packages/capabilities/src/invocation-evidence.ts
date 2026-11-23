/**
 * AppPort invocation evidence, persisted. AppPort's runtime emits one `TelemetryRecord` per
 * capability request (any transport: HTTP binding or MCP) with the capability, principal, session,
 * outcome and error code — including authorization refusals. This sink writes each record to the
 * existing `audit_log`, so invocation evidence is durable without a parallel table.
 *
 * `record()` is synchronous in AppPort's contract; the write is asynchronous and failures are
 * reported to `onError`, never to the caller (evidence must not change the observed operation).
 */
import type { TelemetryRecord, TelemetrySink } from '@appport/core';
import { auditLog, type Db } from '@mi/database';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const APPPORT_INVOCATION_ACTION = 'appport.invocation';

export function auditLogTelemetrySink(
  db: Db,
  onError?: (error: unknown) => void,
): TelemetrySink & { flush(): Promise<void> } {
  const pending = new Set<Promise<unknown>>();
  return {
    record(entry: TelemetryRecord) {
      const write = db
        .insert(auditLog)
        .values({
          actorUserId: entry.principal && UUID.test(entry.principal) ? entry.principal : null,
          actorRole: 'appport',
          action: APPPORT_INVOCATION_ACTION,
          targetType: 'capability',
          targetId: `${entry.capability}@${entry.version}`,
          details: {
            requestId: entry.requestId,
            traceId: entry.traceId,
            transport: entry.transport,
            success: entry.success,
            errorCode: entry.errorCode ?? null,
            durationMs: entry.durationMs,
            idempotentReplay: entry.idempotentReplay ?? false,
            startTime: new Date(entry.startTime).toISOString(),
          },
        })
        .catch((err) => onError?.(err));
      pending.add(write);
      void write.finally(() => pending.delete(write));
    },
    /** Waits for in-flight writes (tests and graceful shutdown). */
    async flush() {
      await Promise.all([...pending]);
    },
  };
}

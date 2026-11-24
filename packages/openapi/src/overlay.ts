/**
 * The managed contract overlay: what OpenAPI cannot establish, written and reviewed by people, citing where each
 * statement comes from. Every statement carries a status; nothing is inferred into `known`.
 *
 *   known              stated by the application's code or the provider's documentation (with a citation)
 *   inferred           derived mechanically (e.g. effect class from the HTTP method); must be confirmed to act on
 *   unverified         claimed but not yet checked against evidence
 *   unsupported        we do not handle it; work that depends on it is held, not guessed
 *   requires_decision  a business choice only a person may make
 */
export const STATUSES = ['known', 'inferred', 'unverified', 'unsupported', 'requires_decision'] as const;
export type Status = (typeof STATUSES)[number];
export interface Statement {
  status: Status;
  value: string;
  /** file:line in the adopted application, or a provider documentation URL. Required for `known`. */
  source?: string;
}
export interface OperationOverlay {
  /** Whether a capability is generated for it. Destructive operations require an explicit `true` here. */
  expose: boolean;
  effect: Statement;
  idempotency: Statement;
  identity: Statement;
  /** How an unknown outcome is settled from the provider (a read operation and the field that identifies the result). */
  verify?: { operation: string; by: string; status: Status };
}
export interface Overlay {
  format: 'mi.openapi.overlay/1';
  application: string;
  provider: string;
  contract: { version: string; sha256: string };
  operations: Record<string, OperationOverlay>;
  /** Business invariants the adoption relies on (amount/currency, status transitions, acceptance, recovery). */
  invariants: (Statement & { id: string })[];
}

export class OverlayError extends Error {}

/** Refuses an overlay that claims `known` without a source, or exposes a destructive operation implicitly. */
export function checkOverlay(o: Overlay, contractOps: Record<string, { effect: { value: string } }>): string[] {
  const problems: string[] = [];
  for (const [key, op] of Object.entries(o.operations)) {
    if (!contractOps[key]) problems.push(`${key}: not in the contract`);
    for (const [name, s] of [['effect', op.effect], ['idempotency', op.idempotency], ['identity', op.identity]] as const)
      if (s.status === 'known' && !s.source) problems.push(`${key}.${name}: "known" needs a source`);
    if (contractOps[key]?.effect.value === 'destructive' && op.expose && op.effect.status !== 'known') problems.push(`${key}: destructive operation exposed without a known effect`);
    if (op.effect.value === 'write' && op.expose && op.idempotency.status === 'unsupported') problems.push(`${key}: write exposed without idempotency`);
  }
  for (const i of o.invariants) if (i.status === 'known' && !i.source) problems.push(`invariant ${i.id}: "known" needs a source`);
  return problems;
}

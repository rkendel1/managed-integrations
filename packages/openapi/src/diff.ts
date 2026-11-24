/**
 * Compare two normalized contracts and attribute the changes to the adopted applications that depend on them.
 *
 * A change is classified by what it can do to a client that was correct against the old contract:
 *   breaking   — the old client's requests may be refused, or fields it reads may be missing/different
 *   compatible — additions a correct client ignores (new optional request field, new response field, new operation)
 * Classification is mechanical and stated per change; whether an application is actually affected is decided only
 * by intersecting with what that application uses (its usage manifest), never by the classification alone.
 */
import type { Fields, NormalizedContract } from './normalize.ts';

export type ChangeKind =
  | 'operation.removed'
  | 'operation.added'
  | 'operation.deprecated'
  | 'operation.security_changed'
  | 'request.field_removed'
  | 'request.field_added_required'
  | 'request.field_added_optional'
  | 'request.field_became_required'
  | 'request.field_type_changed'
  | 'request.content_type_changed'
  | 'response.field_removed'
  | 'response.field_added'
  | 'response.field_type_changed'
  | 'response.enum_value_removed'
  | 'response.enum_value_added'
  | 'schema.removed'
  | 'webhook.removed'
  | 'webhook.changed'
  | 'security.scheme_changed'
  | 'version.changed';

export interface ContractChange {
  kind: ChangeKind;
  breaking: boolean;
  /** Operation key (`POST /v1/payment_intents`), `schema:<name>`, `webhook:<name>` or `contract`. */
  subject: string;
  field?: string;
  before?: unknown;
  after?: unknown;
}

const BREAKING: Record<ChangeKind, boolean> = {
  'operation.removed': true,
  'operation.added': false,
  'operation.deprecated': false,
  'operation.security_changed': true,
  'request.field_removed': true,
  'request.field_added_required': true,
  'request.field_added_optional': false,
  'request.field_became_required': true,
  'request.field_type_changed': true,
  'request.content_type_changed': true,
  'response.field_removed': true,
  'response.field_added': false,
  'response.field_type_changed': true,
  'response.enum_value_removed': true,
  'response.enum_value_added': false,
  'schema.removed': true,
  'webhook.removed': true,
  'webhook.changed': true,
  'security.scheme_changed': true,
  'version.changed': false,
};
const change = (kind: ChangeKind, subject: string, extra: Partial<ContractChange> = {}): ContractChange => ({ kind, breaking: BREAKING[kind], subject, ...extra });

function diffFields(side: 'request' | 'response', subject: string, a: Fields, b: Fields, out: ContractChange[]) {
  for (const [f, s] of Object.entries(a)) {
    const t = b[f];
    if (!t) {
      out.push(change(side === 'request' ? 'request.field_removed' : 'response.field_removed', subject, { field: f, before: s.type }));
      continue;
    }
    if (t.type !== s.type) out.push(change(side === 'request' ? 'request.field_type_changed' : 'response.field_type_changed', subject, { field: f, before: s.type, after: t.type }));
    if (side === 'request' && t.required && !s.required) out.push(change('request.field_became_required', subject, { field: f }));
    if (side === 'response' && s.enum && t.enum) {
      const removed = s.enum.filter((v) => !t.enum!.includes(v));
      const added = t.enum.filter((v) => !s.enum!.includes(v));
      if (removed.length) out.push(change('response.enum_value_removed', subject, { field: f, before: removed }));
      if (added.length) out.push(change('response.enum_value_added', subject, { field: f, after: added }));
    }
  }
  for (const [f, t] of Object.entries(b))
    if (!a[f])
      out.push(
        side === 'request'
          ? change(t.required ? 'request.field_added_required' : 'request.field_added_optional', subject, { field: f, after: t.type })
          : change('response.field_added', subject, { field: f, after: t.type }),
      );
}

export function diffContracts(a: NormalizedContract, b: NormalizedContract): ContractChange[] {
  const out: ContractChange[] = [];
  if (a.version !== b.version) out.push(change('version.changed', 'contract', { before: a.version, after: b.version }));
  for (const [name, s] of Object.entries(a.securitySchemes))
    if (JSON.stringify(s) !== JSON.stringify(b.securitySchemes[name])) out.push(change('security.scheme_changed', `security:${name}`, { before: s, after: b.securitySchemes[name] ?? null }));
  for (const [key, op] of Object.entries(a.operations)) {
    const n = b.operations[key];
    if (!n) {
      out.push(change('operation.removed', key));
      continue;
    }
    if (!op.deprecated && n.deprecated) out.push(change('operation.deprecated', key));
    if (op.security.join() !== n.security.join()) out.push(change('operation.security_changed', key, { before: op.security, after: n.security }));
    if (op.request.contentType !== n.request.contentType) out.push(change('request.content_type_changed', key, { before: op.request.contentType, after: n.request.contentType }));
    diffFields('request', key, op.request.fields, n.request.fields, out);
    for (const p of op.parameters) {
      const q = n.parameters.find((x) => x.name === p.name && x.in === p.in);
      if (!q) out.push(change('request.field_removed', key, { field: `${p.in}:${p.name}` }));
      else if (q.required && !p.required) out.push(change('request.field_became_required', key, { field: `${p.in}:${p.name}` }));
    }
    for (const q of n.parameters) if (q.required && !op.parameters.some((p) => p.name === q.name && p.in === q.in)) out.push(change('request.field_added_required', key, { field: `${q.in}:${q.name}` }));
    for (const [status, r] of Object.entries(op.responses)) {
      const s = n.responses[status];
      if (s) diffFields('response', key, r.fields, s.fields, out);
    }
  }
  for (const key of Object.keys(b.operations)) if (!a.operations[key]) out.push(change('operation.added', key));
  for (const [name, s] of Object.entries(a.schemas)) {
    const t = b.schemas[name];
    if (!t) out.push(change('schema.removed', `schema:${name}`));
    else diffFields('response', `schema:${name}`, s.fields, t.fields, out);
  }
  for (const [name, w] of Object.entries(a.webhooks)) {
    const v = b.webhooks[name];
    if (!v) out.push(change('webhook.removed', `webhook:${name}`));
    else if (JSON.stringify(w.fields) !== JSON.stringify(v.fields)) out.push(change('webhook.changed', `webhook:${name}`));
  }
  return out;
}

/**
 * What one adopted application depends on: the operations it calls, and the schema fields it reads (from responses
 * or from event payloads). Authored and reviewed with the adoption — derived from the application's code, cited.
 */
export interface UsageManifest {
  application: string;
  /** Where in the application each dependency is (file:line), so an impact points at code. */
  operations: { key: string; usedAt: string }[];
  reads: { schema: string; field: string; usedAt: string }[];
  /** Request fields the application sends per operation (observed from its traffic, or cited). */
  sends?: { operation: string; field: string }[];
}

export interface ImpactItem {
  change: ContractChange;
  usedAt: string;
}
export interface ImpactReport {
  application: string;
  from: { version: string; contractHash: string };
  to: { version: string; contractHash: string };
  affected: ImpactItem[];
  /** Breaking changes elsewhere in the contract that this application does not use (recorded, not actionable). */
  unaffectedBreaking: number;
  verdict: 'unaffected' | 'affected_breaking' | 'affected_compatible';
}

export function impactOf(changes: ContractChange[], usage: UsageManifest, a: NormalizedContract, b: NormalizedContract): ImpactReport {
  const affected: ImpactItem[] = [];
  const sends = (op: string, field?: string) =>
    !usage.sends || usage.sends.some((x) => x.operation === op && field !== undefined && (x.field === field || x.field.startsWith(`${field}.`) || x.field.startsWith(`${field}[`) || field.startsWith(`${x.field}.`)));
  const reads = (schema: string | null | undefined, field?: string) =>
    !!schema && usage.reads.some((r) => r.schema === schema && field !== undefined && (r.field === field || field.startsWith(`${r.field}.`)));
  for (const c of changes) {
    const op = usage.operations.find((o) => o.key === c.subject);
    if (op) {
      const k = c.kind;
      // Request side: only what binds this caller — a new requirement, or a change to a field it sends.
      const binds =
        k === 'operation.removed' || k === 'operation.deprecated' || k === 'operation.security_changed' || k === 'request.content_type_changed' || k === 'request.field_added_required' || k === 'request.field_became_required' ||
        ((k === 'request.field_removed' || k === 'request.field_type_changed') && sends(c.subject, c.field)) ||
        // Response side of the operation: only fields it reads (from the operation's response schema).
        (k.startsWith('response.') && reads(a.operations[c.subject]?.responses['200']?.schema, c.field));
      if (binds) affected.push({ change: c, usedAt: op.usedAt });
      continue;
    }
    if (c.subject.startsWith('schema:')) {
      const schema = c.subject.slice('schema:'.length);
      const read = usage.reads.find((r) => r.schema === schema && (c.kind === 'schema.removed' || (c.field !== undefined && (c.field === r.field || c.field.startsWith(`${r.field}.`)))));
      if (read) affected.push({ change: c, usedAt: read.usedAt });
    }
  }
  const affectedBreaking = affected.filter((i) => i.change.breaking);
  return {
    application: usage.application,
    from: { version: a.version, contractHash: a.contractHash },
    to: { version: b.version, contractHash: b.contractHash },
    affected,
    unaffectedBreaking: changes.filter((c) => c.breaking && !affected.some((i) => i.change === c)).length,
    verdict: affectedBreaking.length ? 'affected_breaking' : affected.length ? 'affected_compatible' : 'unaffected',
  };
}

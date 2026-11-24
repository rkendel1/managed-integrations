/**
 * Conformance: does real traffic (an application's own client talking to the provider, or a simulator answering
 * it) match the pinned contract? An existing application is adopted as it is — its client is not rewritten —
 * and its exchanges are checked against the contract it claims to speak.
 */
import type { Fields, NormalizedContract, NormalizedOperation } from './normalize.ts';

export interface Exchange {
  method: string;
  /** Path as sent, e.g. /v1/payment_intents/pi_123 */
  path: string;
  /** Form-encoded or JSON request body, decoded to bracket-notation keys (Stripe: metadata[invoiceId]). */
  requestFields: string[];
  status: number;
  /** Response body (JSON), if any. */
  response: unknown;
}
export interface Violation {
  operation: string | null;
  side: 'request' | 'response' | 'operation';
  field?: string;
  problem: 'unknown_operation' | 'unknown_field' | 'missing_required' | 'wrong_type';
  detail: string;
}

/** The contract operation a concrete request path belongs to (path templates like /v1/payment_intents/{intent}). */
export function matchOperation(c: NormalizedContract, method: string, path: string): NormalizedOperation | null {
  const clean = path.split('?')[0]!;
  for (const op of Object.values(c.operations)) {
    if (op.method !== method.toUpperCase()) continue;
    const re = new RegExp(`^${op.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}/g, '[^/]+').replace(/\{[^}]+\}/g, '[^/]+')}$`);
    if (re.test(clean)) return op;
  }
  return null;
}

/** metadata[invoiceId] → metadata ; line_items[0][price_data][currency] → line_items[].price_data.currency */
export function fieldPathOf(formKey: string): string {
  const parts = formKey.replace(/\]/g, '').split('[');
  return parts.map((p, i) => (i === 0 ? p : /^\d+$/.test(p) ? '[]' : `.${p}`)).join('').replace(/\.\[\]/g, '[]');
}

function knownRequestField(fields: Fields, path: string): boolean {
  if (fields[path]) return true;
  // An array of scalars is sent as a[0]=…, a[1]=… : the field is the array itself.
  if (path.endsWith('[]') && fields[path.slice(0, -2)]?.type.startsWith('array')) return true;
  // A free-form object (metadata) accepts any key below it.
  const segs = path.split('.');
  for (let i = segs.length - 1; i > 0; i--) {
    const parent = fields[segs.slice(0, i).join('.')];
    if (parent && /object|any/.test(parent.type) && !Object.keys(fields).some((k) => k.startsWith(`${segs.slice(0, i).join('.')}.`))) return true;
  }
  return false;
}

const jsonType = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);
function typeAllows(declared: string, actual: string, nullable?: boolean): boolean {
  if (actual === 'null') return !!nullable || declared.includes('null');
  if (declared.includes('any')) return true;
  const alts = declared.split('|');
  return alts.some((a) => a === actual || (a === 'number' && actual === 'integer') || (a.startsWith('ref:') && (actual === 'string' || actual === 'object')) || (a.startsWith('array') && actual === 'array') || (a === 'object' && actual === 'object'));
}

export function checkExchange(c: NormalizedContract, x: Exchange): Violation[] {
  const op = matchOperation(c, x.method, x.path);
  if (!op) return [{ operation: null, side: 'operation', problem: 'unknown_operation', detail: `${x.method} ${x.path} is not in the contract` }];
  const out: Violation[] = [];
  const sent = new Set(x.requestFields.map(fieldPathOf));
  for (const f of sent)
    if (!knownRequestField(op.request.fields, f) && !op.parameters.some((p) => p.name === f))
      out.push({ operation: op.key, side: 'request', field: f, problem: 'unknown_field', detail: `${f} is not a request field of ${op.key}` });
  for (const [f, s] of Object.entries(op.request.fields))
    if (s.required && !f.includes('.') && !f.includes('[]') && !sent.has(f)) out.push({ operation: op.key, side: 'request', field: f, problem: 'missing_required', detail: `${op.key} requires ${f}` });
  if (x.status >= 200 && x.status < 300 && x.response && typeof x.response === 'object') {
    const r = op.responses[String(x.status)] ?? op.responses['200'];
    const fields = r?.schema ? c.schemas[r.schema]?.fields ?? r.fields : r?.fields ?? {};
    const body = x.response as Record<string, unknown>;
    for (const [k, v] of Object.entries(body)) {
      const s = fields[k];
      if (!s) out.push({ operation: op.key, side: 'response', field: k, problem: 'unknown_field', detail: `${k} is not in the ${r?.schema ?? 'response'} schema` });
      else if (!typeAllows(s.type, jsonType(v), s.nullable)) out.push({ operation: op.key, side: 'response', field: k, problem: 'wrong_type', detail: `${k}: ${jsonType(v)}, contract says ${s.type}` });
    }
    for (const [k, s] of Object.entries(fields)) if (s.required && !k.includes('.') && !k.includes('[]') && !(k in body)) out.push({ operation: op.key, side: 'response', field: k, problem: 'missing_required', detail: `${r?.schema ?? 'response'}.${k} is required by the contract` });
  }
  return out;
}

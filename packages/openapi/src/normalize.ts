/**
 * Normalize: a deterministic, diffable representation of an OpenAPI 3.x document. Parsing, validation and
 * reference resolution are swagger-parser's (adopted, not rebuilt); this module only decides what Managed
 * Integrations compares and keeps: operations, their request/response fields, component schemas as flattened
 * fields, security schemes, and declared webhooks — each with a JSON pointer back to the source document.
 *
 * What OpenAPI cannot say is not invented: an operation's effect class is derived from its HTTP method and labelled
 * `inferred`; pagination is labelled `inferred` from list parameters/fields; anything else (identity, idempotency,
 * business acceptance) belongs in the reviewed overlay (overlay.ts), never here.
 */
import SwaggerParser from '@apidevtools/swagger-parser';
import { sha256, type SpecSource } from './source.ts';

export interface FieldShape {
  type: string;
  required: boolean;
  nullable?: boolean;
  enum?: string[];
}
export type Fields = Record<string, FieldShape>;

export interface NormalizedOperation {
  key: string;
  method: string;
  path: string;
  operationId: string | null;
  pointer: string;
  deprecated: boolean;
  parameters: { name: string; in: string; required: boolean; type: string }[];
  request: { contentType: string | null; fields: Fields };
  responses: Record<string, { schema: string | null; fields: Fields }>;
  security: string[];
  /** read (GET/HEAD), write (POST/PUT/PATCH), destructive (DELETE) — from the method only. */
  effect: { value: 'read' | 'write' | 'destructive'; status: 'inferred' };
  pagination: { kind: 'cursor' | 'offset'; parameters: string[]; status: 'inferred' } | null;
}

export interface NormalizedContract {
  format: 'mi.openapi.contract/1';
  title: string;
  version: string;
  openapi: string;
  source: Pick<SpecSource, 'sha256' | 'location' | 'authority' | 'license'>;
  servers: string[];
  securitySchemes: Record<string, { type: string; scheme?: string; in?: string; name?: string; flows?: string[] }>;
  operations: Record<string, NormalizedOperation>;
  schemas: Record<string, { pointer: string; fields: Fields }>;
  webhooks: Record<string, { pointer: string; schema: string | null; fields: Fields }>;
  /** sha256 of this object without the hash itself (canonical JSON). */
  contractHash: string;
}

export class ContractError extends Error {}

const METHODS = ['get', 'put', 'post', 'patch', 'delete', 'head', 'options'] as const;
const escapePointer = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');

/** Canonical JSON: sorted keys, so the same contract always serializes (and hashes) the same way. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

type Doc = Record<string, any>;
const refName = (ref: string) => (ref.startsWith('#/components/schemas/') ? ref.slice('#/components/schemas/'.length) : ref);

function typeOf(s: any, doc: Doc): string {
  if (!s || typeof s !== 'object') return 'any';
  if (s.$ref) return `ref:${refName(s.$ref)}`;
  const alt = s.anyOf ?? s.oneOf;
  if (Array.isArray(alt)) return alt.map((x: any) => typeOf(x, doc)).sort().join('|');
  if (Array.isArray(s.allOf)) return s.allOf.map((x: any) => typeOf(x, doc)).sort().join('&');
  if (s.type === 'array') return `array<${typeOf(s.items, doc)}>`;
  if (Array.isArray(s.type)) return [...s.type].sort().join('|');
  return String(s.type ?? (s.properties ? 'object' : 'any'));
}

/** Flattens a schema into dotted field paths (inline objects only; named components stop at `ref:<name>`). */
export function flatten(schema: any, doc: Doc, prefix = '', depth = 0, out: Fields = {}, requiredHere = true): Fields {
  if (!schema || typeof schema !== 'object' || schema.$ref) return out;
  const props: Record<string, any> = schema.properties ?? {};
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  for (const [name, p] of Object.entries(props)) {
    const path = prefix ? `${prefix}.${name}` : name;
    const shape: FieldShape = { type: typeOf(p, doc), required: requiredHere && required.has(name) };
    if (p?.nullable) shape.nullable = true;
    if (Array.isArray(p?.enum)) shape.enum = [...p.enum].map(String).sort();
    out[path] = shape;
    if (depth < 3 && p && !p.$ref) {
      if (p.type === 'object' || p.properties) flatten(p, doc, path, depth + 1, out, shape.required);
      else if (p.type === 'array' && p.items && !p.items.$ref) flatten(p.items, doc, `${path}[]`, depth + 1, out, false);
      else for (const alt of (p.anyOf ?? p.oneOf ?? []) as any[]) if (alt && !alt.$ref && (alt.properties || alt.type === 'object')) flatten(alt, doc, path, depth + 1, out, false);
    }
  }
  return out;
}

function pagination(op: any, responseFields: Fields): NormalizedOperation['pagination'] {
  const params = ((op.parameters ?? []) as any[]).map((p) => String(p.name));
  const cursor = params.filter((n) => ['starting_after', 'ending_before', 'cursor', 'page_token', 'after', 'before'].includes(n));
  if (cursor.length && ('has_more' in responseFields || 'next_page' in responseFields || params.includes('limit')))
    return { kind: 'cursor', parameters: [...cursor, ...params.filter((n) => n === 'limit')].sort(), status: 'inferred' };
  const offset = params.filter((n) => ['offset', 'page', 'startposition', 'maxresults'].includes(n.toLowerCase()));
  if (offset.length) return { kind: 'offset', parameters: offset.sort(), status: 'inferred' };
  return null;
}

/**
 * Validates (swagger-parser), bundles external references into the document, and normalizes. Throws ContractError
 * for documents that are not valid OpenAPI 3.x or whose references cannot be resolved.
 */
export async function normalize(document: Doc, source: SpecSource): Promise<NormalizedContract> {
  if (document['swagger']) throw new ContractError('Swagger/OpenAPI 2.0 is not normalized: convert it to OpenAPI 3 first');
  let doc: Doc;
  try {
    await SwaggerParser.validate(structuredClone(document) as never);
    doc = (await SwaggerParser.bundle(structuredClone(document) as never)) as Doc;
  } catch (err) {
    throw new ContractError(`Invalid OpenAPI document: ${(err as Error).message.split('\n')[0]}`);
  }
  const security = (doc['security'] ?? []) as Record<string, unknown>[];
  const operations: Record<string, NormalizedOperation> = {};
  for (const [path, item] of Object.entries<any>(doc['paths'] ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method];
      if (!op) continue;
      const key = `${method.toUpperCase()} ${path}`;
      const content = op.requestBody?.content ?? {};
      const contentType = Object.keys(content).sort()[0] ?? null;
      const responses: NormalizedOperation['responses'] = {};
      for (const [status, r] of Object.entries<any>(op.responses ?? {})) {
        const json = r?.content?.['application/json']?.schema ?? Object.values<any>(r?.content ?? {})[0]?.schema;
        const resolved = json?.$ref ? doc['components']?.schemas?.[refName(json.$ref)] : json;
        responses[status] = { schema: json?.$ref ? refName(json.$ref) : null, fields: flatten(resolved, doc) };
      }
      const ok = responses['200'] ?? responses['201'] ?? { fields: {} };
      operations[key] = {
        key,
        method: method.toUpperCase(),
        path,
        operationId: op.operationId ?? null,
        pointer: `#/paths/${escapePointer(path)}/${method}`,
        deprecated: op.deprecated === true,
        parameters: [...(item.parameters ?? []), ...(op.parameters ?? [])]
          .map((p: any) => ({ name: String(p.name), in: String(p.in), required: p.required === true, type: typeOf(p.schema, doc) }))
          .sort((a, b) => `${a.in}:${a.name}`.localeCompare(`${b.in}:${b.name}`)),
        request: { contentType, fields: contentType ? flatten(content[contentType].schema, doc) : {} },
        responses,
        security: ((op.security ?? security) as Record<string, unknown>[]).flatMap((s) => Object.keys(s)).sort(),
        effect: { value: method === 'get' || method === 'head' || method === 'options' ? 'read' : method === 'delete' ? 'destructive' : 'write', status: 'inferred' },
        pagination: pagination(op, ok.fields),
      };
    }
  }
  const schemas: NormalizedContract['schemas'] = {};
  for (const [name, s] of Object.entries<any>(doc['components']?.schemas ?? {}))
    schemas[name] = { pointer: `#/components/schemas/${escapePointer(name)}`, fields: flatten(s, doc) };
  const webhooks: NormalizedContract['webhooks'] = {};
  for (const [name, item] of Object.entries<any>(doc['webhooks'] ?? {})) {
    const op = item?.post ?? Object.values<any>(item ?? {})[0];
    const json = op?.requestBody?.content?.['application/json']?.schema;
    webhooks[name] = {
      pointer: `#/webhooks/${escapePointer(name)}`,
      schema: json?.$ref ? refName(json.$ref) : null,
      fields: flatten(json?.$ref ? doc['components']?.schemas?.[refName(json.$ref)] : json, doc),
    };
  }
  const securitySchemes: NormalizedContract['securitySchemes'] = {};
  for (const [name, s] of Object.entries<any>(doc['components']?.securitySchemes ?? {}))
    securitySchemes[name] = {
      type: String(s.type),
      ...(s.scheme ? { scheme: String(s.scheme) } : {}),
      ...(s.in ? { in: String(s.in), name: String(s.name) } : {}),
      ...(s.flows ? { flows: Object.keys(s.flows).sort() } : {}),
    };
  const body: Omit<NormalizedContract, 'contractHash'> = {
    format: 'mi.openapi.contract/1',
    title: String(doc['info']?.title ?? ''),
    version: String(doc['info']?.version ?? ''),
    openapi: String(doc['openapi']),
    source: { sha256: source.sha256, location: source.location, authority: source.authority, license: source.license },
    servers: ((doc['servers'] ?? []) as { url: string }[]).map((s) => s.url),
    securitySchemes,
    operations,
    schemas,
    webhooks,
  };
  // The hash covers the contract, not where it was read from: the same API at the same bytes hashes the same.
  const { source: _s, ...hashed } = body;
  return { ...body, contractHash: sha256(canonical(hashed)) };
}

/** Keeps only what an adoption depends on (operations by key, and the component schemas they reach). */
export function subset(c: NormalizedContract, operationKeys: string[], schemaNames: string[] = []): NormalizedContract {
  const missing = operationKeys.filter((k) => !c.operations[k]);
  if (missing.length) throw new ContractError(`Operations not in the contract: ${missing.join(', ')}`);
  const operations = Object.fromEntries(operationKeys.sort().map((k) => [k, c.operations[k]!]));
  const reached = new Set<string>(schemaNames);
  const visit = (fields: Fields) => {
    for (const f of Object.values(fields))
      for (const m of f.type.matchAll(/ref:([A-Za-z0-9_.]+)/g)) if (!reached.has(m[1]!) && c.schemas[m[1]!]) {
        reached.add(m[1]!);
      }
  };
  for (const op of Object.values(operations)) {
    visit(op.request.fields);
    for (const r of Object.values(op.responses)) {
      if (r.schema) reached.add(r.schema);
      visit(r.fields);
    }
  }
  for (const n of [...reached]) if (c.schemas[n]) visit(c.schemas[n]!.fields);
  const schemas = Object.fromEntries([...reached].filter((n) => c.schemas[n]).sort().map((n) => [n, c.schemas[n]!]));
  const { contractHash: _h, source, ...rest } = c;
  const body = { ...rest, source, operations, schemas, webhooks: {} };
  const { source: _s2, ...hashed } = body;
  return { ...body, contractHash: sha256(canonical(hashed)) };
}

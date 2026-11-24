/**
 * Generated types: openapi-typescript over the SUBSET of the provider's document an adoption uses (the operations
 * and every component they reach), so the generated file is small, reproducible and reviewable. Generated output
 * carries a header naming the source document hash and the generator version, and is never edited by hand.
 */
import { canonical } from './normalize.ts';
import { sha256 } from './source.ts';

type Doc = Record<string, any>;

/** The document restricted to the given operations and the components they reach (transitively). */
export function subsetDocument(doc: Doc, operationKeys: string[]): Doc {
  const paths: Doc = {};
  for (const key of operationKeys) {
    const [method, path] = key.split(' ') as [string, string];
    const op = doc['paths']?.[path]?.[method.toLowerCase()];
    if (!op) throw new Error(`${key} is not in the document`);
    paths[path] = { ...(paths[path] ?? {}), [method.toLowerCase()]: op, ...(doc['paths'][path].parameters ? { parameters: doc['paths'][path].parameters } : {}) };
  }
  const reached = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      const ref = (v as { $ref?: string }).$ref;
      if (typeof ref === 'string' && ref.startsWith('#/components/schemas/')) {
        const name = ref.slice('#/components/schemas/'.length);
        if (!reached.has(name)) {
          reached.add(name);
          walk(doc['components']?.schemas?.[name]);
        }
      }
      Object.values(v).forEach(walk);
    }
  };
  walk(paths);
  const schemas = Object.fromEntries([...reached].sort().map((n) => [n, doc['components'].schemas[n]]));
  return {
    openapi: doc['openapi'],
    info: doc['info'],
    servers: doc['servers'],
    security: doc['security'],
    paths,
    components: { schemas, securitySchemes: doc['components']?.securitySchemes ?? {} },
  };
}

export async function generateTypes(doc: Doc, operationKeys: string[], provenance: { sourceSha256: string; label: string }) {
  const { default: openapiTS, astToString } = await import('openapi-typescript');
  const sub = subsetDocument(doc, operationKeys);
  const ast = await openapiTS(JSON.parse(JSON.stringify(sub)) as never, { alphabetize: true });
  const body = astToString(ast);
  const header = [
    '/**',
    ` * GENERATED — do not edit. ${provenance.label}`,
    ` * source document sha256 ${provenance.sourceSha256}`,
    ` * subset (${operationKeys.length} operations, ${Object.keys(sub['components'].schemas).length} schemas) sha256 ${sha256(canonical(sub))}`,
    ' * generator openapi-typescript 7.13.0 (alphabetized)',
    ' */',
    '',
  ].join('\n');
  return { source: header + body, subset: sub };
}

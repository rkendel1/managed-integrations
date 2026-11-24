/**
 * Which code of the Stripe-dependent application runs (the generic artifact mechanism of @mi/managed).
 *
 * - The pinned, vendored files are never modified. An artifact is a content-addressed copy under
 *   ../.artifacts (inside this package, so the application's imports resolve to the dependency versions
 *   this package installs from upstream's lockfile), one copy per managed customer (`instance`): the
 *   application keeps module-level singletons (its Stripe client, its database client).
 * - Two DEPLOYMENT BINDINGS replace whole upstream files the host provides — the database client and the
 *   environment loader. The upstream files stay sha-pinned (an upstream change to them is still detected);
 *   the binding texts are fixed below and their sha256 is part of every artifact.
 * - The dependency set (stripe-node 17.7.0, express 4.22.1, zod 3.25.76: what upstream's lockfile resolves)
 *   is linked into each artifact's own node_modules, so the client library is part of "which code runs".
 * - Reviewed patches (patches/*.json) apply on top; rolling one back selects the previous artifact.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readPatchCatalog, ReviewedPatchSchema, type PinnedSource } from '@mi/managed';
import { STRIPE_SUBSCRIPTIONS_APP } from './provenance.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const packageDir = join(here, '..');
export const upstreamDir = () => join(packageDir, 'upstream', 'stripe-webhooks-subscriptions-node-ts');

export const AppPatchSchema = ReviewedPatchSchema.extend({
  addresses: z.object({ provider: z.string(), contract: z.string(), change: z.string() }),
});
export type AppPatch = z.infer<typeof AppPatchSchema>;
const patchesDir = () => process.env.STRIPE_APP_PATCHES_DIR ?? join(packageDir, 'patches');
export const patchCatalog = (): AppPatch[] => readPatchCatalog(patchesDir(), AppPatchSchema);

/** The text of each deployment binding (CommonJS, like the application). Static, so it can be pinned. */
export const BINDINGS = {
  'src/db/prisma.ts': {
    reason:
      'The application database is hosted by Managed Integrations (app_records, one scope per customer). ' +
      'Upstream constructs a PrismaClient; the host provides a delegate implementing exactly the Prisma calls ' +
      'this application makes (upsert, createMany with skipDuplicates, findUnique, update with increment).',
    content: `// Deployment binding (Managed Integrations) — replaces upstream src/db/prisma.ts at commit 4812d25.
// The host provides the application's database client for this instance.
export const prisma = (globalThis as any).__miAppHost.bind(__filename).prisma;
`,
  },
  'src/config/env.ts': {
    reason:
      'The host provides the environment of each instance (its Stripe key and webhook secret come from the ' +
      'customer’s encrypted connection; nothing secret is written to disk). Upstream loads dotenv and parses ' +
      'process.env with the same field names.',
    content: `// Deployment binding (Managed Integrations) — replaces upstream src/config/env.ts at commit 4812d25.
// Same fields as upstream (NODE_ENV, PORT, DATABASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET).
export const env = (globalThis as any).__miAppHost.bind(__filename).env;
`,
  },
} as const;

export function pinnedSource(): PinnedSource {
  const dep = (name: string) => join(packageDir, 'node_modules', name);
  return {
    label: 'stripe-subscriptions-app',
    repository: STRIPE_SUBSCRIPTIONS_APP.repository,
    commit: STRIPE_SUBSCRIPTIONS_APP.commit,
    dir: upstreamDir(),
    fileSha256: STRIPE_SUBSCRIPTIONS_APP.fileSha256,
    support: ['package.json', 'tsconfig.json'],
    artifactDir: join(packageDir, '.artifacts'),
    bindings: BINDINGS,
    // Installed under aliases (app-*) so this package's own code can use other versions (e.g. zod 4).
    dependencies: {
      stripe: { version: STRIPE_SUBSCRIPTIONS_APP.dependencies.stripe, dir: dep('app-stripe') },
      express: { version: STRIPE_SUBSCRIPTIONS_APP.dependencies.express, dir: dep('app-express') },
      zod: { version: STRIPE_SUBSCRIPTIONS_APP.dependencies.zod, dir: dep('app-zod') },
    },
  };
}

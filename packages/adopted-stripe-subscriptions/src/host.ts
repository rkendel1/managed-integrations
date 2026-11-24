/**
 * Hosts the adopted application: one running instance per managed customer and artifact. The instance IS
 * the upstream application — its own Express app (buildApp), its own webhook handler with its own signature
 * check and idempotency, its own Stripe client — listening on a local port. The host provides only what the
 * deployment provides: the environment, the database (bindings) and, for the dev/test fixture, the Stripe
 * host the client talks to.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import { adaptations, integrations, type Db } from '@mi/database';
import type { CredentialCipher, ProviderEndpointConfig } from '@mi/integration-shopify-netsuite';
import { appHost, materializeArtifact, type MaterializedArtifact } from '@mi/managed';
import { signStripePayload, stripeKeyFor } from '@mi/provider-connections';
import { patchCatalog, pinnedSource, type AppPatch } from './artifact.ts';
import { appWebhookSecretAad, StripeAppConfigSchema } from './contract.ts';
import { appStore, type AppStore } from './store.ts';

export interface HostDeps {
  db: Db;
  cipher: CredentialCipher;
  endpoints: ProviderEndpointConfig;
}

type StripeEvent = { id: string; type: string; data: { object: Record<string, unknown> } };
export interface AppInstance {
  integrationId: string;
  artifact: MaterializedArtifact;
  adaptationIds: string[];
  baseUrl: string;
  store: AppStore;
  /** The application's own event processor (used for validation replays and recovery). */
  processStripeEvent(event: StripeEvent): Promise<{ outcome: 'processed' | 'ignored' }>;
  /** Hands an event (already verified at our ingress) to the application exactly as Stripe would. */
  deliverWebhook(raw: Buffer): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Calls one of the application's own HTTP routes (its writes to Stripe). */
  call(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

interface Live {
  env: Record<string, unknown>;
  instance: AppInstance;
  server: Server;
}
const live = new Map<string, Promise<Live>>();

/** Active reviewed patches of this integration (the artifact the application runs). */
export async function activePatches(db: Db, integrationId: string): Promise<{ patches: AppPatch[]; ids: string[] }> {
  const rows = await db
    .select()
    .from(adaptations)
    .where(and(eq(adaptations.integrationId, integrationId), eq(adaptations.status, 'active'), inArray(adaptations.kind, ['patch'])));
  const catalog = patchCatalog();
  return {
    patches: rows.map((r) => {
      const p = catalog.find((x) => x.id === (r.spec as { patchId?: string }).patchId);
      if (!p) throw new Error(`Active patch ${(r.spec as { patchId?: string }).patchId} is not in the catalog`);
      return p;
    }),
    ids: rows.map((r) => r.id),
  };
}

/** Materializes and loads an application instance for a given set of patches (no listening server). */
export async function loadApplication(root: string) {
  const imp = (rel: string) => import(pathToFileURL(join(root, rel)).href) as Promise<Record<string, unknown>>;
  const unwrap = (m: Record<string, unknown>) => ((m['default'] as Record<string, unknown> | undefined) ?? m);
  const appMod = unwrap(await imp('src/app.ts'));
  const stripeMod = unwrap(await imp('src/stripe/stripe.ts'));
  const procMod = unwrap(await imp('src/webhooks/stripeEventProcessor.ts'));
  return {
    buildApp: appMod['buildApp'] as () => (req: unknown, res: unknown) => void,
    stripe: stripeMod['stripe'] as { _setApiField(k: string, v: unknown): void; getApiField(k: string): unknown },
    processStripeEvent: procMod['processStripeEvent'] as AppInstance['processStripeEvent'],
  };
}

/** Points the application's own Stripe client at the configured base (only differs from Stripe in dev/test). */
export function configureClient(stripe: { _setApiField(k: string, v: unknown): void }, baseUrl: string, apiKey: string) {
  const u = new URL(baseUrl);
  stripe._setApiField('host', u.hostname);
  stripe._setApiField('port', Number(u.port || (u.protocol === 'https:' ? 443 : 80)));
  stripe._setApiField('protocol', u.protocol.replace(':', ''));
  stripe._setApiField('auth', `Bearer ${apiKey}`);
}

export async function instanceFor(deps: HostDeps, integrationId: string): Promise<AppInstance> {
  const { db, cipher } = deps;
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, integrationId));
  if (!integ) throw new Error('Unknown integration');
  const config = StripeAppConfigSchema.parse(integ.config);
  const { patches, ids } = await activePatches(db, integrationId);
  const artifact = materializeArtifact(pinnedSource(), patches, { instance: integrationId });
  const { apiKey, baseUrl } = await stripeKeyFor(db, cipher, deps.endpoints, integ.tenantId);
  const secret = config.webhook ? cipher.decrypt<string>(config.webhook.secretCiphertext, appWebhookSecretAad(integrationId)) : '';
  const key = `${integrationId}:${artifact.id}`;
  // Other artifacts of this integration (a correction was activated or rolled back) stop serving.
  for (const [k, v] of live) if (k.startsWith(`${integrationId}:`) && k !== key) {
    live.delete(k);
    void v.then((l) => l.instance.close()).catch(() => undefined);
  }
  let entry = live.get(key);
  if (!entry) {
    entry = (async (): Promise<Live> => {
      const store = appStore(db, integrationId);
      const env: Record<string, unknown> = {
        NODE_ENV: 'production',
        PORT: 0,
        DATABASE_URL: 'hosted:app_records',
        STRIPE_SECRET_KEY: apiKey,
        STRIPE_WEBHOOK_SECRET: secret,
      };
      appHost().register(artifact.root, { prisma: store.prisma, env });
      const mod = await loadApplication(artifact.root);
      const server = createServer(mod.buildApp() as never);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const post = async (path: string, body: string, headers: Record<string, string>) => {
        const res = await fetch(`${base}${path}`, { method: 'POST', headers, body });
        const text = await res.text();
        let parsed: Record<string, unknown>;
        try { parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { parsed = { raw: text.slice(0, 500) }; }
        return { status: res.status, body: parsed };
      };
      const instance: AppInstance = {
        integrationId,
        artifact,
        adaptationIds: ids,
        baseUrl: base,
        store,
        processStripeEvent: (e) => mod.processStripeEvent(e),
        deliverWebhook: (raw) =>
          post('/v1/stripe/webhook', raw.toString('utf8'), {
            'content-type': 'application/json',
            'stripe-signature': signStripePayload(raw, String(env['STRIPE_WEBHOOK_SECRET'])),
          }),
        call: (path, body) => post(path, JSON.stringify(body), { 'content-type': 'application/json' }),
        close: () => new Promise<void>((r) => server.close(() => r())),
      };
      return { env, instance, server, configure: mod.stripe } as Live & { configure: typeof mod.stripe };
    })();
    live.set(key, entry);
  }
  const l = (await entry) as Live & { configure: Parameters<typeof configureClient>[0] };
  // Credentials can change (rotation, reconnection): the instance always uses the current ones.
  l.env['STRIPE_SECRET_KEY'] = apiKey;
  l.env['STRIPE_WEBHOOK_SECRET'] = secret;
  configureClient(l.configure, baseUrl, apiKey);
  return l.instance;
}

export async function closeAllInstances() {
  const all = [...live.values()];
  live.clear();
  await Promise.all(all.map((p) => p.then((l) => l.instance.close()).catch(() => undefined)));
}

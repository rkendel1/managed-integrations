/**
 * Hosts the QuickBooks-dependent application's adopted tool. Per customer and artifact: the application's own
 * modules (its customer/item caches are module state, so customers never share an instance) and its own
 * QuickBooks client library — the node-quickbooks version linked into the artifact — constructed with the
 * customer's current OAuth token and pointed at the QuickBooks API base (the fixture in dev/test).
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { materializeArtifact, type MaterializedArtifact, type ReviewedDependencyChange } from '@mi/managed';
import { pinnedSource } from './artifact.ts';

export type ToolResult = { content: { type: string; text: string }[] };
export interface LoadedApp {
  artifact: MaterializedArtifact;
  handleCreateInvoice(client: unknown, args: Record<string, unknown>): Promise<ToolResult>;
  /** A client of the artifact's own node-quickbooks for a token and realm, against an API base. */
  client(p: { accessToken: string; realmId: string; apiBase: string }): Record<string, unknown>;
}

const loaded = new Map<string, Promise<LoadedApp>>();

export function loadApplication(changes: ReviewedDependencyChange[], instance: string): Promise<LoadedApp> {
  const artifact = materializeArtifact(pinnedSource(), [], { dependencyChanges: changes, instance });
  const key = artifact.root;
  let p = loaded.get(key);
  if (!p) {
    p = (async () => {
      const imp = (rel: string) => import(pathToFileURL(join(artifact.root, rel)).href) as Promise<Record<string, any>>;
      const invoice = await imp('src/tools/handlers/invoice.ts');
      const nq = await imp('node_modules/node-quickbooks/index.js');
      const QuickBooks = (nq['default'] ?? nq) as new (...a: unknown[]) => Record<string, unknown>;
      return {
        artifact,
        handleCreateInvoice: invoice['handleCreateInvoice'],
        client({ accessToken, realmId, apiBase }) {
          // The same constructor call upstream makes in src/client/auth.ts (OAuth 2.0, latest minor version).
          const c = new QuickBooks('host-managed', 'host-managed', accessToken, false, realmId, false, false, null, '2.0', null);
          c['endpoint'] = `${apiBase.replace(/\/$/, '')}/v3/company/`;
          return c;
        },
      } satisfies LoadedApp;
    })();
    loaded.set(key, p);
  }
  return p;
}

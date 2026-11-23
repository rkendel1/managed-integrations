/**
 * The customer's EXISTING integration, before they come to us: their own deployment of the open-source
 * shopify-erp-order-sync (the same pinned upstream code we adopt), with its own NetSuite credentials,
 * processing their Shopify orders. Used to create real history for onboarding discovery — the NetSuite
 * records are written by the upstream code itself, not seeded.
 *
 * Fixture-only: the "deployment" runs in-process against the deterministic fixtures.
 */
import { generateNetSuiteKeyPair, NetSuiteM2MAuth } from '@mi/integration-shopify-netsuite';
import { loadArtifact } from '@mi/adopted-order-sync';

export interface ExistingDeploymentFixtures {
  netsuiteUrl: string;
  netsuite: { clientId: string; certificateId: string; control: { registerPublicKey(pem: string): void } };
}

export async function existingDeployment(f: ExistingDeploymentFixtures) {
  const kp = generateNetSuiteKeyPair();
  f.netsuite.control.registerPublicKey(kp.publicKeyPem); // the customer's own integration record in NetSuite
  const auth = new NetSuiteM2MAuth(f.netsuiteUrl, {
    clientId: f.netsuite.clientId,
    certificateId: f.netsuite.certificateId,
    privateKeyPem: kp.privateKeyPem,
    algorithm: 'PS256',
  });
  const { modules } = await loadArtifact([]); // the original upstream code, unmodified
  return {
    /** Processes one Shopify orders/create webhook body exactly as their server would. */
    async process(webhookBody: unknown) {
      const accessToken = await auth.getAccessToken();
      const order = modules.toCanonicalOrder(webhookBody, { customerByEmail: {}, defaultCustomer: 'WEB' });
      return modules.syncOrder(modules.createNetSuiteAdapter({ baseUrl: f.netsuiteUrl, accessToken }), order);
    },
  };
}

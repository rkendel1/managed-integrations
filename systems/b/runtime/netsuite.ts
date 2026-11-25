/**
 * NetSuite machine-to-machine access (OAuth 2.0 client credentials with a signed JWT client assertion, PS256):
 * the customer registers the public key we generate; the private key stays sealed. Tokens are cached per
 * workspace until a minute before they expire.
 */
import { generateKeyPairSync, sign } from "node:crypto";

export interface NetSuiteCredential {
  accountDomain: string;
  clientId: string;
  certificateId: string;
  privateKeyPem: string;
}

export function newKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const b64url = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
const cache = new Map<string, { token: string; until: number }>();

export function forgetToken(workspace: string) {
  cache.delete(workspace);
}

export async function accessToken(workspace: string, cred: NetSuiteCredential): Promise<string> {
  const hit = cache.get(workspace);
  if (hit && hit.until > Date.now()) return hit.token;
  const url = `${cred.accountDomain}/services/rest/auth/oauth2/v1/token`;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: "PS256", typ: "JWT", kid: cred.certificateId });
  const body = b64url({ iss: cred.clientId, scope: ["rest_webservices"], aud: url, iat: now, exp: now + 3000 });
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: cred.privateKeyPem, padding: 6, saltLength: 32 }).toString("base64url");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: `${head}.${body}.${sig}`,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !json.access_token) throw new AuthorizationLost(`NetSuite token refused: ${json.error ?? res.status}`);
  cache.set(workspace, { token: json.access_token, until: Date.now() + ((json.expires_in ?? 3600) - 60) * 1000 });
  return json.access_token;
}

/** The target no longer accepts our credentials: work waits for the customer, it is not retried blindly. */
export class AuthorizationLost extends Error {}

/** Read a sales order back by external id (verification). */
export async function readSalesOrder(cred: NetSuiteCredential, token: string, externalId: string) {
  const res = await fetch(`${cred.accountDomain}/services/rest/record/v1/salesOrder/eid:${externalId}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`NetSuite read ${res.status}`);
  return (await res.json()) as { id: string; subsidiary?: { id: string } | null; item?: { items: { item: { id: string }; quantity: number; rate: number }[] } };
}

/** A read-only SuiteQL query (look-ups for maintenance: subsidiaries, the customer's own records). */
export async function suiteql<T>(cred: NetSuiteCredential, token: string, q: string): Promise<T[]> {
  const res = await fetch(`${cred.accountDomain}/services/rest/query/v1/suiteql`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", prefer: "transient" },
    body: JSON.stringify({ q }),
  });
  if (!res.ok) throw new Error(`NetSuite SuiteQL ${res.status}`);
  return ((await res.json()) as { items: T[] }).items;
}

export const ACTIVE_SUBSIDIARIES = "SELECT id, name FROM subsidiary WHERE isinactive = 'F' ORDER BY id";

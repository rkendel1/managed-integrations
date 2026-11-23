/**
 * Credential encryption at rest: AES-256-GCM with a 96-bit random IV and key id prefix so
 * keys can be rotated. Envelope format: v1.<keyId>.<iv b64url>.<tag b64url>.<ciphertext b64url>
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface KeyRing {
  primaryKeyId: string;
  keys: Map<string, Buffer>;
}

/**
 * Parses CREDENTIAL_ENCRYPTION_KEYS: comma separated `keyId:base64key` pairs; first is primary.
 * Every key must decode to exactly 32 bytes.
 */
export function parseKeyRing(spec: string | undefined): KeyRing | undefined {
  if (!spec) return undefined;
  const keys = new Map<string, Buffer>();
  let primary: string | undefined;
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = part.indexOf(':');
    if (idx <= 0) throw new Error('CREDENTIAL_ENCRYPTION_KEYS entries must be keyId:base64key');
    const id = part.slice(0, idx);
    const key = Buffer.from(part.slice(idx + 1), 'base64');
    if (key.length !== 32) throw new Error(`Encryption key ${id} must be 32 bytes (base64-encoded)`);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error('Encryption key id must be [A-Za-z0-9_-]{1,32}');
    keys.set(id, key);
    primary ??= id;
  }
  if (!primary) return undefined;
  return { primaryKeyId: primary, keys };
}

export class CredentialCipher {
  constructor(private readonly ring: KeyRing) {}

  get keyId(): string {
    return this.ring.primaryKeyId;
  }

  encrypt(plaintext: unknown, aad: string): string {
    const key = this.ring.keys.get(this.ring.primaryKeyId)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(JSON.stringify(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', this.ring.primaryKeyId, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
  }

  /** `aad` binds the ciphertext to its row (e.g. connection id) so it cannot be swapped between rows. */
  decrypt<T>(envelope: string, aad: string): T {
    const [v, keyId, iv, tag, ct] = envelope.split('.');
    if (v !== 'v1' || !keyId || !iv || !tag || !ct) throw new Error('Unsupported credential envelope');
    const key = this.ring.keys.get(keyId);
    if (!key) throw new Error(`Unknown encryption key id ${keyId}`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const pt = Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
    return JSON.parse(pt.toString('utf8')) as T;
  }
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

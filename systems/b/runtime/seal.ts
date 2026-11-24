/**
 * Customer provider secrets and webhook payloads are sealed here, in the runtime component, with a keyring
 * held in FeltKit's credential custody (`credential-ref:mi-keyring`: comma-separated keyId:base64(32 bytes),
 * first is primary). FeltDB only ever stores the envelope `v1.<keyId>.<iv>.<tag>.<ciphertext>`, bound by AAD
 * to the workspace and the purpose, so a sealed value cannot be replayed into another workspace or field.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface Sealer {
  seal(plaintext: string, aad: string): string;
  open(envelope: string, aad: string): string;
}

export function createSealer(keyring: string): Sealer {
  const keys = new Map<string, Buffer>();
  let primary = "";
  for (const entry of keyring.split(",").map((e) => e.trim()).filter(Boolean)) {
    const [id, b64] = entry.split(":");
    const key = Buffer.from(b64 ?? "", "base64");
    if (!id || key.length !== 32) throw new Error("mi-keyring: each entry must be keyId:base64(32 bytes)");
    keys.set(id, key);
    primary ||= id;
  }
  if (!primary) throw new Error("mi-keyring is empty");
  return {
    seal(plaintext, aad) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", keys.get(primary)!, iv);
      c.setAAD(Buffer.from(aad));
      const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
      return ["v1", primary, iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
    },
    open(envelope, aad) {
      const [v, id, iv, tag, ct] = envelope.split(".");
      const key = keys.get(id ?? "");
      if (v !== "v1" || !key || !iv || !tag || ct === undefined) throw new Error("unreadable sealed value");
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
    },
  };
}

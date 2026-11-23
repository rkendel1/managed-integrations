import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { IMPLEMENTATION_API_VERSION, type IntegrationImplementation } from './implementation-api.ts';
import { sha256Hex } from './secrets.ts';

/**
 * Loads an immutable implementation artifact (an ESM bundle produced at release time) after
 * verifying its sha256 against the IntegrationVersion record. A mismatch is refused: the
 * artifact on disk is not the one that was validated and approved.
 */
export async function loadImplementationArtifact(path: string, expectedSha256: string): Promise<IntegrationImplementation> {
  const bytes = await readFile(path);
  const actual = sha256Hex(bytes);
  if (actual !== expectedSha256) {
    throw new Error(`Implementation artifact checksum mismatch for ${path}: expected ${expectedSha256}, got ${actual}`);
  }
  // Query string makes each checksum a distinct module instance (no stale module cache across versions).
  const mod = (await import(`${pathToFileURL(path).href}?sha=${actual}`)) as { implementation?: IntegrationImplementation };
  const impl = mod.implementation;
  if (!impl || impl.apiVersion !== IMPLEMENTATION_API_VERSION) {
    throw new Error(`Artifact ${path} does not export a compatible implementation (api v${IMPLEMENTATION_API_VERSION})`);
  }
  return impl;
}

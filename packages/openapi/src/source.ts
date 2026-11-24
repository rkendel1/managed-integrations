/**
 * Acquire: an OpenAPI document is adoption EVIDENCE. Its bytes are kept as acquired and identified by sha256;
 * where it came from, when, which version it declares and under which licence are recorded with it.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface SpecSource {
  /** Where the bytes came from: a URL, a git repository + ref + path, or a local file. */
  location: { kind: 'url'; url: string } | { kind: 'git'; repository: string; ref: string; commit: string; path: string } | { kind: 'file'; path: string };
  retrievedAt: string;
  sha256: string;
  bytes: number;
  /** info.title / info.version as the document declares them. */
  title: string;
  version: string;
  openapi: string;
  license: string | null;
  /** Who stands behind it: official (the provider publishes it), community, or generated here. */
  authority: 'official' | 'community' | 'derived';
}

export const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

function describe(raw: string, location: SpecSource['location'], authority: SpecSource['authority'], license: string | null): { source: SpecSource; document: Record<string, any> } {
  const document = JSON.parse(raw) as Record<string, any>;
  if (!document['openapi'] && !document['swagger']) throw new Error('Not an OpenAPI or Swagger document');
  return {
    document,
    source: {
      location,
      retrievedAt: new Date().toISOString(),
      sha256: sha256(raw),
      bytes: Buffer.byteLength(raw),
      title: String(document['info']?.title ?? ''),
      version: String(document['info']?.version ?? ''),
      openapi: String(document['openapi'] ?? document['swagger']),
      license,
      authority,
    },
  };
}

export function fromFile(path: string, opts: { authority: SpecSource['authority']; license?: string | null }) {
  return describe(readFileSync(path, 'utf8'), { kind: 'file', path }, opts.authority, opts.license ?? null);
}

/** From a git checkout at an exact commit (the commit is resolved and recorded, never just the ref). */
export function fromGit(p: { dir: string; repository: string; ref: string; path: string; authority: SpecSource['authority']; license?: string | null }) {
  const commit = execFileSync('git', ['-C', p.dir, 'rev-list', '-n1', p.ref], { encoding: 'utf8' }).trim();
  const raw = execFileSync('git', ['-C', p.dir, 'show', `${commit}:${p.path}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return describe(raw, { kind: 'git', repository: p.repository, ref: p.ref, commit, path: p.path }, p.authority, p.license ?? null);
}

/** Pinned bytes: refuses a document whose hash is not the pinned one. */
export function verifyPinned(raw: string, expectedSha256: string) {
  const got = sha256(raw);
  if (got !== expectedSha256) throw new Error(`OpenAPI document hash ${got.slice(0, 12)}… is not the pinned ${expectedSha256.slice(0, 12)}…`);
}

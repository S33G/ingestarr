import { createHash } from 'node:crypto';

import { canonicalizeSourceRelativePath, normalizeSourceRelativePath } from './scan-media.js';

export interface QuickFingerprintFacts {
  relativePath: string;
  canonicalPathKey: string;
  sizeBytes: number;
  modifiedAt: string | Date;
}

function encodeField(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

export function computeQuickFingerprint(facts: QuickFingerprintFacts): string {
  if (!Number.isSafeInteger(facts.sizeBytes) || facts.sizeBytes < 0) {
    throw new RangeError('Quick fingerprint sizeBytes must be a non-negative safe integer');
  }
  const modifiedAt = new Date(facts.modifiedAt);
  if (Number.isNaN(modifiedAt.getTime())) {
    throw new TypeError('Quick fingerprint modifiedAt must be a valid timestamp');
  }
  const relativePath = normalizeSourceRelativePath(facts.relativePath, 'canonical');
  const canonicalPathKey = canonicalizeSourceRelativePath(relativePath, 'canonical');
  if (facts.canonicalPathKey !== canonicalPathKey) {
    throw new Error('Quick fingerprint canonical path key does not match the source-relative path');
  }

  const fields = [
    'ingestarr.quick-fingerprint.v1',
    canonicalPathKey,
    String(facts.sizeBytes),
    modifiedAt.toISOString(),
  ];
  const hash = createHash('sha256');
  for (const field of fields) hash.update(encodeField(field));
  return `quick-v1:${hash.digest('hex')}`;
}

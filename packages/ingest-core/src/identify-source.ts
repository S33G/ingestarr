import { createHash } from 'node:crypto';

import { canonicalizeSourceRelativePath, normalizeSourceRelativePath } from './scan-media.js';

export interface SourceSample {
  relativePath: string;
  canonicalPathKey?: string;
  sizeBytes: number;
}

export interface NormalizedSourceSample {
  relativePath: string;
  canonicalPathKey: string;
  sizeBytes: number;
}

export interface SourceIdentityFacts {
  label: string;
  capacityBytes?: number;
  filesystem?: string;
  platformVolumeId?: string;
  files: readonly SourceSample[];
  sampleCountPerEdge?: number;
}

export interface NormalizedSourceIdentityFacts {
  label: string;
  capacityBucketBytes?: number;
  filesystem?: string;
  samples: NormalizedSourceSample[];
}

export interface FallbackSourceIdentity {
  algorithmVersion: 1;
  fingerprint: string;
  normalizedFacts: NormalizedSourceIdentityFacts;
  authoritative: false;
}

export interface SourceIdentityCandidate {
  sourceId: string;
  platformVolumeId?: string;
  fallbackFingerprint?: string;
  fallbackFingerprintAliases?: readonly string[];
}

export interface SourceIdentityMatch {
  sourceId: string;
  confidence: 'exact' | 'medium';
  reasons: string[];
  requiresConfirmation: boolean;
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

// Exposed so callers that only have a raw volume label (e.g. a just-detected removable volume,
// before any file listing is available) can compare it against a fallback identity's stored
// `normalizedFacts.label` using the exact same normalization `createFallbackSourceIdentity` uses.
// This lets label-based reconciliation hints stay consistent with the fingerprint algorithm
// instead of drifting via an ad hoc comparison.
export function normalizeSourceLabel(value: string): string {
  return normalizeText(value);
}

function normalizePlatformVolumeId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? undefined : normalized;
}

export function approximateCapacityBucket(capacityBytes: number | undefined): number | undefined {
  if (capacityBytes === undefined) return undefined;
  if (!Number.isSafeInteger(capacityBytes) || capacityBytes <= 0) {
    throw new RangeError('Source capacity must be a positive safe integer');
  }
  return 2 ** Math.round(Math.log2(capacityBytes));
}

function selectSamples(
  files: readonly SourceSample[],
  sampleCountPerEdge: number,
): NormalizedSourceSample[] {
  const normalized = files
    .map((file) => {
      if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) {
        throw new RangeError('Source sample size must be a non-negative safe integer');
      }
      const relativePath = normalizeSourceRelativePath(file.relativePath, 'canonical');
      const canonicalPathKey = canonicalizeSourceRelativePath(relativePath, 'canonical');
      if (file.canonicalPathKey !== undefined && file.canonicalPathKey !== canonicalPathKey) {
        throw new Error('Source sample canonical path key does not match its relative path');
      }
      return {
        relativePath,
        canonicalPathKey,
        sizeBytes: file.sizeBytes,
      };
    })
    .sort((left, right) => {
      const foldedLeft = left.canonicalPathKey.toLocaleLowerCase('en-US');
      const foldedRight = right.canonicalPathKey.toLocaleLowerCase('en-US');
      return foldedLeft === foldedRight
        ? left.canonicalPathKey === right.canonicalPathKey
          ? left.relativePath === right.relativePath
            ? left.sizeBytes - right.sizeBytes
            : left.relativePath < right.relativePath
              ? -1
              : 1
          : left.canonicalPathKey < right.canonicalPathKey
            ? -1
            : 1
        : foldedLeft < foldedRight
          ? -1
          : 1;
    });
  const selected = [
    ...normalized.slice(0, sampleCountPerEdge),
    ...normalized.slice(-sampleCountPerEdge),
  ];
  return selected.filter(
    (sample, index) =>
      selected.findIndex(
        (candidate) =>
          candidate.relativePath === sample.relativePath &&
          candidate.canonicalPathKey === sample.canonicalPathKey &&
          candidate.sizeBytes === sample.sizeBytes,
      ) === index,
  );
}

export function createFallbackSourceIdentity(facts: SourceIdentityFacts): FallbackSourceIdentity {
  const sampleCountPerEdge = facts.sampleCountPerEdge ?? 8;
  if (!Number.isInteger(sampleCountPerEdge) || sampleCountPerEdge < 1) {
    throw new RangeError('sampleCountPerEdge must be a positive integer');
  }
  const normalizedFacts: NormalizedSourceIdentityFacts = {
    label: normalizeText(facts.label),
    samples: selectSamples(facts.files, sampleCountPerEdge),
  };
  const capacityBucketBytes = approximateCapacityBucket(facts.capacityBytes);
  if (capacityBucketBytes !== undefined) normalizedFacts.capacityBucketBytes = capacityBucketBytes;
  if (facts.filesystem !== undefined && facts.filesystem.trim() !== '') {
    normalizedFacts.filesystem = normalizeText(facts.filesystem);
  }

  const canonical = JSON.stringify({
    version: 1,
    label: normalizedFacts.label,
    capacityBucketBytes: normalizedFacts.capacityBucketBytes ?? null,
    filesystem: normalizedFacts.filesystem ?? null,
    samples: normalizedFacts.samples,
  });
  return {
    algorithmVersion: 1,
    fingerprint: `source-fallback-v1:${createHash('sha256').update(canonical).digest('hex')}`,
    normalizedFacts,
    authoritative: false,
  };
}

export interface IdentifySourceResult {
  identity: {
    platformVolumeId?: string;
    fallback: FallbackSourceIdentity;
  };
  matches: SourceIdentityMatch[];
  reconciliation: 'new-source' | 'candidate-found' | 'confirmation-required';
}

export function identifySource(
  facts: SourceIdentityFacts,
  candidates: readonly SourceIdentityCandidate[],
): IdentifySourceResult {
  const fallback = createFallbackSourceIdentity(facts);
  const platformVolumeId = normalizePlatformVolumeId(facts.platformVolumeId);
  const strongMatches =
    platformVolumeId === undefined
      ? []
      : candidates.filter(
          (candidate) => normalizePlatformVolumeId(candidate.platformVolumeId) === platformVolumeId,
        );
  const candidateMatches =
    strongMatches.length > 0
      ? strongMatches.map((candidate) => ({
          sourceId: candidate.sourceId,
          confidence: 'exact' as const,
          reasons: [
            'strong-platform-volume-id-match',
            candidate.fallbackFingerprint === fallback.fingerprint
              ? 'fallback-fingerprint-confirmed'
              : 'fallback-fingerprint-changed',
          ],
          requiresConfirmation: strongMatches.length !== 1,
        }))
      : candidates
          .filter(
            (candidate) =>
              candidate.fallbackFingerprint === fallback.fingerprint ||
              candidate.fallbackFingerprintAliases?.includes(fallback.fingerprint) === true,
          )
          .map((candidate) => ({
            sourceId: candidate.sourceId,
            confidence: 'medium' as const,
            reasons: ['non-authoritative-fallback-fingerprint-match'],
            requiresConfirmation: true,
          }));
  candidateMatches.sort((left, right) => left.sourceId.localeCompare(right.sourceId, 'en-US'));

  const identity: IdentifySourceResult['identity'] = { fallback };
  if (platformVolumeId !== undefined) identity.platformVolumeId = platformVolumeId;
  return {
    identity,
    matches: candidateMatches,
    reconciliation:
      candidateMatches.length === 0
        ? 'new-source'
        : candidateMatches.length === 1 && candidateMatches[0]?.requiresConfirmation === false
          ? 'candidate-found'
          : 'confirmation-required',
  };
}

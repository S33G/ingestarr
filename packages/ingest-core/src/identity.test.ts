import { describe, expect, it } from 'vitest';

import {
  computeQuickFingerprint,
  createFallbackSourceIdentity,
  identifySource,
  normalizeSourceRelativePath,
} from './index.js';

describe('computeQuickFingerprint', () => {
  it('is versioned, deterministic, and stable across path separators', () => {
    const posix = computeQuickFingerprint({
      relativePath: 'DCIM/100/IMG.JPG',
      canonicalPathKey: 'DCIM/100/IMG.JPG',
      sizeBytes: 123,
      modifiedAt: '2026-07-01T10:20:30.000Z',
    });
    const windows = computeQuickFingerprint({
      relativePath: normalizeSourceRelativePath(String.raw`DCIM\100\IMG.JPG`, 'windows'),
      canonicalPathKey: 'DCIM/100/IMG.JPG',
      sizeBytes: 123,
      modifiedAt: '2026-07-01T10:20:30Z',
    });

    expect(posix).toEqual(windows);
    expect(posix).toMatch(/^quick-v1:[a-f0-9]{64}$/);
    expect(
      computeQuickFingerprint({
        relativePath: 'DCIM/100/IMG.JPG',
        canonicalPathKey: 'DCIM/100/IMG.JPG',
        sizeBytes: 124,
        modifiedAt: '2026-07-01T10:20:30Z',
      }),
    ).not.toEqual(posix);
  });

  it('uses unambiguous canonical field encoding', () => {
    expect(
      computeQuickFingerprint({
        relativePath: 'a/1',
        canonicalPathKey: 'a/1',
        sizeBytes: 23,
        modifiedAt: '2026-01-01Z',
      }),
    ).not.toEqual(
      computeQuickFingerprint({
        relativePath: 'a/12',
        canonicalPathKey: 'a/12',
        sizeBytes: 3,
        modifiedAt: '2026-01-01Z',
      }),
    );
  });

  it('uses the explicit NFC key while preserving the raw source path contract', () => {
    const decomposed = `cafe\u0301.jpg`;
    const facts = {
      sizeBytes: 4,
      modifiedAt: '2026-01-01T00:00:00.000Z',
      canonicalPathKey: 'café.jpg',
    };
    expect(computeQuickFingerprint({ ...facts, relativePath: decomposed })).toBe(
      computeQuickFingerprint({ ...facts, relativePath: 'café.jpg' }),
    );
    expect(() =>
      computeQuickFingerprint({
        ...facts,
        relativePath: decomposed,
        canonicalPathKey: 'different.jpg',
      }),
    ).toThrow(/canonical path key/i);
  });
});

const samples = [
  { relativePath: 'z/final.mov', sizeBytes: 99 },
  {
    relativePath: normalizeSourceRelativePath(String.raw`DCIM\middle.jpg`, 'windows'),
    sizeBytes: 22,
  },
  { relativePath: 'a/first.jpg', sizeBytes: 11 },
  { relativePath: 'y/late.mp4', sizeBytes: 88 },
];

describe('fallback source identity', () => {
  it('normalizes facts, buckets capacity, and samples deterministic early and late files', () => {
    const first = createFallbackSourceIdentity({
      label: '  My   CARD ',
      capacityBytes: 63_800_000_000,
      filesystem: ' ExFAT ',
      files: samples,
      sampleCountPerEdge: 1,
    });
    const reordered = createFallbackSourceIdentity({
      label: 'my card',
      capacityBytes: 65_000_000_000,
      filesystem: 'exfat',
      files: [...samples].reverse(),
      sampleCountPerEdge: 1,
    });

    expect(first.fingerprint).toEqual(reordered.fingerprint);
    expect(first.fingerprint).toMatch(/^source-fallback-v1:[a-f0-9]{64}$/);
    expect(first.normalizedFacts.samples).toEqual([
      { relativePath: 'a/first.jpg', canonicalPathKey: 'a/first.jpg', sizeBytes: 11 },
      { relativePath: 'z/final.mov', canonicalPathKey: 'z/final.mov', sizeBytes: 99 },
    ]);
    expect(first.authoritative).toBe(false);
  });

  it('changes when sampled identity facts materially change', () => {
    const first = createFallbackSourceIdentity({ label: 'card', files: samples });
    const changed = createFallbackSourceIdentity({
      label: 'card',
      files: [{ relativePath: 'different.jpg', sizeBytes: 1 }],
    });
    expect(first.fingerprint).not.toEqual(changed.fingerprint);
  });

  it('preserves NFC-colliding raw paths in source identity samples', () => {
    const identity = createFallbackSourceIdentity({
      label: 'card',
      files: [
        { relativePath: `cafe\u0301.jpg`, sizeBytes: 1 },
        { relativePath: 'café.jpg', sizeBytes: 2 },
      ],
    });
    expect(identity.normalizedFacts.samples).toEqual([
      { relativePath: `cafe\u0301.jpg`, canonicalPathKey: 'café.jpg', sizeBytes: 1 },
      { relativePath: 'café.jpg', canonicalPathKey: 'café.jpg', sizeBytes: 2 },
    ]);
  });
});

describe('identifySource', () => {
  it('returns an exact candidate for a strong platform id and still records fallback', () => {
    const result = identifySource({ label: 'Card', platformVolumeId: 'volume-1', files: samples }, [
      {
        sourceId: 'source-1',
        platformVolumeId: 'volume-1',
        fallbackFingerprint: 'source-fallback-v1:old',
      },
    ]);
    expect(result.identity.fallback.fingerprint).toMatch(/^source-fallback-v1:/);
    expect(result.matches).toEqual([
      expect.objectContaining({
        sourceId: 'source-1',
        confidence: 'exact',
        requiresConfirmation: false,
      }),
    ]);
  });

  it('auto-binds one exact strong id even when the fallback fingerprint changed', () => {
    const result = identifySource(
      {
        label: 'CARD',
        platformVolumeId: 'disk-by-id-1',
        files: [{ relativePath: 'DCIM/new-content.jpg', sizeBytes: 77 }],
      },
      [
        {
          sourceId: 'known-card',
          platformVolumeId: 'disk-by-id-1',
          fallbackFingerprint: 'source-fallback-v1:old-content',
        },
      ],
    );

    expect(result.matches).toEqual([
      expect.objectContaining({
        sourceId: 'known-card',
        confidence: 'exact',
        requiresConfirmation: false,
        reasons: expect.arrayContaining([
          'strong-platform-volume-id-match',
          'fallback-fingerprint-changed',
        ]),
      }),
    ]);
    expect(result.reconciliation).toBe('candidate-found');
  });

  it('requires confirmation for competing strong identities and fingerprint aliases', () => {
    const alias = createFallbackSourceIdentity({ label: 'CARD', files: samples }).fingerprint;
    const strong = identifySource(
      { label: 'CARD', platformVolumeId: 'shared-id', files: samples },
      [
        { sourceId: 'one', platformVolumeId: 'shared-id' },
        { sourceId: 'two', platformVolumeId: 'shared-id' },
      ],
    );
    expect(strong.matches.every((match) => match.requiresConfirmation)).toBe(true);
    expect(strong.reconciliation).toBe('confirmation-required');

    const fallbackAlias = identifySource({ label: 'CARD', files: samples }, [
      { sourceId: 'one', fallbackFingerprintAliases: [alias] },
    ]);
    expect(fallbackAlias.matches[0]).toEqual(
      expect.objectContaining({
        sourceId: 'one',
        confidence: 'medium',
        requiresConfirmation: true,
      }),
    );
  });

  it('does not silently merge fallback-only or conflicting candidates', () => {
    const identity = createFallbackSourceIdentity({ label: 'Card', files: samples });
    const result = identifySource({ label: 'Card', files: samples }, [
      { sourceId: 'one', fallbackFingerprint: identity.fingerprint },
      { sourceId: 'two', fallbackFingerprint: identity.fingerprint },
    ]);

    expect(result.matches).toHaveLength(2);
    expect(result.matches.every((match) => match.confidence === 'medium')).toBe(true);
    expect(result.matches.every((match) => match.requiresConfirmation)).toBe(true);
    expect(result.reconciliation).toBe('confirmation-required');
  });

  it('trims strong ids and treats empty ids as absent', () => {
    const trimmed = identifySource(
      { label: 'Card', platformVolumeId: '  volume-1  ', files: samples },
      [{ sourceId: 'source-1', platformVolumeId: ' volume-1 ' }],
    );
    expect(trimmed.identity.platformVolumeId).toBe('volume-1');
    expect(trimmed.matches).toEqual([
      expect.objectContaining({ confidence: 'exact', requiresConfirmation: false }),
    ]);

    const empty = identifySource({ label: 'Card', platformVolumeId: '   ', files: samples }, [
      { sourceId: 'source-1', platformVolumeId: ' ' },
    ]);
    expect(empty.identity).not.toHaveProperty('platformVolumeId');
    expect(empty.matches).toEqual([]);
    expect(empty.reconciliation).toBe('new-source');
  });
});

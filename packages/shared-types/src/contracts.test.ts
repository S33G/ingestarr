import { describe, expect, it } from 'vitest';

import {
  appErrorSchema,
  chooseFolderResponseSchema,
  detectedSourceListResponseSchema,
  getSettingsResponseSchema,
  ingestProgressEventSchema,
  ipcRequestSchemas,
  listRecoverableSessionsResponseSchema,
  listKnownSourcesResponseSchema,
  claimSessionRequestSchema,
  reviewIngestRequestSchema,
  reviewIngestResponseSchema,
  recoverSessionRequestSchema,
  reviewPlanSchema,
  sessionSnapshotSchema,
  setSourceNicknameRequestSchema,
  setSourceNicknameResponseSchema,
  sourceFileSchema,
  startIngestRequestSchema,
  updateSettingsRequestSchema,
} from './index';

describe('shared domain contracts', () => {
  it('parses a complete source file', () => {
    const parsed = sourceFileSchema.parse({
      id: 'source-file-1',
      sourceId: 'source-1',
      absolutePath: '/Volumes/CARD/DCIM/clip.mov',
      relativePath: 'DCIM/clip.mov',
      name: 'clip.mov',
      extension: '.mov',
      sizeBytes: 42,
      modifiedAt: '2026-07-19T12:00:00.000Z',
      kind: 'video',
      status: 'discovered',
    });

    expect(parsed.kind).toBe('video');
  });

  it('rejects unknown ingest statuses', () => {
    expect(() =>
      sourceFileSchema.parse({
        id: 'file-1',
        sourceId: 'source-1',
        absolutePath: '/clip.mov',
        relativePath: 'clip.mov',
        name: 'clip.mov',
        extension: '.mov',
        sizeBytes: 42,
        modifiedAt: '2026-07-19T12:00:00.000Z',
        kind: 'video',
        status: 'almost-done',
      }),
    ).toThrow();
  });

  it('requires review plans to account for every file', () => {
    expect(() =>
      reviewPlanSchema.parse({
        id: 'plan-1',
        sourceId: 'source-1',
        createdAt: '2026-07-19T12:00:00.000Z',
        destinationRoot: '/Archive',
        files: [],
        summary: { totalFiles: 1, totalBytes: 42, readyFiles: 1, blockedFiles: 0 },
      }),
    ).toThrow();
  });

  it('parses typed errors by code', () => {
    const result = appErrorSchema.parse({
      code: 'COPY_FAILED',
      message: 'Copy failed',
      retryable: true,
      details: { sourcePath: '/card/a.mov', destinationPath: '/archive/a.mov' },
    });

    expect(result.code).toBe('COPY_FAILED');
  });

  it('validates progress events and IPC requests strictly', () => {
    expect(
      ingestProgressEventSchema.parse({
        type: 'copy-progress',
        jobId: 'job-1',
        completedBytes: 10,
        totalBytes: 100,
        occurredAt: '2026-07-19T12:00:00.000Z',
      }).type,
    ).toBe('copy-progress');

    expect(ipcRequestSchemas.health.safeParse({ unexpected: true }).success).toBe(false);
  });

  it('parses opaque folder capabilities without exposing privileged paths', () => {
    const selection = chooseFolderResponseSchema.parse({
      status: 'selected',
      capabilityId: 'capability-1',
      label: 'CARD A',
      displayPath: '…/CARD A',
      expiresAt: '2026-07-19T12:05:00.000Z',
    });

    expect(selection.status).toBe('selected');
    expect(chooseFolderResponseSchema.parse({ status: 'cancelled' })).toEqual({
      status: 'cancelled',
    });
    expect(() =>
      chooseFolderResponseSchema.parse({
        status: 'selected',
        capabilityId: 'capability-1',
        label: 'CARD A',
        displayPath: '…/CARD A',
        expiresAt: '2026-07-19T12:05:00.000Z',
        path: '/Volumes/CARD A',
      }),
    ).toThrow();
  });

  it('rejects renderer supplied paths in review and start requests', () => {
    expect(
      reviewIngestRequestSchema.safeParse({
        sourceCapabilityId: 'source-capability',
        destinationCapabilityId: 'destination-capability',
      }).success,
    ).toBe(true);
    expect(
      reviewIngestRequestSchema.safeParse({
        sourceCapabilityId: 'source-capability',
        destinationCapabilityId: 'destination-capability',
        sourcePath: '/forged/source',
      }).success,
    ).toBe(false);
    expect(
      startIngestRequestSchema.safeParse({
        reviewId: 'review-1',
        sourcePath: '/forged/source',
      }).success,
    ).toBe(false);
    expect(
      startIngestRequestSchema.safeParse({
        reviewId: 'review-1',
        sourceDecision: { action: 'existing', sourceId: 'known-source-1' },
      }).success,
    ).toBe(true);
  });

  it('parses review estimates and durable session snapshots', () => {
    expect(
      reviewIngestResponseSchema.parse({
        ok: true,
        value: {
          reviewId: 'review-1',
          expiresAt: '2026-07-19T12:05:00.000Z',
          source: {
            displayName: 'CARD A',
            identity: 'New source',
            confidence: 'medium',
          },
          counts: { new: 2, known: 1, ambiguous: 0, recoverable: 0 },
          estimatedBytes: 2048,
          destinationPreview: 'Archive/2026/2026-07-19/CARD A',
        },
      }).value.counts.new,
    ).toBe(2);

    expect(
      sessionSnapshotSchema.parse({
        sessionId: 'session-1',
        sourceId: 'source-1',
        status: 'copying',
        phase: 'Copying',
        totalFiles: 3,
        completedFiles: 1,
        skippedFiles: 1,
        failedFiles: 0,
        totalBytes: 2048,
        completedBytes: 1024,
        currentFile: 'clip.mov',
        throughputBytesPerSecond: 512,
        errors: [],
        startedAt: '2026-07-19T12:00:00.000Z',
        updatedAt: '2026-07-19T12:00:02.000Z',
      }),
    ).toMatchObject({ status: 'copying', sourceId: 'source-1' });
  });

  it('parses opaque recoverable-session claims without persisted session ids', () => {
    const response = listRecoverableSessionsResponseSchema.parse({
      ok: true,
      sessions: [
        {
          claimCapabilityId: 'claim-1',
          expiresAt: '2026-07-19T12:05:00.000Z',
          status: 'failed',
          phase: 'Failed',
          totalFiles: 4,
          completedFiles: 2,
          skippedFiles: 1,
          failedFiles: 1,
          startedAt: '2026-07-19T12:00:00.000Z',
          updatedAt: '2026-07-19T12:01:00.000Z',
          error: { code: 'INGEST_FAILED', message: 'The ingest could not be completed.' },
        },
      ],
    });

    expect(response.sessions[0]).not.toHaveProperty('sessionId');
    expect(claimSessionRequestSchema.safeParse({ claimCapabilityId: 'claim-1' }).success).toBe(
      true,
    );
    expect(
      claimSessionRequestSchema.safeParse({
        claimCapabilityId: 'claim-1',
        sessionId: 'forged-session',
      }).success,
    ).toBe(false);
  });

  it('exposes detected sources and settings without privileged paths', () => {
    const detected = detectedSourceListResponseSchema.parse({
      ok: true,
      sources: [
        {
          id: 'runtime-device-1',
          strongPlatformId: 'disk:serial-1',
          capabilityId: 'window-source-capability',
          label: 'CARD',
          kind: 'removable-volume',
          online: true,
          identityConfidence: 'exact',
          reasons: ['strong-platform-volume-id-match'],
          requiresConfirmation: false,
          expiresAt: '2026-07-19T12:05:00.000Z',
          deviceVendor: 'SanDisk',
          deviceModel: 'Extreme Pro',
        },
      ],
    });
    expect(detected.sources[0]).not.toHaveProperty('path');
    expect(detected.sources[0]?.strongPlatformId).toBe('disk:serial-1');
    expect(detected.sources[0]?.deviceModel).toBe('Extreme Pro');
    expect(() =>
      detectedSourceListResponseSchema.parse({
        ...detected,
        sources: [{ ...detected.sources[0], mountPath: '/Volumes/CARD' }],
      }),
    ).toThrow();

    expect(
      getSettingsResponseSchema.parse({
        ok: true,
        settings: {
          destination: { configured: true, label: 'Archive' },
          allowedExtensions: ['.jpg'],
          excludedPathPatterns: ['.Trashes'],
          destinationTemplate: '{YYYY}/{YYYY-MM-DD}/{sourceLabelOrCamera}/{originalFilename}',
          copyConcurrency: 1,
          thumbnail: {
            width: 480,
            height: 480,
            cachePolicy: 'bounded',
            cacheLimitBytes: 2_000_000_000,
          },
          verifyCopies: true,
        },
      }).settings.destination,
    ).toEqual({ configured: true, label: 'Archive' });

    expect(
      getSettingsResponseSchema.parse({
        ok: true,
        settings: {
          destination: { configured: false },
          allowedExtensions: ['.jpg'],
          excludedPathPatterns: [],
          destinationTemplate: '{YYYY}/{originalFilename}',
          copyConcurrency: 1,
          groupByNicknameInDestination: true,
          perCardEventLog: true,
          thumbnail: {
            width: 480,
            height: 480,
            cachePolicy: 'bounded',
            cacheLimitBytes: 2_000_000_000,
          },
          verifyCopies: true,
        },
      }).settings,
    ).toMatchObject({ groupByNicknameInDestination: true, perCardEventLog: true });
    expect(
      updateSettingsRequestSchema.safeParse({
        destinationPath: '/forged/archive',
        allowedExtensions: ['.jpg'],
      }).success,
    ).toBe(false);
  });

  it('parses known-source history with verified totals and no paths', () => {
    const response = listKnownSourcesResponseSchema.parse({
      ok: true,
      sources: [
        {
          id: 'source-1',
          fingerprint: 'source-fallback-v1:abc',
          algorithmVersion: 1,
          displayName: 'CARD',
          nickname: 'canon-r5',
          kind: 'removable-volume',
          online: false,
          firstSeenAt: '2026-07-01T12:00:00.000Z',
          lastSeenAt: '2026-07-19T12:00:00.000Z',
          sessionCount: 3,
          lastSessionStatus: 'completed',
          verifiedMediaCount: 120,
          verifiedBytes: 42_000,
          identityConfidence: 'exact',
          throughput: {
            averageBytesPerSecond: 1_000_000,
            lastBytesPerSecond: 200_000,
            sampleCount: 4,
            isSlow: true,
          },
        },
      ],
    });
    expect(response.sources[0]).not.toHaveProperty('rootPath');
    expect(response.sources[0]).toMatchObject({
      fingerprint: 'source-fallback-v1:abc',
      algorithmVersion: 1,
      nickname: 'canon-r5',
      throughput: { isSlow: true },
    });
  });

  it('validates kebab-case source nicknames over IPC', () => {
    expect(
      setSourceNicknameRequestSchema.safeParse({ sourceId: 'source-1', nickname: 'canon-r5' })
        .success,
    ).toBe(true);
    expect(
      setSourceNicknameRequestSchema.safeParse({ sourceId: 'source-1', nickname: null }).success,
    ).toBe(true);
    expect(
      setSourceNicknameRequestSchema.safeParse({ sourceId: 'source-1', nickname: 'Canon R5' })
        .success,
    ).toBe(false);
    expect(setSourceNicknameResponseSchema.parse({ ok: true, nickname: 'canon-r5' }).nickname).toBe(
      'canon-r5',
    );
  });

  it('requires opaque recovery capabilities and rejects source paths', () => {
    expect(
      recoverSessionRequestSchema.safeParse({
        claimCapabilityId: 'claim-1',
        action: 'resume',
        sourceCapabilityId: 'source-capability',
      }).success,
    ).toBe(true);
    expect(
      recoverSessionRequestSchema.safeParse({
        claimCapabilityId: 'claim-1',
        action: 'resume',
        sourcePath: '/forged/card',
      }).success,
    ).toBe(false);
  });
});

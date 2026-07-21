import { describe, expect, it } from 'vitest';

import {
  listSummaryDaysRequestSchema,
  listSummaryMediaRequestSchema,
  retryThumbnailRequestSchema,
  summaryMediaSchema,
} from './ipc.js';

describe('summary IPC contracts', () => {
  it('validates bounded filters, dates, limits, and opaque cursors', () => {
    expect(
      listSummaryDaysRequestSchema.parse({
        sourceId: 'source',
        mediaType: 'photo',
      }),
    ).toEqual({ sourceId: 'source', mediaType: 'photo' });
    expect(() => listSummaryDaysRequestSchema.parse({ mediaType: 'audio' })).toThrow();
    expect(() =>
      listSummaryMediaRequestSchema.parse({ captureDay: '19/07/2026', limit: 40 }),
    ).toThrow();
    expect(() =>
      listSummaryMediaRequestSchema.parse({ captureDay: '2026-07-19', limit: 501 }),
    ).toThrow();
  });

  it('rejects renderer-visible filesystem paths', () => {
    const safe = {
      id: 'file',
      copyId: 'copy',
      checksum: 'sha',
      captureDay: '2026-07-19',
      capturedAt: '2026-07-19T10:00:00.000Z',
      originalFilename: 'generated.jpg',
      mediaType: 'photo',
      sizeBytes: 10,
      cameraMake: null,
      cameraModel: null,
      width: 10,
      height: 10,
      durationSeconds: null,
      thumbnail: { state: 'ready', token: 'opaque', mimeType: 'image/webp', width: 10, height: 10 },
    };
    expect(summaryMediaSchema.parse(safe)).toEqual(safe);
    expect(() => summaryMediaSchema.parse({ ...safe, cachePath: '/private/cache' })).toThrow();
  });

  it('accepts UTC, explicit-offset, and floating capture times', () => {
    const base = {
      id: 'file',
      copyId: 'copy',
      checksum: 'sha',
      captureDay: '2024-08-09',
      originalFilename: 'generated.jpg',
      mediaType: 'photo',
      sizeBytes: 10,
      cameraMake: null,
      cameraModel: null,
      width: 10,
      height: 10,
      durationSeconds: null,
      thumbnail: { state: 'missing' },
    };
    for (const capturedAt of [
      '2024-08-09T10:11:12Z',
      '2024-08-09T10:11:12+05:00',
      '2024-08-09T10:11:12',
      '2024-08-09T10:11:12.500-07:00',
    ]) {
      expect(summaryMediaSchema.parse({ ...base, capturedAt })).toEqual({ ...base, capturedAt });
    }
    expect(() =>
      summaryMediaSchema.parse({ ...base, capturedAt: '2024-08-09 10:11:12' }),
    ).toThrow();
    expect(() =>
      summaryMediaSchema.parse({ ...base, capturedAt: '2024-13-09T10:11:12Z' }),
    ).toThrow();
  });

  it('validates explicit thumbnail retry identifiers', () => {
    expect(retryThumbnailRequestSchema.parse({ capability: 'opaque-retry' })).toEqual({
      capability: 'opaque-retry',
    });
    expect(() => retryThumbnailRequestSchema.parse({ copyId: 'copy-1' })).toThrow();
    expect(() =>
      retryThumbnailRequestSchema.parse({ capability: 'opaque-retry', copyId: 'copy-1' }),
    ).toThrow();
  });

  it('requires an expiring retry capability on failed thumbnail DTOs', () => {
    const failed = {
      id: 'file',
      copyId: 'copy',
      checksum: 'sha',
      captureDay: '2026-07-19',
      capturedAt: null,
      originalFilename: 'generated.jpg',
      mediaType: 'photo',
      sizeBytes: 10,
      cameraMake: null,
      cameraModel: null,
      width: null,
      height: null,
      durationSeconds: null,
      thumbnail: {
        state: 'failed',
        errorCode: 'THUMBNAIL_FAILED',
        safeMessage: 'Thumbnail unavailable.',
        retryCount: 1,
        attemptCount: 1,
        nextRetryAt: '2026-07-19T12:01:00.000Z',
        maxAttempts: 3,
        retryCapability: {
          token: 'opaque-retry',
          expiresAt: '2026-07-19T12:02:00.000Z',
        },
      },
    };
    expect(summaryMediaSchema.parse(failed)).toEqual(failed);
    expect(() =>
      summaryMediaSchema.parse({
        ...failed,
        thumbnail: { ...failed.thumbnail, retryCapability: undefined },
      }),
    ).toThrow();
  });
});

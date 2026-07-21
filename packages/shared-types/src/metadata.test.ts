import { describe, expect, it } from 'vitest';

import { ingestMetadataSchema, normalizedCaptureSchema } from './metadata.js';

const offsetCapture = {
  captureAt: '2024-12-31T23:30:01-07:00',
  captureAtSource: 'DateTimeOriginal',
  captureAtRaw: '2024:12:31 23:30:01-07:00',
  captureTimezoneKind: 'offset',
  captureOffsetMinutes: -420,
  captureOffsetSource: 'inline',
  captureOffsetRaw: '-07:00',
  captureDay: '2024-12-31',
} as const;

describe('normalized metadata contracts', () => {
  it('accepts zoned, floating, and fallback capture representations', () => {
    expect(normalizedCaptureSchema.parse(offsetCapture)).toEqual(offsetCapture);
    expect(
      normalizedCaptureSchema.parse({
        ...offsetCapture,
        captureAt: '2024-03-10T01:30:00',
        captureAtRaw: '2024:03:10 01:30:00',
        captureTimezoneKind: 'floating',
        captureOffsetMinutes: null,
        captureOffsetSource: null,
        captureOffsetRaw: null,
        captureDay: '2024-03-10',
      }),
    ).toMatchObject({ captureTimezoneKind: 'floating' });
    expect(
      normalizedCaptureSchema.parse({
        ...offsetCapture,
        captureAt: '2026-07-19T12:00:00.000Z',
        captureAtSource: 'filesystem-modifiedAt',
        captureAtRaw: '2026-07-19T12:00:00.000Z',
        captureTimezoneKind: 'fallback',
        captureOffsetMinutes: 0,
        captureOffsetSource: null,
        captureOffsetRaw: null,
        captureDay: '2026-07-19',
      }),
    ).toMatchObject({ captureTimezoneKind: 'fallback' });
  });

  it.each([
    '2024-12-31T99:99:99-07:00',
    '2024-02-30T12:00:00-07:00',
    '2023-02-29T12:00:00-07:00',
    '2024-12-31T24:00:00-07:00',
    '2024-12-31T23:60:00-07:00',
    '2024-12-31T23:59:60-07:00',
    '2024-12-31T23:59:59+14:01',
    '2024-12-31T23:59:59-15:00',
  ])('rejects an invalid Gregorian offset timestamp %s', (captureAt) => {
    expect(() => normalizedCaptureSchema.parse({ ...offsetCapture, captureAt })).toThrow();
  });

  it('validates floating, offset, and UTC components independently of host timezone', () => {
    const validValues = [
      {
        ...offsetCapture,
        captureAt: '2024-02-29T23:59:59.123456789',
        captureAtRaw: '2024:02:29 23:59:59.123456789',
        captureTimezoneKind: 'floating',
        captureOffsetMinutes: null,
        captureOffsetSource: null,
        captureOffsetRaw: null,
        captureDay: '2024-02-29',
      },
      {
        ...offsetCapture,
        captureAt: '2000-02-29T00:00:00+14:00',
        captureAtRaw: '2000:02:29 00:00:00+14:00',
        captureOffsetMinutes: 840,
        captureOffsetRaw: '+14:00',
        captureDay: '2000-02-29',
      },
      {
        ...offsetCapture,
        captureAt: '1900-02-28T00:00:00Z',
        captureAtRaw: '1900:02:28 00:00:00Z',
        captureTimezoneKind: 'utc',
        captureOffsetMinutes: 0,
        captureOffsetRaw: 'Z',
        captureDay: '1900-02-28',
      },
    ];
    const previousTimezone = process.env.TZ;
    try {
      for (const timezone of ['Pacific/Kiritimati', 'America/Los_Angeles']) {
        process.env.TZ = timezone;
        for (const value of validValues)
          expect(normalizedCaptureSchema.parse(value)).toEqual(value);
      }
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it.each([
    { captureTimezoneKind: 'floating', captureOffsetMinutes: 60 },
    { captureTimezoneKind: 'offset', captureOffsetMinutes: null },
    { captureTimezoneKind: 'offset', captureOffsetSource: null },
    { captureTimezoneKind: 'utc', captureOffsetMinutes: 60 },
    { captureTimezoneKind: 'fallback', captureAtSource: 'DateTimeOriginal' },
    { captureOffsetMinutes: 120 },
    { captureOffsetRaw: '+02:00' },
    { captureAt: '2024-12-31T23:30:01+02:00' },
    { captureDay: '2024-02-31' },
    { captureAt: '2024-01-01T00:00:00', captureTimezoneKind: 'offset' },
  ])('rejects inconsistent capture metadata %#', (change) => {
    expect(() => normalizedCaptureSchema.parse({ ...offsetCapture, ...change })).toThrow();
  });

  it('strictly validates complete ingest metadata', () => {
    const metadata = {
      ...offsetCapture,
      cameraMake: 'Canon',
      cameraModel: 'EOS R5',
      lensModel: null,
      mimeType: 'image/jpeg',
      mediaType: 'photo',
      width: 8192,
      height: 5464,
      durationSeconds: null,
      gpsPresent: true,
      warnings: [],
    };
    expect(ingestMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(() => ingestMetadataSchema.parse({ ...metadata, gpsPresent: 'yes' })).toThrow();
    expect(() => ingestMetadataSchema.parse({ ...metadata, extra: 'unsafe' })).toThrow();
    expect(() => ingestMetadataSchema.parse({ ...metadata, mediaType: 'audio' })).toThrow();
  });
});

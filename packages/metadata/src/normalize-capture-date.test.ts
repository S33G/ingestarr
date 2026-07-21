import { describe, expect, it } from 'vitest';

import { normalizeCaptureDate, type CaptureDateCandidates } from './normalize-capture-date.js';

const modifiedAt = '2026-07-19T12:00:00.000Z';
const sessionStartedAt = '2026-07-19T11:00:00.000Z';

function normalize(candidates: CaptureDateCandidates) {
  return normalizeCaptureDate({ candidates, modifiedAt, sessionStartedAt });
}

describe('normalizeCaptureDate', () => {
  it('uses the explicit tag priority and preserves a zoned original value', () => {
    expect(
      normalize({
        DateTimeOriginal: '2024:12:31 23:30:01-07:00',
        CreateDate: '2025:01:01 06:30:01Z',
        QuickTimeCreateDate: '2023:01:02 03:04:05Z',
      }),
    ).toEqual({
      captureAt: '2024-12-31T23:30:01-07:00',
      captureAtSource: 'DateTimeOriginal',
      captureAtRaw: '2024:12:31 23:30:01-07:00',
      captureTimezoneKind: 'offset',
      captureOffsetMinutes: -420,
      captureOffsetSource: 'inline',
      captureOffsetRaw: '-07:00',
      captureDay: '2024-12-31',
    });
  });

  it('keeps a zone-less camera date floating without inventing UTC', () => {
    const priorTz = process.env.TZ;
    let east;
    let west;
    try {
      process.env.TZ = 'Pacific/Kiritimati';
      east = normalize({ DateTimeOriginal: '2024:03:10 01:30:00' });
      process.env.TZ = 'America/Los_Angeles';
      west = normalize({ DateTimeOriginal: '2024:03:10 01:30:00' });
    } finally {
      if (priorTz === undefined) delete process.env.TZ;
      else process.env.TZ = priorTz;
    }

    expect(east).toEqual(west);
    expect(east).toEqual({
      captureAt: '2024-03-10T01:30:00',
      captureAtSource: 'DateTimeOriginal',
      captureAtRaw: '2024:03:10 01:30:00',
      captureTimezoneKind: 'floating',
      captureOffsetMinutes: null,
      captureOffsetSource: null,
      captureOffsetRaw: null,
      captureDay: '2024-03-10',
    });
  });

  it('combines a separate offset tag with DateTimeOriginal', () => {
    expect(
      normalize({
        DateTimeOriginal: '2024:06:01 12:34:56',
        OffsetTimeOriginal: '+05:30',
      }),
    ).toMatchObject({
      captureAt: '2024-06-01T12:34:56+05:30',
      captureTimezoneKind: 'offset',
      captureOffsetMinutes: 330,
      captureOffsetSource: 'OffsetTimeOriginal',
      captureOffsetRaw: '+05:30',
      captureDay: '2024-06-01',
    });
  });

  it('preserves offset provenance from a vendored ExifDateTime value', () => {
    expect(
      normalize({
        DateTimeOriginal: '2024:08:09 10:11:12',
        DateTimeOriginalOffset: '+02:30',
      }),
    ).toMatchObject({
      captureAt: '2024-08-09T10:11:12+02:30',
      captureAtRaw: '2024:08:09 10:11:12',
      captureOffsetMinutes: 150,
      captureOffsetSource: 'ExifDateTime',
      captureOffsetRaw: '+02:30',
    });
  });

  it('orders QuickTime container, track, and media candidates', () => {
    expect(
      normalize({
        CreationDate: '2024:01:15 03:04:05Z',
        QuickTimeCreateDate: '2024:01:02 03:04:05Z',
        TrackCreateDate: '2024:02:03 04:05:06Z',
        MediaCreateDate: '2024:03:04 05:06:07Z',
      }).captureAtSource,
    ).toBe('QuickTimeCreateDate');
    expect(
      normalize({
        CreationDate: '2024:01:15 03:04:05Z',
        TrackCreateDate: '2024:02:03 04:05:06Z',
      }).captureAtSource,
    ).toBe('CreationDate');
    expect(
      normalize({
        TrackCreateDate: '2024:02:03 04:05:06Z',
        MediaCreateDate: '2024:03:04 05:06:07Z',
      }).captureAtSource,
    ).toBe('TrackCreateDate');
  });

  it('skips invalid, zero, and implausible metadata dates', () => {
    expect(
      normalize({
        DateTimeOriginal: '0000:00:00 00:00:00',
        CreateDate: '1800:01:01 00:00:00',
        QuickTimeCreateDate: 'not a date',
      }),
    ).toEqual({
      captureAt: modifiedAt,
      captureAtSource: 'filesystem-modifiedAt',
      captureAtRaw: modifiedAt,
      captureTimezoneKind: 'fallback',
      captureOffsetMinutes: 0,
      captureOffsetSource: null,
      captureOffsetRaw: null,
      captureDay: '2026-07-19',
    });
  });

  it.each(['+15:00', '+14:01', '-25:00'])(
    'rejects an explicit malformed inline offset %s and continues priority fallback',
    (offset) => {
      expect(
        normalize({
          DateTimeOriginal: `2024:06:01 12:34:56${offset}`,
          CreateDate: '2024:06:02 01:02:03Z',
        }),
      ).toMatchObject({
        captureAtSource: 'CreateDate',
        captureAt: '2024-06-02T01:02:03Z',
        captureDay: '2024-06-02',
      });
    },
  );

  it('falls back from invalid modifiedAt to the session instant', () => {
    expect(
      normalizeCaptureDate({
        candidates: {},
        modifiedAt: 'invalid',
        sessionStartedAt,
      }),
    ).toMatchObject({
      captureAt: sessionStartedAt,
      captureAtSource: 'session-start',
      captureTimezoneKind: 'fallback',
      captureDay: '2026-07-19',
    });
  });
});

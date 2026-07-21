import { describe, expect, it, vi } from 'vitest';

import {
  createExifToolClient,
  MetadataAbortError,
  MetadataClientUnavailableError,
  MetadataGenerationRecycledError,
  MetadataTimeoutError,
} from './exiftool-client.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ExifTool metadata client', () => {
  it('extracts only normalized read-only fields and reduces GPS to presence', async () => {
    const read = vi.fn(async () => ({
      DateTimeOriginal: '2024:02:03 04:05:06',
      OffsetTimeOriginal: '+01:30',
      CreateDate: '2024:02:03 03:05:06Z',
      Make: ' Canon ',
      Model: ' EOS R5 ',
      LensModel: ' RF24-70mm ',
      MIMEType: 'image/jpeg',
      FileType: 'JPEG',
      ImageWidth: 8192,
      ImageHeight: 5464,
      GPSLatitude: 51.5,
      GPSLongitude: -0.1,
      Warning: ['Minor metadata warning'],
      errors: ['Recoverable parse warning'],
    }));
    const client = createExifToolClient({
      exiftool: { read, end: vi.fn(async () => {}) },
      timeoutMs: 100,
    });

    const result = await client.extract('/private/photo.jpg');

    expect(read).toHaveBeenCalledWith('/private/photo.jpg', { readArgs: [] });
    expect(result).toEqual({
      dates: {
        DateTimeOriginal: '2024:02:03 04:05:06',
        OffsetTimeOriginal: '+01:30',
        CreateDate: '2024:02:03 03:05:06Z',
      },
      cameraMake: 'Canon',
      cameraModel: 'EOS R5',
      lensModel: 'RF24-70mm',
      mimeType: 'image/jpeg',
      fileType: 'JPEG',
      width: 8192,
      height: 5464,
      durationSeconds: null,
      gpsPresent: true,
      warnings: ['Minor metadata warning', 'Recoverable parse warning'],
    });
    expect(JSON.stringify(result)).not.toContain('51.5');
    expect(JSON.stringify(result)).not.toContain('-0.1');
  });

  it('preserves a real-shaped vendored ExifDateTime raw value', async () => {
    const date = {
      rawValue: '2024:08:09 10:11:12',
      tzoffsetMinutes: 150,
      toISOString: () => '2024-08-09T10:11:12.000+02:30',
      toString: () => '2024-08-09T10:11:12.000+02:30',
    };
    const client = createExifToolClient({
      exiftool: {
        read: vi.fn(async () => ({ DateTimeOriginal: date })),
        end: vi.fn(async () => {}),
      },
    });

    await expect(client.extract('/photo.jpg')).resolves.toMatchObject({
      dates: {
        DateTimeOriginal: '2024:08:09 10:11:12',
        DateTimeOriginalOffset: '+02:30',
      },
    });
    await client.close();
  });

  it.each([
    [{}, false],
    [{ GPSLatitude: 51.5 }, false],
    [{ GPSLongitude: -0.1 }, false],
    [{ GPSLatitude: '', GPSLongitude: '' }, false],
    [{ GPSLatitude: null, GPSLongitude: null }, false],
    [{ GPSLatitude: 51.5, GPSLongitude: -0.1 }, true],
    [{ GPSLatitude: '51.5 N', GPSLongitude: '0.1 W' }, true],
    [{ GPSPosition: '51.5 -0.1' }, true],
  ] as const)('reduces GPS tags %# to presence=%s', async (tags, expected) => {
    const client = createExifToolClient({
      exiftool: { read: vi.fn(async () => tags), end: vi.fn(async () => {}) },
    });

    const result = await client.extract('/photo.jpg');

    expect(result.gpsPresent).toBe(expected);
    expect(result).not.toHaveProperty('GPSLatitude');
    expect(result).not.toHaveProperty('GPSLongitude');
    await client.close();
  });

  it('enforces bounded concurrency while isolating worker failures', async () => {
    const first = deferred<Record<string, unknown>>();
    let active = 0;
    let peak = 0;
    const read = vi.fn(async (file: string) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        if (file.endsWith('one.jpg')) return await first.promise;
        if (file.endsWith('bad.jpg')) throw new Error('bad file');
        return { MIMEType: 'image/jpeg' };
      } finally {
        active -= 1;
      }
    });
    const client = createExifToolClient({
      exiftool: { read, end: vi.fn(async () => {}) },
      concurrency: 1,
      timeoutMs: 1_000,
    });

    const one = client.extract('/one.jpg');
    const bad = client.extract('/bad.jpg');
    const three = client.extract('/three.jpg');
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    first.resolve({ MIMEType: 'image/jpeg' });

    await expect(one).resolves.toMatchObject({ mimeType: 'image/jpeg' });
    await expect(bad).rejects.toThrow('bad file');
    await expect(three).resolves.toMatchObject({ mimeType: 'image/jpeg' });
    expect(peak).toBe(1);
  });

  it('rejects queued and active work promptly on abort', async () => {
    const never = new Promise<Record<string, unknown>>(() => {});
    const read = vi.fn(async () => never);
    const client = createExifToolClient({
      exiftool: { read, end: vi.fn(async () => {}) },
      concurrency: 1,
      timeoutMs: 1_000,
    });
    const firstAbort = new AbortController();
    const queuedAbort = new AbortController();
    const first = client.extract('/one.jpg', { signal: firstAbort.signal });
    const queued = client.extract('/two.jpg', { signal: queuedAbort.signal });
    const firstRejected = expect(first).rejects.toBeInstanceOf(MetadataAbortError);
    const queuedRejected = expect(queued).rejects.toBeInstanceOf(MetadataAbortError);

    queuedAbort.abort();
    expect(client.status()).toMatchObject({ queued: 0, active: 1 });
    firstAbort.abort();

    await firstRejected;
    await queuedRejected;
    expect(read).toHaveBeenCalledTimes(1);
    expect(client.status()).toMatchObject({ queued: 0, active: 0 });
  });

  it('removes a queued task immediately on its own timeout', async () => {
    vi.useFakeTimers();
    const client = createExifToolClient({
      exiftool: {
        read: vi.fn(async () => new Promise<Record<string, unknown>>(() => {})),
        end: vi.fn(async () => {}),
      },
      concurrency: 1,
      timeoutMs: 1_000,
    });
    void client.extract('/active.mov').catch(() => {});
    const queued = client.extract('/queued.mov', { timeoutMs: 25 });
    const rejected = expect(queued).rejects.toBeInstanceOf(MetadataTimeoutError);
    expect(client.status()).toMatchObject({ queued: 1, active: 1 });
    await vi.advanceTimersByTimeAsync(26);
    await rejected;
    expect(client.status()).toMatchObject({ queued: 0, active: 1 });
    await client.close();
    vi.useRealTimers();
  });

  it('recycles a hung generation after timeout so later work succeeds', async () => {
    vi.useFakeTimers();
    const firstEnd = vi.fn(async () => {});
    const secondEnd = vi.fn(async () => {});
    const factory = vi
      .fn()
      .mockReturnValueOnce({
        read: vi.fn(async () => new Promise<Record<string, unknown>>(() => {})),
        end: firstEnd,
      })
      .mockReturnValueOnce({
        read: vi.fn(async () => ({ MIMEType: 'video/mp4' })),
        end: secondEnd,
      });
    const client = createExifToolClient({
      exiftoolFactory: factory,
      concurrency: 1,
      timeoutMs: 50,
    });

    const hung = client.extract('/hung.mov');
    const rejected = expect(hung).rejects.toBeInstanceOf(MetadataTimeoutError);
    await vi.advanceTimersByTimeAsync(51);
    await rejected;

    expect(firstEnd).toHaveBeenCalledWith(false);
    expect(client.status()).toMatchObject({ queued: 0, active: 0, generations: 1 });
    await expect(client.extract('/later.mov')).resolves.toMatchObject({ mimeType: 'video/mp4' });
    await client.close();
    expect(secondEnd).toHaveBeenCalledWith(true);
    vi.useRealTimers();
  });

  it('predictably rejects sibling tasks when an active generation is recycled', async () => {
    const abort = new AbortController();
    const factory = vi
      .fn()
      .mockReturnValueOnce({
        read: vi.fn(async () => new Promise<Record<string, unknown>>(() => {})),
        end: vi.fn(async () => {}),
      })
      .mockReturnValueOnce({
        read: vi.fn(async () => ({ MIMEType: 'image/jpeg' })),
        end: vi.fn(async () => {}),
      });
    const client = createExifToolClient({
      exiftoolFactory: factory,
      concurrency: 2,
      timeoutMs: 1_000,
    });
    const triggering = client.extract('/one.jpg', { signal: abort.signal });
    const sibling = client.extract('/two.jpg');
    const triggeringRejected = expect(triggering).rejects.toBeInstanceOf(MetadataAbortError);
    const siblingRejected = expect(sibling).rejects.toBeInstanceOf(MetadataGenerationRecycledError);

    abort.abort();

    await triggeringRejected;
    await siblingRejected;
    expect(client.status()).toMatchObject({ queued: 0, active: 0, generations: 1 });
    await expect(client.extract('/three.jpg')).resolves.toMatchObject({ mimeType: 'image/jpeg' });
    await client.close();
  });

  it('does not retain settled generations across repeated recycle cycles', async () => {
    vi.useFakeTimers();
    const ends = Array.from({ length: 4 }, () => vi.fn(async () => {}));
    const factory = vi.fn();
    for (const end of ends) {
      factory.mockReturnValueOnce({
        read: vi.fn(async () => new Promise<Record<string, unknown>>(() => {})),
        end,
      });
    }
    const client = createExifToolClient({
      exiftoolFactory: factory,
      concurrency: 1,
      timeoutMs: 10,
    });

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const extraction = client.extract(`/hung-${cycle}.jpg`);
      const rejected = expect(extraction).rejects.toBeInstanceOf(MetadataTimeoutError);
      await vi.advanceTimersByTimeAsync(11);
      await rejected;
      await Promise.resolve();
      expect(client.status()).toEqual({
        queued: 0,
        active: 0,
        generations: 1,
        closed: false,
        circuitOpen: false,
      });
    }

    await client.close();
    expect(ends.slice(0, 3).map((end) => end.mock.calls)).toEqual([
      [[false]],
      [[false]],
      [[false]],
    ]);
    expect(ends[3]).toHaveBeenCalledWith(true);
    expect(client.status()).toEqual({
      queued: 0,
      active: 0,
      generations: 0,
      closed: true,
      circuitOpen: false,
    });
    vi.useRealTimers();
  });

  it('awaits pending retired cleanup without starting a replacement during shutdown', async () => {
    vi.useFakeTimers();
    const retiredEnd = deferred<void>();
    const currentEnd = vi.fn(async () => {});
    const factory = vi
      .fn()
      .mockReturnValueOnce({
        read: vi.fn(async () => new Promise<Record<string, unknown>>(() => {})),
        end: vi.fn(async (gracefully?: boolean) => {
          if (gracefully === false) await retiredEnd.promise;
        }),
      })
      .mockReturnValueOnce({
        read: vi.fn(async () => ({})),
        end: currentEnd,
      });
    const client = createExifToolClient({
      exiftoolFactory: factory,
      timeoutMs: 10,
    });
    const extraction = client.extract('/hung.jpg');
    const rejected = expect(extraction).rejects.toBeInstanceOf(MetadataTimeoutError);
    await vi.advanceTimersByTimeAsync(11);
    await rejected;
    expect(client.status().generations).toBe(1);

    let closeSettled = false;
    const closing = client.close().finally(() => {
      closeSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(currentEnd).not.toHaveBeenCalled();
    expect(closeSettled).toBe(false);

    retiredEnd.resolve(undefined);
    await closing;
    expect(factory).toHaveBeenCalledTimes(1);
    expect(currentEnd).not.toHaveBeenCalled();
    expect(client.status().generations).toBe(0);
    vi.useRealTimers();
  });

  it('opens the circuit when forced cleanup hangs and never overlaps replacements', async () => {
    vi.useFakeTimers();
    const end = vi.fn(async () => new Promise<void>(() => {}));
    const factory = vi.fn(() => ({
      read: vi.fn(async () => new Promise<Record<string, unknown>>(() => {})),
      end,
    }));
    const client = createExifToolClient({
      exiftoolFactory: factory,
      timeoutMs: 10,
      cleanupTimeoutMs: 20,
      shutdownTimeoutMs: 25,
    });
    const hung = client.extract('/hung.jpg');
    const timedOut = expect(hung).rejects.toBeInstanceOf(MetadataTimeoutError);
    await vi.advanceTimersByTimeAsync(11);
    await timedOut;
    expect(client.status()).toMatchObject({ generations: 1, circuitOpen: false });

    const queued = client.extract('/queued.jpg', { timeoutMs: 100 });
    const unavailable = expect(queued).rejects.toBeInstanceOf(MetadataClientUnavailableError);
    await vi.advanceTimersByTimeAsync(20);
    await unavailable;

    expect(factory).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(client.status()).toEqual({
      queued: 0,
      active: 0,
      generations: 0,
      closed: false,
      circuitOpen: true,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(client.extract(`/after-${attempt}.jpg`)).rejects.toBeInstanceOf(
        MetadataClientUnavailableError,
      );
      expect(client.status().generations).toBe(0);
    }
    await client.close();
    vi.useRealTimers();
  });

  it('bounds close while forced cleanup remains hung', async () => {
    vi.useFakeTimers();
    const client = createExifToolClient({
      exiftoolFactory: () => ({
        read: vi.fn(async () => new Promise<Record<string, unknown>>(() => {})),
        end: vi.fn(async () => new Promise<void>(() => {})),
      }),
      timeoutMs: 10,
      cleanupTimeoutMs: 1_000,
      shutdownTimeoutMs: 25,
    });
    const extraction = client.extract('/hung.jpg');
    const rejected = expect(extraction).rejects.toBeInstanceOf(MetadataTimeoutError);
    await vi.advanceTimersByTimeAsync(11);
    await rejected;

    let closed = false;
    const closing = client.close().finally(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(24);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await closing;

    expect(client.status()).toEqual({
      queued: 0,
      active: 0,
      generations: 0,
      closed: true,
      circuitOpen: true,
    });
    vi.useRealTimers();
  });

  it('tries graceful shutdown then forces shutdown after the deadline', async () => {
    vi.useFakeTimers();
    const end = vi
      .fn<(gracefully?: boolean) => Promise<void>>()
      .mockImplementationOnce(async () => new Promise<void>(() => {}))
      .mockResolvedValueOnce();
    const client = createExifToolClient({
      exiftool: { read: vi.fn(async () => ({})), end },
      timeoutMs: 100,
      shutdownTimeoutMs: 25,
    });

    const closing = client.close();
    await vi.advanceTimersByTimeAsync(26);
    await closing;

    expect(end.mock.calls).toEqual([[true], [false]]);
    await client.close();
    expect(end).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('forces shutdown during an active hung read and leaves no tasks', async () => {
    vi.useFakeTimers();
    const end = vi.fn(async () => {});
    const client = createExifToolClient({
      exiftool: {
        read: vi.fn(async () => new Promise<Record<string, unknown>>(() => {})),
        end,
      },
      timeoutMs: 1_000,
      shutdownTimeoutMs: 25,
    });
    const active = client.extract('/active.jpg');
    const rejected = expect(active).rejects.toThrow(/closed/i);

    await client.close();
    await rejected;

    expect(end).toHaveBeenCalledWith(true);
    expect(client.status()).toEqual({
      queued: 0,
      active: 0,
      generations: 0,
      closed: true,
      circuitOpen: false,
    });
    vi.useRealTimers();
  });
});

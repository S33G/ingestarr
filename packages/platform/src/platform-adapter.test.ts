import { describe, expect, it, vi } from 'vitest';

import {
  PlatformAvailabilityError,
  createPollingPlatformAdapter,
  type MountedSourceInfo,
  type PlatformAdapter,
} from './platform-adapter.js';

const source = (path: string, id?: string): MountedSourceInfo => ({
  sourceType: 'removable-volume',
  canonicalMountPath: path,
  displayName: path.split('/').at(-1) ?? path,
  removable: true,
  ...(id === undefined ? {} : { platformVolumeId: id }),
  rawFacts: { transport: 'usb' },
});

describe('PlatformAdapter polling contract', () => {
  it('does not emit the initial snapshot and reports later arrivals/removals', async () => {
    const snapshots = [[source('/media/A', 'uuid-a')], [source('/media/B', 'uuid-b')]];
    let poll: (() => void) | undefined;
    const base = {
      listMountedSources: vi.fn(async () => snapshots.shift() ?? []),
      getSourceInfo: vi.fn(),
    };
    const adapter = createPollingPlatformAdapter(base, {
      intervalMs: 10,
      timers: {
        setTimeout(callback) {
          poll = callback;
          return 1;
        },
        clearTimeout: vi.fn(),
      },
    });
    const arrivals: string[] = [];
    const removals: string[] = [];
    const disposeArrival = await adapter.watchSourceArrival((value) =>
      arrivals.push(value.canonicalMountPath),
    );
    const disposeRemoval = await adapter.watchSourceRemoval((value) =>
      removals.push(value.canonicalMountPath),
    );

    expect(arrivals).toEqual([]);
    expect(removals).toEqual([]);
    poll?.();
    await vi.waitFor(() => expect(base.listMountedSources).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(arrivals).toEqual(['/media/B']));
    expect(arrivals).toEqual(['/media/B']);
    expect(removals).toEqual(['/media/A']);
    await Promise.all([disposeArrival(), disposeArrival(), disposeRemoval()]);
  });

  it('keeps the last good snapshot across transient availability failures', async () => {
    let poll: (() => void) | undefined;
    const listMountedSources = vi
      .fn<PlatformAdapter['listMountedSources']>()
      .mockResolvedValueOnce([source('/media/A', 'uuid-a')])
      .mockRejectedValueOnce(new PlatformAvailabilityError('temporary'))
      .mockResolvedValueOnce([]);
    const adapter = createPollingPlatformAdapter(
      { listMountedSources, getSourceInfo: vi.fn() },
      {
        intervalMs: 1,
        timers: {
          setTimeout(callback) {
            poll = callback;
            return 1;
          },
          clearTimeout: vi.fn(),
        },
      },
    );
    const removed: string[] = [];
    const dispose = await adapter.watchSourceRemoval((value) =>
      removed.push(value.canonicalMountPath),
    );
    poll?.();
    await vi.waitFor(() => expect(listMountedSources).toHaveBeenCalledTimes(2));
    expect(removed).toEqual([]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    poll?.();
    await vi.waitFor(() => expect(listMountedSources).toHaveBeenCalledTimes(3));
    expect(removed).toEqual(['/media/A']);
    await dispose();
  });

  it('isolates callback errors, prevents overlapping polls, and awaits in-flight disposal', async () => {
    let poll: (() => void) | undefined;
    let release: (() => void) | undefined;
    const listMountedSources = vi
      .fn<PlatformAdapter['listMountedSources']>()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve([source('/media/A')]);
          }),
      );
    const adapter = createPollingPlatformAdapter(
      { listMountedSources, getSourceInfo: vi.fn() },
      {
        intervalMs: 1,
        timers: {
          setTimeout(callback) {
            poll = callback;
            return 1;
          },
          clearTimeout: vi.fn(),
        },
      },
    );
    const dispose = await adapter.watchSourceArrival(() => {
      throw new Error('consumer failure');
    });
    poll?.();
    poll?.();
    expect(listMountedSources).toHaveBeenCalledTimes(2);
    let disposed = false;
    const firstDisposal = dispose();
    const secondDisposal = dispose();
    expect(secondDisposal).toBe(firstDisposal);
    const disposing = firstDisposal.then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    release?.();
    await disposing;
    expect(disposed).toBe(true);
    expect(dispose()).toBe(firstDisposal);
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  PlatformAvailabilityError,
  type MountedSourceInfo,
  type PlatformAdapter,
  type SourceCallback,
} from '@ingestarr/platform';

import { DetectedSourceRegistry } from './detected-sources';
import { DesktopController } from './controller';

const card: MountedSourceInfo = {
  sourceType: 'removable-volume',
  canonicalMountPath: '/Volumes/CARD',
  displayName: 'CARD',
  volumeLabel: 'CARD',
  platformVolumeId: 'volume-1',
  removable: true,
  rawFacts: {},
};

function adapter() {
  let arrival: SourceCallback | undefined;
  let removal: SourceCallback | undefined;
  const disposeArrival = vi.fn().mockResolvedValue(undefined);
  const disposeRemoval = vi.fn().mockResolvedValue(undefined);
  const value: PlatformAdapter = {
    listMountedSources: vi.fn().mockResolvedValue([card]),
    getSourceInfo: vi.fn(),
    watchSourceArrival: vi.fn(async (callback) => {
      arrival = callback;
      return disposeArrival;
    }),
    watchSourceRemoval: vi.fn(async (callback) => {
      removal = callback;
      return disposeRemoval;
    }),
  };
  return {
    value,
    arrival: () => arrival,
    removal: () => removal,
    disposeArrival,
    disposeRemoval,
  };
}

describe('DetectedSourceRegistry', () => {
  it('starts only when requested, publishes arrivals, and removes unplugged cards at once', async () => {
    const fake = adapter();
    const registry = new DetectedSourceRegistry(fake.value, { id: () => 'runtime-card-1' });
    const changed = vi.fn();
    registry.subscribe(changed);
    expect(fake.value.listMountedSources).not.toHaveBeenCalled();

    await registry.start();
    expect(registry.list()).toEqual([
      expect.objectContaining({
        id: 'runtime-card-1',
        label: 'CARD',
        online: true,
        canonicalMountPath: '/Volumes/CARD',
      }),
    ]);
    // Unplugging a card drops it from the detected list entirely (hotplug parity with reality),
    // rather than lingering as an offline entry.
    await fake.removal()?.(card);
    expect(registry.list()).toEqual([]);
    await fake.arrival()?.({ ...card, canonicalMountPath: '/Volumes/CARD 1' });
    expect(registry.list()[0]).toEqual(
      expect.objectContaining({ online: true, canonicalMountPath: '/Volumes/CARD 1' }),
    );
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('re-resolves a still-mounted volume identity on demand after it is named', async () => {
    const fake = adapter();
    const resolveIdentity = vi.fn().mockResolvedValue(undefined);
    const registry = new DetectedSourceRegistry(fake.value, { id: () => 'rc', resolveIdentity });
    await registry.start();
    // Initial scan found no known identity for the card.
    await vi.waitFor(() => expect(resolveIdentity).toHaveBeenCalledTimes(1));
    expect(registry.list()[0]?.knownSourceId).toBeUndefined();

    // After the user names the card, the app has recorded/marked it — a re-resolve now links it.
    resolveIdentity.mockResolvedValue({ sourceId: 'known-9', nickname: 'gopro' });
    await registry.refreshIdentity('rc');
    expect(registry.list()[0]?.knownSourceId).toBe('known-9');
    expect(registry.list()[0]?.knownNickname).toBe('gopro');
    await registry.close();
  });

  it('resolves known identity for detected volumes and announces genuine arrivals only', async () => {
    const fake = adapter();
    const resolveIdentity = vi
      .fn()
      .mockResolvedValue({ sourceId: 'known-1', nickname: 'canon-r5' });
    const registry = new DetectedSourceRegistry(fake.value, { id: () => 'rc', resolveIdentity });
    const arrivals: Array<{ knownSourceId?: string }> = [];
    registry.onArrival((source) => arrivals.push(source));

    await registry.start();
    // The initial scan resolves identity (folds the volume into its known source) but is not a
    // hotplug arrival, so auto-ingest must not be triggered for it.
    await vi.waitFor(() => expect(registry.list()[0]?.knownSourceId).toBe('known-1'));
    expect(registry.list()[0]?.knownNickname).toBe('canon-r5');
    expect(arrivals).toHaveLength(0);

    await fake.arrival()?.({
      ...card,
      canonicalMountPath: '/Volumes/NEW',
      platformVolumeId: 'volume-2',
    });
    await vi.waitFor(() => expect(arrivals).toHaveLength(1));
    expect(arrivals[0]).toEqual(expect.objectContaining({ knownSourceId: 'known-1' }));
    await registry.close();
  });

  it('starts and closes idempotently and disposes both watchers', async () => {
    const fake = adapter();
    const registry = new DetectedSourceRegistry(fake.value);
    await Promise.all([registry.start(), registry.start()]);
    await Promise.all([registry.close(), registry.close()]);

    expect(fake.value.watchSourceArrival).toHaveBeenCalledTimes(1);
    expect(fake.value.watchSourceRemoval).toHaveBeenCalledTimes(1);
    expect(fake.disposeArrival).toHaveBeenCalledTimes(1);
    expect(fake.disposeRemoval).toHaveBeenCalledTimes(1);
  });

  it('keeps manual source selection available when discovery is unavailable', async () => {
    const fake = adapter();
    vi.mocked(fake.value.listMountedSources).mockRejectedValue(
      new PlatformAvailabilityError('unavailable'),
    );
    const registry = new DetectedSourceRegistry(fake.value);

    await expect(registry.start()).resolves.toBeUndefined();
    expect(registry.list()).toEqual([]);
    expect(fake.value.watchSourceArrival).not.toHaveBeenCalled();
    await expect(registry.close()).resolves.toBeUndefined();
  });

  it('projects window-scoped expiring capabilities without mount paths', async () => {
    const fake = adapter();
    const registry = new DetectedSourceRegistry(fake.value, { id: () => 'runtime-card-1' });
    await registry.start();
    const controller = new DesktopController({
      service: { close: vi.fn(), findLikelyKnownSourceMatches: vi.fn().mockReturnValue([]) } as never,
      dialog: vi.fn(),
      detectedSources: registry,
      id: (() => {
        let value = 0;
        return () => `capability-${String(++value)}`;
      })(),
      now: () => Date.parse('2026-07-19T12:00:00.000Z'),
    });

    const first = controller.listDetectedSources(7);
    const otherWindow = controller.listDetectedSources(8);
    if (!first.ok || !otherWindow.ok) throw new Error('setup');
    expect(first).toEqual({
      ok: true,
      sources: [
        expect.objectContaining({
          id: 'runtime-card-1',
          capabilityId: 'capability-1',
          label: 'CARD',
          online: true,
        }),
      ],
    });
    expect(JSON.stringify(first)).not.toContain('/Volumes/');
    expect(otherWindow.sources[0]?.capabilityId).not.toBe(first.sources[0]?.capabilityId);
    expect(first.sources[0]).not.toHaveProperty('fsType');
    expect(first.sources[0]).not.toHaveProperty('capacityBytes');
    expect(() =>
      (
        controller as unknown as {
          resolveDetectedCapability(id: string, windowId: number): unknown;
        }
      ).resolveDetectedCapability(first.sources[0]?.capabilityId ?? '', 8),
    ).toThrow(/scope/i);
    await controller.close();
  });

  it('projects fsType and capacityBytes when the platform adapter observes them', async () => {
    const cardWithFormat: MountedSourceInfo = {
      ...card,
      platformVolumeId: 'volume-format',
      fsType: 'ExFAT',
      capacityBytes: 64_000_000_000,
    };
    const fake = adapter();
    vi.mocked(fake.value.listMountedSources).mockResolvedValue([cardWithFormat]);
    const registry = new DetectedSourceRegistry(fake.value, { id: () => 'runtime-card-2' });
    await registry.start();
    const controller = new DesktopController({
      service: { close: vi.fn(), findLikelyKnownSourceMatches: vi.fn().mockReturnValue([]) } as never,
      dialog: vi.fn(),
      detectedSources: registry,
    });
    const result = controller.listDetectedSources(7);
    if (!result.ok) throw new Error('setup');
    expect(result.sources[0]).toEqual(
      expect.objectContaining({ fsType: 'ExFAT', capacityBytes: 64_000_000_000 }),
    );
    await controller.close();
  });

  it('rejects a detected source that goes offline between review and start', async () => {
    const fake = adapter();
    const registry = new DetectedSourceRegistry(fake.value, { id: () => 'runtime-card-1' });
    await registry.start();
    const service = {
      review: vi.fn().mockResolvedValue({
        source: { displayName: 'CARD', identity: 'New source', confidence: 'medium' },
        counts: { new: 1, known: 0, ambiguous: 0, recoverable: 0 },
        estimatedBytes: 10,
        destinationPreview: 'Archive/a.jpg',
      }),
      start: vi.fn(),
      close: vi.fn(),
      findLikelyKnownSourceMatches: vi.fn().mockReturnValue([]),
    };
    const controller = new DesktopController({
      service: service as never,
      dialog: vi.fn().mockResolvedValue('/Archive'),
      detectedSources: registry,
      id: (() => {
        let value = 0;
        return () => `id-${String(++value)}`;
      })(),
    });
    const detected = controller.listDetectedSources(7);
    const destination = await controller.chooseFolder(7, 'destination');
    if (!detected.ok || destination.status !== 'selected') throw new Error('setup');
    const review = await controller.review(7, {
      sourceCapabilityId: detected.sources[0]!.capabilityId,
      destinationCapabilityId: destination.capabilityId,
    });
    if (!review.ok) throw new Error('setup');

    await fake.removal()?.(card);
    await expect(controller.start(7, { reviewId: review.value.reviewId })).resolves.toMatchObject({
      ok: false,
      error: { code: 'SOURCE_UNAVAILABLE' },
    });
    expect(service.start).not.toHaveBeenCalled();
    await controller.close();
  });
});

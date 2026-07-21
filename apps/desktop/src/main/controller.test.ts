import { describe, expect, it, vi } from 'vitest';

import type { SessionSnapshot } from '@ingestarr/shared-types';
import { defaultAppSettings } from '@ingestarr/shared-types';

import { DesktopController, type DesktopControllerOptions } from './controller';

const copying: SessionSnapshot = {
  sessionId: 'session-1',
  status: 'copying',
  phase: 'Copying',
  totalFiles: 2,
  completedFiles: 0,
  skippedFiles: 0,
  failedFiles: 0,
  totalBytes: 20,
  completedBytes: 0,
  currentFile: 'a.mov',
  throughputBytesPerSecond: 0,
  errors: [],
  startedAt: '2026-07-19T12:00:00.000Z',
  updatedAt: '2026-07-19T12:00:00.000Z',
};

function setup(
  options: {
    now?: () => number;
    claimTtlMs?: number;
    retryCapabilityTtlMs?: number;
    detectedSources?: DesktopControllerOptions['detectedSources'];
  } = {},
) {
  let complete: ((value: SessionSnapshot) => void) | undefined;
  const service = {
    review: vi.fn().mockResolvedValue({
      source: { displayName: 'CARD', identity: 'New source', confidence: 'medium' },
      counts: { new: 2, known: 0, ambiguous: 0, recoverable: 0 },
      estimatedBytes: 20,
      destinationPreview: 'Archive/2026/2026-07-19/CARD',
    }),
    start: vi.fn(
      async (
        _source: string,
        _destination: string,
        signal: AbortSignal,
        emit: (snapshot: SessionSnapshot) => void,
      ) => {
        emit(copying);
        return {
          sessionId: 'session-1',
          completion: new Promise<SessionSnapshot>((resolve) => {
            complete = resolve;
            signal.addEventListener('abort', () =>
              resolve({ ...copying, status: 'cancelled', phase: 'Cancelled' }),
            );
          }),
        };
      },
    ),
    getSession: vi.fn().mockReturnValue(copying),
    listRecoverableSessions: vi.fn().mockReturnValue([]),
    listKnownSources: vi.fn().mockReturnValue([]),
    setSourceNickname: vi.fn().mockImplementation((_sourceId: string, nickname: string | null) => ({
      nickname,
    })),
    registerDetectedSource: vi
      .fn()
      .mockImplementation(
        (
          detected: { platformVolumeId?: string; label: string; kind: string },
          nickname: string | null,
        ) => ({ sourceId: detected.platformVolumeId ?? `known-${detected.label}`, nickname }),
      ),
    findLikelyKnownSourceMatches: vi.fn().mockReturnValue([]),
    resolveKnownSourceForVolume: vi.fn().mockResolvedValue(undefined),
    countSourceMedia: vi
      .fn()
      .mockResolvedValue({ total: 0, photos: 0, videos: 0, other: 0, bytes: 0, byDay: [] }),
    listSummaryDays: vi.fn().mockReturnValue([]),
    listSummaryMedia: vi.fn().mockReturnValue({ items: [], nextCursor: null }),
    readThumbnail: vi.fn().mockRejectedValue(new Error('missing')),
    retryThumbnail: vi.fn().mockReturnValue(true),
    getSettings: vi.fn().mockReturnValue(defaultAppSettings),
    updateSettings: vi.fn().mockImplementation((settings) => settings),
    validateTemplate: vi.fn().mockReturnValue({
      valid: true,
      preview: '2026/2026-07-19/CARD/IMG_0001.JPG',
      errors: [],
    }),
    recoverSession: vi.fn().mockResolvedValue(copying),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const dialog = vi.fn();
  const controller = new DesktopController({
    dialog,
    service,
    now: options.now ?? (() => Date.parse('2026-07-19T12:00:00.000Z')),
    claimTtlMs: options.claimTtlMs,
    retryCapabilityTtlMs: options.retryCapabilityTtlMs,
    detectedSources: options.detectedSources,
    id: (() => {
      let value = 0;
      return () => `id-${++value}`;
    })(),
  });
  return { controller, dialog, service, complete: () => complete };
}

describe('desktop ingest controller', () => {
  it('returns cancellation without issuing a capability', async () => {
    const { controller, dialog } = setup();
    dialog.mockResolvedValue(undefined);

    await expect(controller.chooseFolder(1, 'source')).resolves.toEqual({ status: 'cancelled' });
  });

  it('reviews only server-held source and destination paths', async () => {
    const { controller, dialog, service } = setup();
    dialog.mockResolvedValueOnce('/private/source').mockResolvedValueOnce('/private/archive');
    const source = await controller.chooseFolder(1, 'source');
    const destination = await controller.chooseFolder(1, 'destination');
    if (source.status !== 'selected' || destination.status !== 'selected') throw new Error('setup');

    const response = await controller.review(1, {
      sourceCapabilityId: source.capabilityId,
      destinationCapabilityId: destination.capabilityId,
    });

    expect(service.review).toHaveBeenCalledWith('/private/source', '/private/archive');
    expect(response).toMatchObject({ ok: true, value: { counts: { new: 2 } } });
  });

  it('updates settings atomically using only a destination capability', async () => {
    const { controller, dialog, service } = setup();
    dialog.mockResolvedValue('/private/archive');
    const destination = await controller.chooseFolder(1, 'destination');
    if (destination.status !== 'selected') throw new Error('setup');

    const response = await controller.updateSettings(1, {
      destinationCapabilityId: destination.capabilityId,
      allowedExtensions: ['.jpg'],
      excludedPathPatterns: ['.Trashes'],
      destinationTemplate: '{YYYY}/{sourceLabelOrCamera}/{originalFilename}',
      copyConcurrency: 2,
      groupByNicknameInDestination: false,
      perCardEventLog: false,
      autoIngest: false,
      thumbnail: {
        width: 640,
        height: 640,
        cachePolicy: 'bounded',
        cacheLimitBytes: 1_000_000,
      },
    });

    expect(service.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationRoot: '/private/archive',
        verifyCopies: true,
        copyConcurrency: 2,
      }),
    );
    // The projected settings intentionally surface the raw destination path (utility-tool style,
    // for advanced users), so the response should now round-trip it rather than hide it.
    expect(JSON.stringify(response)).toContain('/private/archive');
    await expect(
      controller.updateSettings(1, {
        destinationCapabilityId: destination.capabilityId,
        allowedExtensions: ['.jpg'],
        excludedPathPatterns: ['.Trashes'],
        destinationTemplate: '{YYYY}/{sourceLabelOrCamera}/{originalFilename}',
        copyConcurrency: 2,
        groupByNicknameInDestination: false,
        perCardEventLog: false,
        autoIngest: false,
        thumbnail: {
          width: 640,
          height: 640,
          cachePolicy: 'bounded',
          cacheLimitBytes: 1_000_000,
        },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_INVALID' } });
  });

  it('keeps source and destination capabilities usable across repeat reviews', async () => {
    // Regression test: the Review screen's "Choose destination again" control re-runs review()
    // reusing the *same* source capability with a freshly chosen destination. Consuming the
    // source capability the first time review() succeeded made every subsequent re-review fail
    // with "Folder capability is invalid" — confusingly surfaced while picking a *destination*,
    // since it was actually the untouched source token that had already been burned. Review is
    // a repeatable, read-only inspection step; only starting the ingest should be one-shot.
    const { controller, dialog } = setup();
    dialog
      .mockResolvedValueOnce('/private/source')
      .mockResolvedValueOnce('/private/archive')
      .mockResolvedValueOnce('/private/archive-2');
    const source = await controller.chooseFolder(1, 'source');
    const destination = await controller.chooseFolder(1, 'destination');
    if (source.status !== 'selected' || destination.status !== 'selected') throw new Error('setup');
    const request = {
      sourceCapabilityId: source.capabilityId,
      destinationCapabilityId: destination.capabilityId,
    };

    await expect(controller.review(1, request)).resolves.toMatchObject({ ok: true });
    // Repeating the exact same review request (e.g. a duplicated/retried call) must also
    // succeed, not just a request with a fresh destination.
    await expect(controller.review(1, request)).resolves.toMatchObject({ ok: true });

    const secondDestination = await controller.chooseFolder(1, 'destination');
    if (secondDestination.status !== 'selected') throw new Error('setup');
    await expect(
      controller.review(1, {
        sourceCapabilityId: source.capabilityId,
        destinationCapabilityId: secondDestination.capabilityId,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('consumes a review grant after a successful start', async () => {
    const { controller, dialog, service } = setup();
    vi.mocked(service.start).mockResolvedValueOnce({
      sessionId: 'session-1',
      completion: Promise.resolve({ ...copying, status: 'completed', phase: 'Completed' }),
    });
    dialog.mockResolvedValueOnce('/private/source').mockResolvedValueOnce('/private/archive');
    const source = await controller.chooseFolder(1, 'source');
    const destination = await controller.chooseFolder(1, 'destination');
    if (source.status !== 'selected' || destination.status !== 'selected') throw new Error('setup');
    const review = await controller.review(1, {
      sourceCapabilityId: source.capabilityId,
      destinationCapabilityId: destination.capabilityId,
    });
    if (!review.ok) throw new Error('setup');

    await expect(controller.start(1, { reviewId: review.value.reviewId })).resolves.toMatchObject({
      ok: true,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(controller.start(1, { reviewId: review.value.reviewId })).resolves.toMatchObject({
      ok: false,
      error: { code: 'REVIEW_EXPIRED' },
    });
  });

  it('allows one active session per window and cancels it', async () => {
    const { controller, dialog, service } = setup();
    dialog.mockResolvedValueOnce('/private/source').mockResolvedValueOnce('/private/archive');
    const source = await controller.chooseFolder(1, 'source');
    const destination = await controller.chooseFolder(1, 'destination');
    if (source.status !== 'selected' || destination.status !== 'selected') throw new Error('setup');
    const review = await controller.review(1, {
      sourceCapabilityId: source.capabilityId,
      destinationCapabilityId: destination.capabilityId,
    });
    if (!review.ok) throw new Error('setup');

    await expect(controller.start(1, { reviewId: review.value.reviewId })).resolves.toEqual({
      ok: true,
      sessionId: 'session-1',
    });
    await expect(controller.start(1, { reviewId: review.value.reviewId })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INGEST_ACTIVE' },
    });
    await expect(controller.cancel(1, { sessionId: 'session-1' })).resolves.toEqual({ ok: true });
    expect(service.start).toHaveBeenCalledTimes(1);
  });

  it('requires an allowed source decision for uncertain reconciliation', async () => {
    const { controller, dialog, service } = setup();
    vi.mocked(service.review).mockResolvedValueOnce({
      source: {
        displayName: 'CARD',
        identity: 'Known source candidate',
        confidence: 'medium',
        requiresConfirmation: true,
        candidates: [
          {
            sourceId: 'known-1',
            displayName: 'Travel Card',
            confidence: 'medium',
            reasons: ['non-authoritative-fallback-fingerprint-match'],
          },
        ],
      },
      counts: { new: 1, known: 0, ambiguous: 0, recoverable: 0 },
      estimatedBytes: 10,
      destinationPreview: 'Archive/2026/a.jpg',
    });
    dialog.mockResolvedValueOnce('/private/source').mockResolvedValueOnce('/private/archive');
    const source = await controller.chooseFolder(1, 'source');
    const destination = await controller.chooseFolder(1, 'destination');
    if (source.status !== 'selected' || destination.status !== 'selected') throw new Error('setup');
    const review = await controller.review(1, {
      sourceCapabilityId: source.capabilityId,
      destinationCapabilityId: destination.capabilityId,
    });
    if (!review.ok) throw new Error('setup');

    await expect(controller.start(1, { reviewId: review.value.reviewId })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    await expect(
      controller.start(1, {
        reviewId: review.value.reviewId,
        sourceDecision: { action: 'existing', sourceId: 'forged' },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    await expect(
      controller.start(1, {
        reviewId: review.value.reviewId,
        sourceDecision: { action: 'existing', sourceId: 'known-1' },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(service.start).toHaveBeenCalledWith(
      '/private/source',
      '/private/archive',
      expect.any(AbortSignal),
      expect.any(Function),
      undefined,
      { action: 'existing', sourceId: 'known-1' },
      undefined,
    );
  });

  it('passes an explicit create-new reconciliation decision to the service', async () => {
    const { controller, dialog, service } = setup();
    vi.mocked(service.review).mockResolvedValueOnce({
      source: {
        displayName: 'CARD',
        identity: 'Known source candidate',
        confidence: 'medium',
        requiresConfirmation: true,
        candidates: [
          {
            sourceId: 'known-1',
            displayName: 'Travel Card',
            confidence: 'medium',
            reasons: ['non-authoritative-fallback-fingerprint-match'],
          },
        ],
      },
      counts: { new: 1, known: 0, ambiguous: 0, recoverable: 0 },
      estimatedBytes: 10,
      destinationPreview: 'Archive/2026/a.jpg',
    });
    dialog.mockResolvedValueOnce('/private/source').mockResolvedValueOnce('/private/archive');
    const source = await controller.chooseFolder(1, 'source');
    const destination = await controller.chooseFolder(1, 'destination');
    if (source.status !== 'selected' || destination.status !== 'selected') throw new Error('setup');
    const review = await controller.review(1, {
      sourceCapabilityId: source.capabilityId,
      destinationCapabilityId: destination.capabilityId,
    });
    if (!review.ok) throw new Error('setup');

    await controller.start(1, {
      reviewId: review.value.reviewId,
      sourceDecision: { action: 'new' },
    });

    expect(service.start).toHaveBeenCalledWith(
      '/private/source',
      '/private/archive',
      expect.any(AbortSignal),
      expect.any(Function),
      undefined,
      { action: 'new' },
      undefined,
    );
  });

  it('rejects concurrent start requests before service startup completes', async () => {
    const { controller, dialog, service } = setup();
    let release: (() => void) | undefined;
    vi.mocked(service.start).mockImplementationOnce(
      async () =>
        await new Promise<{ sessionId: string; completion: Promise<SessionSnapshot> }>(
          (resolve) => {
            release = () =>
              resolve({
                sessionId: 'session-1',
                completion: new Promise<SessionSnapshot>(() => {}),
              });
          },
        ),
    );
    dialog.mockResolvedValueOnce('/private/source').mockResolvedValueOnce('/private/archive');
    const source = await controller.chooseFolder(1, 'source');
    const destination = await controller.chooseFolder(1, 'destination');
    if (source.status !== 'selected' || destination.status !== 'selected') throw new Error('setup');
    const review = await controller.review(1, {
      sourceCapabilityId: source.capabilityId,
      destinationCapabilityId: destination.capabilityId,
    });
    if (!review.ok) throw new Error('setup');

    const first = controller.start(1, { reviewId: review.value.reviewId });
    const second = controller.start(1, { reviewId: review.value.reviewId });

    await expect(second).resolves.toMatchObject({ ok: false, error: { code: 'INGEST_ACTIVE' } });
    release?.();
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it('unsubscribes progress listeners and clears window resources', async () => {
    const { controller, dialog } = setup();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(1, listener);
    dialog.mockResolvedValueOnce('/private/source').mockResolvedValueOnce('/private/archive');
    const source = await controller.chooseFolder(1, 'source');
    const destination = await controller.chooseFolder(1, 'destination');
    if (source.status !== 'selected' || destination.status !== 'selected') throw new Error('setup');
    const review = await controller.review(1, {
      sourceCapabilityId: source.capabilityId,
      destinationCapabilityId: destination.capabilityId,
    });
    if (!review.ok) throw new Error('setup');
    await controller.start(1, { reviewId: review.value.reviewId });

    expect(listener).toHaveBeenCalledWith(copying);
    unsubscribe();
    controller.destroyWindow(1);
    expect(controller.listenerCount(1)).toBe(0);
  });

  it('scopes durable session lookup to the owning window', async () => {
    const { controller, dialog } = setup();
    dialog.mockResolvedValueOnce('/private/source').mockResolvedValueOnce('/private/archive');
    const source = await controller.chooseFolder(1, 'source');
    const destination = await controller.chooseFolder(1, 'destination');
    if (source.status !== 'selected' || destination.status !== 'selected') throw new Error('setup');
    const review = await controller.review(1, {
      sourceCapabilityId: source.capabilityId,
      destinationCapabilityId: destination.capabilityId,
    });
    if (!review.ok) throw new Error('setup');
    await controller.start(1, { reviewId: review.value.reviewId });

    expect(controller.getSession(1, 'session-1')).toMatchObject({ ok: true });
    expect(controller.getSession(2, 'session-1')).toMatchObject({
      ok: false,
      error: { code: 'SESSION_NOT_FOUND' },
    });
  });

  it('sanitizes persisted path-bearing failures at the projection boundary', async () => {
    const { controller, service, dialog } = setup();
    dialog.mockResolvedValueOnce('/private/source').mockResolvedValueOnce('/private/archive');
    const source = await controller.chooseFolder(1, 'source');
    const destination = await controller.chooseFolder(1, 'destination');
    if (source.status !== 'selected' || destination.status !== 'selected') throw new Error('setup');
    const review = await controller.review(1, {
      sourceCapabilityId: source.capabilityId,
      destinationCapabilityId: destination.capabilityId,
    });
    if (!review.ok) throw new Error('setup');
    await controller.start(1, { reviewId: review.value.reviewId });
    service.getSession.mockReturnValue({
      ...copying,
      status: 'failed',
      phase: 'Failed at /private/source',
      currentFile: '/private/source/secret.mov',
      errors: [
        {
          code: 'SOURCE_UNAVAILABLE',
          message: 'ENOENT /private/source/secret.mov\nstack trace',
          filename: '/private/source/secret.mov',
        },
        {
          code: 'SQLITE_ERROR_/private/db',
          message: 'database stack /private/db',
        },
      ],
    });

    const response = controller.getSession(1, 'session-1');

    expect(response).toEqual({
      ok: true,
      session: expect.objectContaining({
        phase: 'Failed',
        currentFile: 'secret.mov',
        errors: [
          {
            code: 'SOURCE_UNAVAILABLE',
            message: 'The source became unavailable.',
            filename: 'secret.mov',
          },
          {
            code: 'INGEST_FAILED',
            message: 'The ingest could not be completed.',
          },
        ],
      }),
    });
    expect(JSON.stringify(response)).not.toContain('/private');
    expect(JSON.stringify(response)).not.toContain('stack');
  });

  it('aborts and awaits in-flight completion before closing', async () => {
    const { controller, dialog, service } = setup();
    let finish: (() => void) | undefined;
    service.start.mockImplementationOnce(async (_source, _destination, signal) => ({
      sessionId: 'session-1',
      completion: new Promise<SessionSnapshot>((resolve) => {
        signal.addEventListener('abort', () => {
          finish = () => resolve({ ...copying, status: 'cancelled', phase: 'Cancelled' });
        });
      }),
    }));
    dialog.mockResolvedValueOnce('/private/source').mockResolvedValueOnce('/private/archive');
    const source = await controller.chooseFolder(1, 'source');
    const destination = await controller.chooseFolder(1, 'destination');
    if (source.status !== 'selected' || destination.status !== 'selected') throw new Error('setup');
    const review = await controller.review(1, {
      sourceCapabilityId: source.capabilityId,
      destinationCapabilityId: destination.capabilityId,
    });
    if (!review.ok) throw new Error('setup');
    await controller.start(1, { reviewId: review.value.reviewId });

    let closed = false;
    const closing = controller.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(finish).toBeTypeOf('function');
    finish?.();
    await closing;
    await controller.close();
    expect(service.close).toHaveBeenCalledOnce();
  });

  it('discovers and claims a persisted session after controller reconstruction', () => {
    const { controller, service } = setup();
    const persisted = {
      ...copying,
      sessionId: 'persisted-session-secret',
      status: 'failed' as const,
      phase: 'Failed at /private/source',
      errors: [
        {
          code: 'SQLITE_INTERNAL',
          message: 'stack /private/source',
          filename: '/private/source/secret.mov',
        },
      ],
    };
    service.listRecoverableSessions.mockReturnValue([persisted]);
    service.getSession.mockImplementation((sessionId) =>
      sessionId === persisted.sessionId ? persisted : undefined,
    );

    const discovered = controller.listRecoverableSessions(7);
    expect(discovered).toMatchObject({
      ok: true,
      sessions: [
        {
          status: 'failed',
          error: {
            code: 'INGEST_FAILED',
            message: 'The ingest could not be completed.',
          },
        },
      ],
    });
    expect(JSON.stringify(discovered)).not.toContain('persisted-session-secret');
    expect(JSON.stringify(discovered)).not.toContain('/private');
    if (!discovered.ok) throw new Error('setup');

    expect(controller.getSession(7, 'persisted-session-secret')).toMatchObject({ ok: false });
    const claimed = controller.claimSession(7, {
      claimCapabilityId: discovered.sessions[0]!.claimCapabilityId,
    });
    expect(claimed).toMatchObject({
      ok: true,
      session: { sessionId: 'persisted-session-secret', status: 'failed' },
    });
    expect(controller.getSession(7, 'persisted-session-secret')).toMatchObject({ ok: true });
  });

  it('rejects claim expiry, replay, and cross-window use', () => {
    let now = Date.parse('2026-07-19T12:00:00.000Z');
    const { controller, service } = setup({ now: () => now, claimTtlMs: 100 });
    service.listRecoverableSessions.mockReturnValue([
      { ...copying, sessionId: 'persisted-session', status: 'failed', phase: 'Failed' },
      { ...copying, sessionId: 'persisted-session-2', status: 'cancelled', phase: 'Cancelled' },
    ]);
    const first = controller.listRecoverableSessions(1);
    if (!first.ok) throw new Error('setup');
    const claimCapabilityId = first.sessions[0]!.claimCapabilityId;

    expect(controller.claimSession(2, { claimCapabilityId })).toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_INVALID' },
    });
    expect(controller.claimSession(1, { claimCapabilityId })).toMatchObject({ ok: true });
    expect(controller.claimSession(1, { claimCapabilityId })).toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_INVALID' },
    });

    const second = controller.listRecoverableSessions(3);
    if (!second.ok) throw new Error('setup');
    now += 101;
    expect(
      controller.claimSession(3, {
        claimCapabilityId: second.sessions[0]!.claimCapabilityId,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_EXPIRED' },
    });
  });

  it('authorizes failed-thumbnail retries with expiring single-use window capabilities', () => {
    let now = Date.parse('2026-07-19T12:00:00.000Z');
    const { controller, service } = setup({
      now: () => now,
      retryCapabilityTtlMs: 100,
    });
    service.listSummaryMedia.mockReturnValue({
      items: [
        {
          id: 'file',
          copyId: 'raw-copy-id',
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
            nextRetryAt: null,
            maxAttempts: 3,
          },
        },
      ],
      nextCursor: null,
    });
    const request = { captureDay: '2026-07-19', limit: 10 };
    const listed = controller.listSummaryMedia(4, request);
    if (!listed.ok || listed.items[0]?.thumbnail.state !== 'failed') throw new Error('setup');
    const capability = listed.items[0].thumbnail.retryCapability.token;

    expect(controller.retryThumbnail(4, { copyId: 'raw-copy-id' } as never)).toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_INVALID' },
    });
    expect(controller.retryThumbnail(5, { capability })).toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_INVALID' },
    });
    expect(controller.retryThumbnail(4, { capability })).toEqual({ ok: true });
    expect(service.retryThumbnail).toHaveBeenCalledWith('raw-copy-id', 'grid');
    expect(controller.retryThumbnail(4, { capability })).toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_INVALID' },
    });

    const expiring = controller.listSummaryMedia(4, request);
    if (!expiring.ok || expiring.items[0]?.thumbnail.state !== 'failed') throw new Error('setup');
    now += 101;
    expect(
      controller.retryThumbnail(4, {
        capability: expiring.items[0].thumbnail.retryCapability.token,
      }),
    ).toMatchObject({ ok: false, error: { code: 'CAPABILITY_EXPIRED' } });
  });

  it('lets a ready thumbnail be read more than once with the same token before it expires', async () => {
    // Regression test: reading a thumbnail is idempotent, and React StrictMode double-invokes
    // mount effects in development, which can race two reads of the same freshly-issued token
    // before either completes. A single-use token previously made the second read (or the
    // first, if it resolved after the component's `active` flag flipped) fail outright, leaving
    // the thumbnail stuck on "Loading thumbnail…" forever.
    let now = Date.parse('2026-07-19T12:00:00.000Z');
    const { controller, service } = setup({ now: () => now });
    service.listSummaryMedia.mockReturnValue({
      items: [
        {
          id: 'file',
          copyId: 'raw-copy-id',
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
            state: 'ready',
            reference: 'thumbnail-reference',
            mimeType: 'image/webp',
            width: 480,
            height: 320,
          },
        },
      ],
      nextCursor: null,
    });
    service.readThumbnail.mockResolvedValue({
      mimeType: 'image/webp',
      bytes: new Uint8Array([1, 2, 3]),
    });
    const request = { captureDay: '2026-07-19', limit: 10 };
    const listed = controller.listSummaryMedia(4, request);
    if (!listed.ok || listed.items[0]?.thumbnail.state !== 'ready') throw new Error('setup');
    const token = listed.items[0].thumbnail.token;

    const [first, second] = await Promise.all([
      controller.getThumbnail(4, token),
      controller.getThumbnail(4, token),
    ]);
    expect(first).toMatchObject({ ok: true, mimeType: 'image/webp' });
    expect(second).toMatchObject({ ok: true, mimeType: 'image/webp' });

    now += 60_001;
    expect(await controller.getThumbnail(4, token)).toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_INVALID' },
    });
  });

  it('registers (names) a detected card and re-resolves its identity, with no confirmation prompt', async () => {
    const refreshIdentity = vi.fn().mockResolvedValue(undefined);
    const detectedSources = {
      list: () => [
        {
          id: 'detected-1',
          label: 'BIG',
          kind: 'removable-volume' as const,
          online: true,
          canonicalMountPath: '/Volumes/BIG',
          platformVolumeId: 'volume-xyz',
          facts: {} as never,
        },
      ],
      subscribe: () => () => undefined,
      refreshIdentity,
    } as unknown as DesktopControllerOptions['detectedSources'];
    const { controller, service } = setup({ detectedSources });
    service.registerDetectedSource.mockResolvedValueOnce({
      sourceId: 'source-big',
      nickname: 'canon-r5',
    });

    const response = await controller.registerDetectedSource(1, {
      detectedSourceId: 'detected-1',
      nickname: 'canon-r5',
    });

    expect(service.registerDetectedSource).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'BIG',
        platformVolumeId: 'volume-xyz',
        mountPath: '/Volumes/BIG',
      }),
      'canon-r5',
    );
    expect(refreshIdentity).toHaveBeenCalledWith('detected-1');
    expect(response).toEqual({ ok: true, sourceId: 'source-big', nickname: 'canon-r5' });
  });

  it('auto-ingests a hotplugged card when automatic mode is enabled', async () => {
    let arrival: ((source: unknown) => void) | undefined;
    const card = {
      id: 'detected-1',
      label: 'CARD',
      kind: 'removable-volume' as const,
      online: true,
      canonicalMountPath: '/Volumes/CARD',
      facts: {} as never,
    };
    const detectedSources = {
      list: () => [card],
      subscribe: () => () => undefined,
      onArrival: (listener: (source: unknown) => void) => {
        arrival = listener;
        return () => undefined;
      },
    } as unknown as DesktopControllerOptions['detectedSources'];
    const { controller, service } = setup({ detectedSources });
    service.getSettings.mockReturnValue({
      ...defaultAppSettings,
      destinationRoot: '/archive',
      autoIngest: true,
    });

    arrival?.(card);
    await vi.waitFor(() => expect(service.start).toHaveBeenCalledTimes(1));
    expect(service.start).toHaveBeenCalledWith(
      '/Volumes/CARD',
      '/archive',
      expect.any(AbortSignal),
      expect.any(Function),
      expect.anything(),
    );
    await controller.close();
  });

  it('does not auto-ingest when automatic mode is off or no destination is set', async () => {
    let arrival: ((source: unknown) => void) | undefined;
    const card = {
      id: 'detected-1',
      label: 'CARD',
      kind: 'removable-volume' as const,
      online: true,
      canonicalMountPath: '/Volumes/CARD',
      facts: {} as never,
    };
    const detectedSources = {
      list: () => [card],
      subscribe: () => () => undefined,
      onArrival: (listener: (source: unknown) => void) => {
        arrival = listener;
        return () => undefined;
      },
    } as unknown as DesktopControllerOptions['detectedSources'];
    const { controller, service } = setup({ detectedSources });
    // Auto-ingest on but no destination configured → must stay hands-off.
    service.getSettings.mockReturnValue({
      ...defaultAppSettings,
      destinationRoot: null,
      autoIngest: true,
    });

    arrival?.(card);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.start).not.toHaveBeenCalled();
    await controller.close();
  });
});

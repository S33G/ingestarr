import { describe, expect, it, vi } from 'vitest';

import { createDesktopApi } from './api';

describe('preload renderer API', () => {
  it('exposes only the exact typed ingest methods', () => {
    const api = createDesktopApi(vi.fn(), vi.fn(), vi.fn());

    expect(Object.keys(api)).toEqual([
      'health',
      'chooseSourceFolder',
      'chooseDestinationFolder',
      'listDetectedSources',
      'listKnownSources',
      'setSourceNickname',
      'registerSource',
      'countSourceMedia',
      'getSettings',
      'updateSettings',
      'resetDestinationToDefault',
      'validateTemplate',
      'review',
      'start',
      'cancel',
      'listRecoverableSessions',
      'claimSession',
      'recoverSession',
      'getSession',
      'listSummaryDays',
      'listSummaryMediaByDay',
      'getThumbnail',
      'retryThumbnail',
      'copyText',
      'onProgress',
      'onSummaryInvalidated',
      'onDetectedSourcesChanged',
    ]);
  });

  it('validates clipboard text before invoking the narrow system channel', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const api = createDesktopApi(invoke, vi.fn(), vi.fn());

    await expect(api.copyText('full-raw-value')).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith('system:copyText', { text: 'full-raw-value' });
    await expect(api.copyText('')).rejects.toThrow();
    await expect(api.copyText('x'.repeat(8193))).rejects.toThrow();
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('uses the health channel and validates its response', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'ok',
        version: '0.0.0',
        checkedAt: '2026-07-19T12:00:00.000Z',
      })
      .mockResolvedValueOnce({ ok: true });

    await expect(createDesktopApi(invoke, vi.fn(), vi.fn()).health()).resolves.toMatchObject({
      status: 'ok',
    });
    expect(invoke.mock.calls).toEqual([
      ['health', {}],
      ['health:validated', { checkedAt: '2026-07-19T12:00:00.000Z' }],
    ]);
  });

  it('rejects malformed health responses', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 'maybe' });

    await expect(createDesktopApi(invoke, vi.fn(), vi.fn()).health()).rejects.toThrow();
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('validates requests before invoking privileged channels', async () => {
    const invoke = vi.fn();
    const api = createDesktopApi(invoke, vi.fn(), vi.fn());

    await expect(
      api.review({
        sourceCapabilityId: 'source',
        destinationCapabilityId: 'destination',
        sourcePath: '/forged',
      } as never),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('subscribes without exposing Electron events and cleans up exactly once', () => {
    const on = vi.fn();
    const remove = vi.fn();
    const listener = vi.fn();
    const api = createDesktopApi(vi.fn(), on, remove);
    const unsubscribe = api.onProgress(listener);
    const wrapped = on.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void;

    wrapped(
      { sender: 'electron-event' },
      {
        windowId: 1,
        session: {
          sessionId: 'session-1',
          status: 'copying',
          phase: 'Copying',
          totalFiles: 1,
          completedFiles: 0,
          skippedFiles: 0,
          failedFiles: 0,
          totalBytes: 10,
          completedBytes: 0,
          throughputBytesPerSecond: 0,
          errors: [],
          startedAt: '2026-07-19T12:00:00.000Z',
          updatedAt: '2026-07-19T12:00:00.000Z',
        },
      },
    );
    unsubscribe();
    unsubscribe();

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }));
    expect(listener.mock.calls[0]?.[0]).not.toHaveProperty('sender');
    expect(remove).toHaveBeenCalledOnce();
  });

  it('validates detected-source events and removes device listeners', () => {
    const on = vi.fn();
    const remove = vi.fn();
    const listener = vi.fn();
    const api = createDesktopApi(vi.fn(), on, remove);
    const unsubscribe = api.onDetectedSourcesChanged(listener);
    const wrapped = on.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void;

    wrapped({}, { windowId: 1 });
    expect(listener).toHaveBeenCalledOnce();
    expect(() => wrapped({}, { windowId: 'forged' })).toThrow();
    unsubscribe();
    unsubscribe();
    expect(remove).toHaveBeenCalledOnce();
  });
});

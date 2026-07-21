import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ipcChannels } from '@ingestarr/shared-types';

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  return {
    handlers,
    app: { getVersion: vi.fn(() => '0.0.0') },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (event: unknown, payload: unknown) => unknown) =>
        handlers.set(channel, handler),
      ),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    },
    clipboard: { writeText: vi.fn() },
    BrowserWindow: {
      fromWebContents: vi.fn((sender: { owner?: unknown }) => sender.owner ?? null),
    },
  };
});

vi.mock('electron', () => electron);

import {
  createFolderDialog,
  bindWindowProgress,
  registerIpcHandlers,
  removeIpcHandlers,
} from './ipc';

function frame(url = 'file:///app/index.html') {
  const value = { url, top: undefined as unknown };
  value.top = value;
  return value;
}

function windowFixture(id: number) {
  const listeners = new Map<string, () => void>();
  const window = {
    id,
    destroyed: false,
    isDestroyed: vi.fn(() => window.destroyed),
    once: vi.fn((name: string, listener: () => void) => listeners.set(name, listener)),
    webContents: {
      id: id * 10,
      send: vi.fn(),
    },
  };
  return { window, listeners };
}

function eventFor(
  window: ReturnType<typeof windowFixture>['window'],
  url = 'file:///app/index.html',
) {
  return {
    sender: { id: window.webContents.id, owner: window },
    senderFrame: frame(url),
  };
}

function controller() {
  const value = {
    chooseFolder: vi.fn().mockResolvedValue({ status: 'cancelled' }),
    review: vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The operation could not be completed.',
        retryable: true,
      },
    }),
    start: vi.fn(),
    cancel: vi.fn(),
    listRecoverableSessions: vi.fn().mockReturnValue({ ok: true, sessions: [] }),
    claimSession: vi.fn().mockReturnValue({
      ok: false,
      error: {
        code: 'CAPABILITY_INVALID',
        message: 'Session claim capability is invalid.',
        retryable: false,
      },
    }),
    getSession: vi.fn().mockReturnValue({
      ok: false,
      error: {
        code: 'SESSION_NOT_FOUND',
        message: 'The ingest session was not found.',
        retryable: false,
      },
    }),
    retryThumbnail: vi.fn().mockReturnValue({ ok: true }),
    subscribe: vi.fn((_windowId: number, listener: (session: unknown) => void) => {
      value.progress = listener;
      return value.unsubscribe;
    }),
    destroyWindow: vi.fn(),
    progress: undefined as ((session: unknown) => void) | undefined,
    unsubscribe: vi.fn(),
  };
  return value;
}

beforeEach(() => {
  electron.handlers.clear();
  vi.clearAllMocks();
});

describe('registered Electron IPC handlers', () => {
  it('copies only validated text from an authorized renderer', async () => {
    registerIpcHandlers(controller() as never, 'file:///app/index.html');
    const { window } = windowFixture(1);
    const handler = electron.handlers.get(ipcChannels.copyText);
    if (handler === undefined) throw new Error('handler missing');

    await expect(
      handler(eventFor(window, 'https://attacker.invalid'), { text: 'session-1' }),
    ).rejects.toThrow(/unauthorized/i);
    await expect(handler(eventFor(window), { text: '' })).rejects.toThrow(/invalid/i);
    await expect(handler(eventFor(window), { text: 'x'.repeat(8193) })).rejects.toThrow(/invalid/i);
    await expect(handler(eventFor(window), { text: 'session-1' })).resolves.toEqual({ ok: true });
    expect(electron.clipboard.writeText).toHaveBeenCalledWith('session-1');
  });

  it('signals smoke readiness only after an authorized validated health request', async () => {
    const value = controller();
    const onHealth = vi.fn(async () => undefined);
    registerIpcHandlers(value as never, 'file:///app/index.html', { onHealth });
    const { window } = windowFixture(2);
    const handler = electron.handlers.get(ipcChannels.health);
    const validated = electron.handlers.get(ipcChannels.healthValidated);
    if (handler === undefined || validated === undefined) throw new Error('handler missing');

    await expect(handler(eventFor(window, 'https://attacker.invalid'), {})).rejects.toThrow(
      /unauthorized/i,
    );
    expect(onHealth).not.toHaveBeenCalled();
    await expect(handler(eventFor(window), { forged: true })).rejects.toThrow(/invalid/i);
    expect(onHealth).not.toHaveBeenCalled();

    const health = await handler(eventFor(window), {});
    expect(health).toMatchObject({
      status: 'ok',
      version: '0.0.0',
    });
    expect(onHealth).not.toHaveBeenCalled();
    await expect(
      validated(eventFor(window), { checkedAt: '2026-07-19T00:00:00.000Z' }),
    ).rejects.toThrow(/health validation/i);
    expect(onHealth).not.toHaveBeenCalled();
    await expect(
      validated(eventFor(window), { checkedAt: (health as { checkedAt: string }).checkedAt }),
    ).resolves.toEqual({ ok: true });
    expect(onHealth).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ status: 'ok', version: '0.0.0' }),
    );
  });

  it('supports overlapping health checks for the same window without clobbering each other', async () => {
    // React StrictMode (and window reloads) can fire two `health()` calls for the same window in
    // quick succession, each pairing a `health` request with its own `healthValidated` handshake.
    // A single "last health response wins" slot would make the first handshake fail with
    // "Invalid health validation handshake" purely due to timing, not an actual security issue.
    const value = controller();
    registerIpcHandlers(value as never, 'file:///app/index.html');
    const { window } = windowFixture(3);
    const handler = electron.handlers.get(ipcChannels.health);
    const validated = electron.handlers.get(ipcChannels.healthValidated);
    if (handler === undefined || validated === undefined) throw new Error('handler missing');

    const firstHealth = (await handler(eventFor(window), {})) as { checkedAt: string };
    const secondHealth = (await handler(eventFor(window), {})) as { checkedAt: string };

    await expect(
      validated(eventFor(window), { checkedAt: firstHealth.checkedAt }),
    ).resolves.toEqual({ ok: true });
    await expect(
      validated(eventFor(window), { checkedAt: secondHealth.checkedAt }),
    ).resolves.toEqual({ ok: true });
  });

  it('authorizes sender and top frame before privileged controller actions', async () => {
    const value = controller();
    registerIpcHandlers(value as never, 'file:///app/index.html');
    const { window } = windowFixture(1);
    const handler = electron.handlers.get(ipcChannels.reviewIngest);
    if (handler === undefined) throw new Error('handler missing');

    await expect(
      handler(eventFor(window, 'https://attacker.invalid'), {
        sourceCapabilityId: 'source',
        destinationCapabilityId: 'destination',
      }),
    ).rejects.toThrow(/unauthorized/i);
    const wrongSender = eventFor(window);
    wrongSender.sender.id = 999;
    await expect(
      handler(wrongSender, {
        sourceCapabilityId: 'source',
        destinationCapabilityId: 'destination',
      }),
    ).rejects.toThrow(/unauthorized/i);
    const childFrame = eventFor(window);
    childFrame.senderFrame.top = frame();
    await expect(
      handler(childFrame, {
        sourceCapabilityId: 'source',
        destinationCapabilityId: 'destination',
      }),
    ).rejects.toThrow(/unauthorized/i);
    expect(value.review).not.toHaveBeenCalled();
  });

  it('strictly rejects malformed payloads before side effects', async () => {
    const value = controller();
    registerIpcHandlers(value as never, 'file:///app/index.html');
    const { window } = windowFixture(1);
    const handler = electron.handlers.get(ipcChannels.startIngest);
    if (handler === undefined) throw new Error('handler missing');

    await expect(
      handler(eventFor(window), { reviewId: 'review-1', sourcePath: '/forged' }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message: 'The request was invalid.',
        retryable: false,
      },
    });
    expect(value.start).not.toHaveBeenCalled();
  });

  it('passes the authorized window scope to session lookup and returns safe typed errors', async () => {
    const value = controller();
    registerIpcHandlers(value as never, 'file:///app/index.html');
    const { window } = windowFixture(7);
    const handler = electron.handlers.get(ipcChannels.getSession);
    if (handler === undefined) throw new Error('handler missing');

    expect(handler(eventFor(window), { sessionId: 'session-other-window' })).toEqual({
      ok: false,
      error: {
        code: 'SESSION_NOT_FOUND',
        message: 'The ingest session was not found.',
        retryable: false,
      },
    });
    expect(value.getSession).toHaveBeenCalledWith(7, 'session-other-window');
  });

  it('scopes explicit thumbnail retries to an authorized window and strict payload', () => {
    const value = controller();
    registerIpcHandlers(value as never, 'file:///app/index.html');
    const { window } = windowFixture(3);
    const handler = electron.handlers.get(ipcChannels.retryThumbnail);
    if (handler === undefined) throw new Error('handler missing');

    expect(handler(eventFor(window), { capability: 'opaque-retry' })).toEqual({ ok: true });
    expect(value.retryThumbnail).toHaveBeenCalledWith(3, { capability: 'opaque-retry' });
    expect(handler(eventFor(window), { copyId: 'copy-1' })).toEqual({
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message: 'The request was invalid.',
        retryable: false,
      },
    });
  });

  it('authorizes and validates recoverable-session discovery and claims', async () => {
    const value = controller();
    registerIpcHandlers(value as never, 'file:///app/index.html');
    const { window } = windowFixture(7);
    const list = electron.handlers.get(ipcChannels.listRecoverableSessions);
    const claim = electron.handlers.get(ipcChannels.claimSession);
    if (list === undefined || claim === undefined) throw new Error('handler missing');

    expect(list(eventFor(window), {})).toEqual({ ok: true, sessions: [] });
    expect(value.listRecoverableSessions).toHaveBeenCalledWith(7);
    expect(
      claim(eventFor(window), {
        claimCapabilityId: 'claim-1',
        sessionId: 'forged-session',
      }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(value.claimSession).not.toHaveBeenCalled();
    expect(() =>
      claim(eventFor(window, 'https://attacker.invalid'), {
        claimCapabilityId: 'claim-1',
      }),
    ).toThrow(/unauthorized/i);
    expect(value.claimSession).not.toHaveBeenCalled();
  });

  it('scopes progress to one window and cleans up subscriptions', () => {
    const value = controller();
    const { window, listeners } = windowFixture(3);
    bindWindowProgress(window as never, value as never);
    const session = {
      sessionId: 'session-1',
      status: 'failed',
      phase: 'Failed',
      totalFiles: 0,
      completedFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      totalBytes: 0,
      completedBytes: 0,
      throughputBytesPerSecond: 0,
      errors: [],
      startedAt: '2026-07-19T12:00:00.000Z',
      updatedAt: '2026-07-19T12:00:00.000Z',
    };

    value.progress?.(session);
    expect(window.webContents.send).toHaveBeenCalledWith(
      ipcChannels.sessionProgress,
      expect.objectContaining({ windowId: 3, session }),
    );
    listeners.get('closed')?.();
    expect(value.unsubscribe).toHaveBeenCalledOnce();
    expect(value.destroyWindow).toHaveBeenCalledWith(3);
  });

  it('uses source/destination dialog options and projects cancellation', async () => {
    const showOpenDialog = vi
      .fn()
      .mockResolvedValueOnce({ canceled: true, filePaths: [] })
      .mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/archive'],
      });
    const { window } = windowFixture(4);
    const lookup = vi.fn(() => window);
    const choose = createFolderDialog({ showOpenDialog } as never, lookup as never);

    await expect(choose(4, 'source')).resolves.toBeUndefined();
    await expect(choose(4, 'destination')).resolves.toBe('/archive');
    expect(showOpenDialog).toHaveBeenNthCalledWith(
      1,
      window,
      expect.objectContaining({ properties: ['openDirectory'] }),
    );
    expect(showOpenDialog).toHaveBeenNthCalledWith(
      2,
      window,
      expect.objectContaining({ properties: ['openDirectory', 'createDirectory'] }),
    );
  });

  it('removes every registered handler', () => {
    registerIpcHandlers(controller() as never, 'file:///app/index.html');
    removeIpcHandlers();
    expect(electron.handlers.size).toBe(0);
  });
});

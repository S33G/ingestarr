import { describe, expect, it } from 'vitest';

import { CapabilityStore, authorizeIpcSender } from './security';

describe('privileged IPC security', () => {
  it('scopes capabilities to a window, kind, and expiry', () => {
    let now = 1_000;
    const capabilities = new CapabilityStore({ now: () => now, ttlMs: 100 });
    const selected = capabilities.issue({
      windowId: 7,
      kind: 'source',
      path: '/private/source',
      label: 'source',
    });

    expect(capabilities.resolve(selected.id, 7, 'source')).toMatchObject({
      path: '/private/source',
    });
    expect(() => capabilities.resolve(selected.id, 8, 'source')).toThrow(/scope/i);
    expect(() => capabilities.resolve(selected.id, 7, 'destination')).toThrow(/scope/i);

    now = 1_101;
    expect(() => capabilities.resolve(selected.id, 7, 'source')).toThrow(/expired/i);
  });

  it('revokes all capabilities when a window closes', () => {
    const capabilities = new CapabilityStore();
    const selected = capabilities.issue({
      windowId: 7,
      kind: 'destination',
      path: '/private/archive',
      label: 'archive',
    });

    capabilities.revokeWindow(7);

    expect(() => capabilities.resolve(selected.id, 7, 'destination')).toThrow(/invalid/i);
  });

  it('atomically consumes a mutating capability exactly once', () => {
    const capabilities = new CapabilityStore();
    const selected = capabilities.issue({
      windowId: 7,
      kind: 'destination',
      path: '/private/archive',
      label: 'archive',
    });

    expect(capabilities.consume(selected.id, 7, 'destination')).toMatchObject({
      path: '/private/archive',
    });
    expect(() => capabilities.consume(selected.id, 7, 'destination')).toThrow(/invalid/i);
  });

  it('authorizes only the expected top-level app renderer frame', () => {
    const topFrame = { url: 'file:///app/renderer/index.html' } as {
      url: string;
      top?: unknown;
    };
    topFrame.top = topFrame;
    expect(() =>
      authorizeIpcSender(
        { sender: { id: 42 }, senderFrame: topFrame },
        { webContentsId: 42, rendererUrl: topFrame.url },
      ),
    ).not.toThrow();

    expect(() =>
      authorizeIpcSender(
        {
          sender: { id: 42 },
          senderFrame: { url: 'https://attacker.invalid', top: topFrame },
        },
        { webContentsId: 42, rendererUrl: topFrame.url },
      ),
    ).toThrow(/unauthorized/i);
    expect(() =>
      authorizeIpcSender(
        { sender: { id: 99 }, senderFrame: topFrame },
        { webContentsId: 42, rendererUrl: topFrame.url },
      ),
    ).toThrow(/unauthorized/i);
  });

  it('authorizes the Vite dev server origin despite trailing-slash normalization', () => {
    // Electron-Forge's Vite plugin injects the dev server URL without a trailing
    // slash (e.g. `http://localhost:5173`), but once that root URL is actually
    // loaded, the browser normalizes `senderFrame.url` to include the trailing
    // slash (`http://localhost:5173/`). A naive strict string comparison would
    // reject every legitimate dev-mode IPC call.
    const devFrame = { url: 'http://localhost:5173/' } as { url: string; top?: unknown };
    devFrame.top = devFrame;

    expect(() =>
      authorizeIpcSender(
        { sender: { id: 42 }, senderFrame: devFrame },
        { webContentsId: 42, rendererUrl: 'http://localhost:5173' },
      ),
    ).not.toThrow();
  });

  it('still rejects a different origin/port from the expected dev server URL', () => {
    const attackerFrame = { url: 'http://localhost:9999/' } as { url: string; top?: unknown };
    attackerFrame.top = attackerFrame;

    expect(() =>
      authorizeIpcSender(
        { sender: { id: 42 }, senderFrame: attackerFrame },
        { webContentsId: 42, rendererUrl: 'http://localhost:5173' },
      ),
    ).toThrow(/unauthorized/i);
  });

  it('rejects when the frame or expected URL cannot be parsed', () => {
    const malformedFrame = { url: 'not a url' } as { url: string; top?: unknown };
    malformedFrame.top = malformedFrame;

    expect(() =>
      authorizeIpcSender(
        { sender: { id: 42 }, senderFrame: malformedFrame },
        { webContentsId: 42, rendererUrl: 'http://localhost:5173' },
      ),
    ).toThrow(/unauthorized/i);
  });
});

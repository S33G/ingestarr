import { describe, expect, it, vi } from 'vitest';

import { createBeforeQuitHandler } from './shutdown';

describe('Electron orderly shutdown', () => {
  it('prevents quit re-entry until one async shutdown completes', async () => {
    let release: (() => void) | undefined;
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const quit = vi.fn();
    const handler = createBeforeQuitHandler({ shutdown, quit });
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };

    handler(first);
    handler(second);

    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
    release?.();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());

    const final = { preventDefault: vi.fn() };
    handler(final);
    expect(final.preventDefault).not.toHaveBeenCalled();
  });
});

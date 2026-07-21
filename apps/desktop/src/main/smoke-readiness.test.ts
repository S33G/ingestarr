import { describe, expect, it, vi } from 'vitest';

import { createSmokeReadiness } from './smoke-readiness';

describe('packaged smoke readiness', () => {
  it('does not pass for main startup or page load without a validated health handshake', async () => {
    const write = vi.fn(async () => undefined);
    const exit = vi.fn();
    const readiness = createSmokeReadiness({
      readyFile: '/tmp/ready.json',
      write,
      exit,
    });

    expect(write).not.toHaveBeenCalled();
    readiness.markLoaded(4);
    expect(write).not.toHaveBeenCalled();
    await expect(
      readiness.complete(5, {
        status: 'ok',
        version: '0.0.0',
        checkedAt: '2026-07-19T12:00:00.000Z',
      }),
    ).rejects.toThrow(/loaded renderer/i);
    expect(write).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('writes readiness and exits only after the loaded renderer health handshake', async () => {
    const write = vi.fn(async () => undefined);
    const exit = vi.fn();
    const readiness = createSmokeReadiness({
      readyFile: '/tmp/ready.json',
      write,
      exit,
    });
    readiness.markLoaded(4);

    await readiness.complete(4, {
      status: 'ok',
      version: '0.0.0',
      checkedAt: '2026-07-19T12:00:00.000Z',
    });

    expect(write).toHaveBeenCalledWith(
      '/tmp/ready.json',
      JSON.stringify({ status: 'ready', version: '0.0.0' }),
      { encoding: 'utf8', mode: 0o600 },
    );
    expect(exit).toHaveBeenCalledWith(0);
    await readiness.complete(4, {
      status: 'ok',
      version: '0.0.0',
      checkedAt: '2026-07-19T12:00:01.000Z',
    });
    expect(write).toHaveBeenCalledOnce();
  });
});

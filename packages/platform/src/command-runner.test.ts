import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  CommandAbortedError,
  CommandOutputLimitError,
  CommandTimeoutError,
  NodeCommandRunner,
  type SpawnLike,
  type TreeKillSpawnLike,
} from './command-runner.js';

function fakeSpawn(
  execute: (
    child: EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    },
  ) => void,
) {
  const spawn: SpawnLike = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    queueMicrotask(() => execute(child));
    return child;
  });
  return spawn;
}

describe('NodeCommandRunner', () => {
  it('spawns an exact executable/argument array with shell disabled and locale-stable environment', async () => {
    const spawn = fakeSpawn((child) => {
      child.stdout.emit('data', Buffer.from('ok'));
      child.emit('close', 0, null);
    });
    const runner = new NodeCommandRunner({ spawn });
    await expect(
      runner.run('/usr/bin/tool', ['--path', 'space;$(bad)'], { shell: false }),
    ).resolves.toMatchObject({ stdout: 'ok', exitCode: 0 });
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/tool',
      ['--path', 'space;$(bad)'],
      expect.objectContaining({
        shell: false,
        env: expect.objectContaining({ LC_ALL: 'C', LANG: 'C' }),
      }),
    );
  });

  it('returns stable typed timeout, abort, and output-limit failures', async () => {
    vi.useFakeTimers();
    const timeoutRunner = new NodeCommandRunner({ spawn: fakeSpawn(() => undefined) });
    const timeout = timeoutRunner.run('tool', [], { shell: false, timeoutMs: 5 });
    const timeoutExpectation = expect(timeout).rejects.toBeInstanceOf(CommandTimeoutError);
    await vi.advanceTimersByTimeAsync(5);
    await timeoutExpectation;

    const controller = new AbortController();
    const abortRunner = new NodeCommandRunner({ spawn: fakeSpawn(() => undefined) });
    const aborted = abortRunner.run('tool', [], { shell: false, signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toBeInstanceOf(CommandAbortedError);
    vi.useRealTimers();

    const limitRunner = new NodeCommandRunner({
      spawn: fakeSpawn((child) => child.stdout.emit('data', Buffer.from('too large'))),
    });
    await expect(
      limitRunner.run('tool', [], { shell: false, maxStdoutBytes: 2 }),
    ).rejects.toBeInstanceOf(CommandOutputLimitError);
  });

  it('detaches output listeners and remains bounded when output continues after the limit', async () => {
    let stdoutListeners = -1;
    let stderrListeners = -1;
    const killTree = vi.fn();
    const runner = new NodeCommandRunner({
      killTree,
      spawn: fakeSpawn((child) => {
        child.stdout.emit('data', Buffer.alloc(3));
        stdoutListeners = child.stdout.listenerCount('data');
        stderrListeners = child.stderr.listenerCount('data');
        for (let index = 0; index < 10_000; index += 1) {
          child.stdout.emit('data', Buffer.alloc(1024));
          child.stderr.emit('data', Buffer.alloc(1024));
        }
        child.emit('close', 0, null);
      }),
    });

    await expect(
      runner.run('tool', [], {
        shell: false,
        maxStdoutBytes: 2,
        maxStderrBytes: 2,
      }),
    ).rejects.toBeInstanceOf(CommandOutputLimitError);
    expect(stdoutListeners).toBe(0);
    expect(stderrListeners).toBe(0);
    expect(killTree).toHaveBeenCalledOnce();
  });

  it.each(['nonzero', 'error'] as const)(
    'awaits Windows taskkill %s and falls back before rejecting abort',
    async (failure) => {
      const target = Object.assign(new EventEmitter(), {
        pid: 456,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      const taskkill = Object.assign(new EventEmitter(), { kill: vi.fn() });
      const treeKillSpawn: TreeKillSpawnLike = vi.fn(() => taskkill);
      const runner = new NodeCommandRunner({
        platform: 'win32',
        spawn: vi.fn(() => target),
        treeKillSpawn,
        terminationTimeoutMs: 20,
      });
      const controller = new AbortController();
      const result = runner.run('tool.exe', [], { shell: false, signal: controller.signal });
      let settled = false;
      void result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const expectation = expect(result).rejects.toBeInstanceOf(CommandAbortedError);

      controller.abort();
      await Promise.resolve();
      expect(settled).toBe(false);
      if (failure === 'error') taskkill.emit('error', new Error('taskkill missing'));
      else taskkill.emit('close', 1);
      await expectation;

      expect(target.kill).toHaveBeenCalledWith('SIGKILL');
      expect(treeKillSpawn).toHaveBeenCalledWith(
        'taskkill.exe',
        ['/pid', '456', '/t', '/f'],
        expect.objectContaining({ shell: false }),
      );
    },
  );

  it('bounds a hanging Windows taskkill before fallback and rejection', async () => {
    vi.useFakeTimers();
    const target = Object.assign(new EventEmitter(), {
      pid: 789,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    const taskkill = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const runner = new NodeCommandRunner({
      platform: 'win32',
      spawn: vi.fn(() => target),
      treeKillSpawn: vi.fn(() => taskkill),
      terminationTimeoutMs: 5,
    });
    const controller = new AbortController();
    const result = runner.run('tool.exe', [], { shell: false, signal: controller.signal });
    const expectation = expect(result).rejects.toBeInstanceOf(CommandAbortedError);
    controller.abort();

    await vi.advanceTimersByTimeAsync(4);
    expect(target.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expectation;
    expect(taskkill.kill).toHaveBeenCalledWith('SIGKILL');
    expect(target.kill).toHaveBeenCalledWith('SIGKILL');
    vi.useRealTimers();
  });
});

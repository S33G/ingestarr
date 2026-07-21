import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createThumbnailService,
  extractRawPreview,
  ffmpegPosterArgs,
  generateImageThumbnail,
  generateVideoThumbnail,
  resolveBundledFfmpegPath,
  thumbnailCacheKey,
} from './thumbnail-service.js';

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), 'ingestarr-thumb-'));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('thumbnail transforms', () => {
  it('resolves packaged FFmpeg to the unpacked executable path', () => {
    expect(
      resolveBundledFfmpegPath(
        '/Applications/Ingestarr.app/Contents/Resources/app.asar/node_modules/ffmpeg-static/ffmpeg',
      ),
    ).toBe(
      '/Applications/Ingestarr.app/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg',
    );
    expect(resolveBundledFfmpegPath('/workspace/node_modules/ffmpeg-static/ffmpeg')).toBe(
      '/workspace/node_modules/ffmpeg-static/ffmpeg',
    );
  });

  it('auto-orients, fits, emits metadata-free WebP', async () => {
    const directory = await root();
    const input = path.join(directory, 'source.jpg');
    const output = path.join(directory, 'thumb.webp');
    await sharp({
      create: { width: 40, height: 20, channels: 3, background: '#ff0000' },
    })
      .jpeg()
      .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: 'generated test' } } })
      .toFile(input);

    const result = await generateImageThumbnail(input, output, {
      width: 16,
      height: 16,
      format: 'webp',
    });
    const metadata = await sharp(output).metadata();

    expect(result).toMatchObject({ width: 8, height: 16, mimeType: 'image/webp' });
    expect(metadata).toMatchObject({ width: 8, height: 16 });
    expect(metadata.exif).toBeUndefined();
  });

  it('tries RAW preview tags in explicit order', async () => {
    const calls: string[] = [];
    const preview = Buffer.from('preview');
    const result = await extractRawPreview('/copy/file.cr3', async (_file, tag) => {
      calls.push(tag);
      if (tag === 'ThumbnailImage') return preview;
      throw new Error('missing');
    });

    expect(calls).toEqual(['PreviewImage', 'JpgFromRaw', 'ThumbnailImage']);
    expect(result).toEqual(preview);
  });

  it('aborts a hung RAW preview extraction', async () => {
    const controller = new AbortController();
    const extraction = extractRawPreview(
      '/copy/file.cr3',
      async () => new Promise<Buffer>(() => {}),
      { signal: controller.signal },
    );

    controller.abort();

    await expect(extraction).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('builds deterministic no-shell FFmpeg poster arguments', () => {
    expect(ffmpegPosterArgs('/copy/clip.mov', '/cache/poster.jpg', 4)).toEqual([
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      '4',
      '-i',
      '/copy/clip.mov',
      '-frames:v',
      '1',
      '-vf',
      "scale='min(640,iw)':'min(640,ih)':force_original_aspect_ratio=decrease",
      '-map_metadata',
      '-1',
      '-y',
      '/cache/poster.jpg',
    ]);
  });

  it('spawns the exact FFmpeg path without a shell and falls back to the first frame', async () => {
    const directory = await root();
    const output = path.join(directory, 'poster.jpg');
    const calls: Array<{ executable: string; args: readonly string[]; shell: boolean }> = [];
    const spawn = vi.fn(
      (executable: string, args: readonly string[], options: { shell: false }) => {
        const child = new EventEmitter() as EventEmitter & {
          pid: number;
          stderr: EventEmitter;
          kill: ReturnType<typeof vi.fn>;
        };
        child.pid = 12;
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        calls.push({ executable, args, shell: options.shell });
        queueMicrotask(async () => {
          if (calls.length === 1) child.emit('close', 1);
          else {
            await sharp({ create: { width: 4, height: 3, channels: 3, background: '#00ff00' } })
              .jpeg()
              .toFile(output);
            child.emit('close', 0);
          }
        });
        return child;
      },
    );

    await expect(
      generateVideoThumbnail('/copy/short.mov', output, {
        executable: '/bundled/ffmpeg',
        durationSeconds: 30,
        spawn: spawn as never,
      }),
    ).resolves.toMatchObject({ width: 4, height: 3 });
    expect(calls).toHaveLength(2);
    expect(
      calls.every((call) => call.executable === '/bundled/ffmpeg' && call.shell === false),
    ).toBe(true);
    expect(calls[1]?.args).toContain('0');
  });

  it('kills FFmpeg on timeout and abort', async () => {
    const children: Array<{ kill: ReturnType<typeof vi.fn> }> = [];
    const spawn = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.pid = 99_999_999;
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      children.push(child);
      return child;
    });
    await expect(
      generateVideoThumbnail('/copy/hang.mov', '/cache/poster.jpg', {
        executable: '/bundled/ffmpeg',
        timeoutMs: 5,
        spawn: spawn as never,
      }),
    ).rejects.toThrow(/timeout/i);
    const controller = new AbortController();
    const aborted = generateVideoThumbnail('/copy/hang.mov', '/cache/poster.jpg', {
      executable: '/bundled/ffmpeg',
      signal: controller.signal,
      spawn: spawn as never,
    });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(children.every((child) => child.kill.mock.calls.length > 0)).toBe(true);
  });
});

describe('thumbnail service', () => {
  it('uses deterministic keys and deduplicates simultaneous verified-copy jobs', async () => {
    const directory = await root();
    const source = path.join(directory, 'source.jpg');
    await writeFile(source, 'generated');
    const process = vi.fn(async (_input: string, output: string) => {
      await writeFile(output, 'thumbnail');
      return { width: 10, height: 10, mimeType: 'image/webp' };
    });
    const states: unknown[] = [];
    const service = createThumbnailService({
      root: path.join(directory, 'cache'),
      concurrency: 1,
      processor: process,
      persist: async (state) => states.push(state),
    });
    const job = {
      copyId: 'copy-1',
      sourceFileId: 'file-1',
      destinationPath: source,
      destinationChecksum: 'abc',
      copyStatus: 'verified' as const,
      mediaType: 'photo' as const,
      extension: '.jpg',
    };

    const [first, second] = await Promise.all([service.enqueue(job), service.enqueue(job)]);

    expect(process).toHaveBeenCalledOnce();
    expect(first).toEqual(second);
    expect(first.cacheKey).toBe(
      thumbnailCacheKey('abc', { width: 640, height: 640, format: 'webp', version: 'thumb-v1' }),
    );
    expect(states).toEqual([expect.objectContaining({ status: 'ready', copyId: 'copy-1' })]);
    await expect(readFile(first.cachePath, 'utf8')).resolves.toBe('thumbnail');
    await service.close();
  });

  it('deduplicates identical content while persisting every copied-file association', async () => {
    const directory = await root();
    const source = path.join(directory, 'source.jpg');
    await writeFile(source, 'generated');
    const process = vi.fn(async (_input: string, output: string) => {
      await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
        .webp()
        .toFile(output);
      return { width: 2, height: 2, mimeType: 'image/webp' };
    });
    const persist = vi.fn(async (state: { copyId: string }) => {
      void state;
    });
    const service = createThumbnailService({
      root: path.join(directory, 'cache'),
      processor: process,
      persist,
    });
    const job = {
      sourceFileId: 'file-1',
      destinationPath: source,
      destinationChecksum: 'shared-checksum',
      copyStatus: 'verified' as const,
      mediaType: 'photo' as const,
      extension: '.jpg',
    };

    const [first, second] = await Promise.all([
      service.enqueue({ ...job, copyId: 'copy-1' }),
      service.enqueue({ ...job, copyId: 'copy-2', sourceFileId: 'file-2' }),
    ]);
    const third = await service.enqueue({
      ...job,
      copyId: 'copy-3',
      sourceFileId: 'file-3',
    });

    expect(process).toHaveBeenCalledOnce();
    expect(first.cachePath).toBe(second.cachePath);
    expect(third.cachePath).toBe(first.cachePath);
    expect(persist.mock.calls.map(([state]) => state.copyId)).toEqual([
      'copy-1',
      'copy-2',
      'copy-3',
    ]);
    await service.close();
  });

  it.each([
    ['image', '.jpg'],
    ['RAW', '.cr3'],
  ])('times out hung %s processors and suppresses late completion', async (_kind, extension) => {
    const directory = await root();
    const source = path.join(directory, `source${extension}`);
    await writeFile(source, 'generated');
    let finish!: () => Promise<void>;
    const persist = vi.fn(async () => undefined);
    const processor = vi.fn(
      async (_input: string, output: string, _job: unknown, signal: AbortSignal) => {
        await new Promise<void>((resolve) => {
          finish = async () => {
            await writeFile(output, 'late output');
            resolve();
          };
        });
        expect(signal.aborted).toBe(true);
        return { width: 1, height: 1, mimeType: 'image/webp' };
      },
    );
    const service = createThumbnailService({
      root: path.join(directory, 'cache'),
      timeoutMs: 10,
      maxRetries: 0,
      processor,
      persist,
    });

    await expect(
      service.enqueue({
        copyId: 'copy',
        sourceFileId: 'source',
        destinationPath: source,
        destinationChecksum: extension,
        copyStatus: 'verified',
        mediaType: 'photo',
        extension,
      }),
    ).rejects.toThrow(/abort|timed? out/i);
    await finish();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    const cacheFiles = await readdir(path.join(directory, 'cache'), {
      recursive: true,
    });
    expect(cacheFiles.filter((entry) => entry.endsWith('.webp'))).toEqual([]);
    await service.close();
  });

  it('aborts active work and bounds close when a processor ignores cancellation', async () => {
    const directory = await root();
    const source = path.join(directory, 'source.jpg');
    await writeFile(source, 'generated');
    let observedSignal: AbortSignal | undefined;
    const service = createThumbnailService({
      root: path.join(directory, 'cache'),
      timeoutMs: 60_000,
      shutdownTimeoutMs: 20,
      processor: async (_input, _output, _job, signal) => {
        observedSignal = signal;
        return new Promise(() => {});
      },
      persist: async () => undefined,
    });
    const running = service.enqueue({
      copyId: 'copy',
      sourceFileId: 'source',
      destinationPath: source,
      destinationChecksum: 'checksum',
      copyStatus: 'verified',
      mediaType: 'photo',
      extension: '.jpg',
    });
    while (observedSignal === undefined)
      await new Promise<void>((resolve) => setImmediate(resolve));

    const started = performance.now();
    await service.close();

    expect(observedSignal.aborted).toBe(true);
    expect(performance.now() - started).toBeLessThan(250);
    await expect(running).rejects.toThrow(/closed|abort/i);
  });

  it('persists cumulative retry state across recreated services and prevents storms', async () => {
    const directory = await root();
    const source = path.join(directory, 'source.jpg');
    await writeFile(source, 'generated');
    const durable = new Map<
      string,
      { attemptCount: number; nextRetryAt: string | null; maxAttempts: number }
    >();
    const processor = vi.fn(async () => {
      throw new Error('decoder failed');
    });
    const makeService = () =>
      createThumbnailService({
        root: path.join(directory, 'cache'),
        maxRetries: 0,
        maxAttempts: 2,
        now: () => '2026-07-19T12:00:00.000Z',
        processor,
        loadRetryState: (job) => durable.get(job.copyId),
        persist: async (state) => {
          if (state.status === 'failed') {
            durable.set(state.copyId, {
              attemptCount: state.attemptCount,
              nextRetryAt: state.nextRetryAt,
              maxAttempts: state.maxAttempts,
            });
          }
        },
      });
    const job = {
      copyId: 'copy',
      sourceFileId: 'source',
      destinationPath: source,
      destinationChecksum: 'checksum',
      copyStatus: 'verified' as const,
      mediaType: 'photo' as const,
      extension: '.jpg',
    };

    const first = makeService();
    await expect(first.enqueue(job)).rejects.toThrow('decoder failed');
    await first.close();
    expect(durable.get('copy')).toMatchObject({ attemptCount: 1, maxAttempts: 2 });

    const second = makeService();
    await expect(second.enqueue(job)).rejects.toThrow(/retry.*eligible/i);
    await expect(second.enqueue({ ...job, retryOverride: true })).rejects.toThrow('decoder failed');
    await expect(second.enqueue({ ...job, retryOverride: true })).rejects.toThrow(/maximum/i);
    expect(processor).toHaveBeenCalledTimes(2);
    expect(durable.get('copy')).toMatchObject({ attemptCount: 2, maxAttempts: 2 });
    await second.close();
  });

  it('rejects unverified copies, validates stale cache, and persists safe failures once', async () => {
    const directory = await root();
    const cacheRoot = path.join(directory, 'cache');
    const process = vi.fn(async (_input: string, output: string) => {
      await writeFile(output, 'ok');
      return { width: 1, height: 1, mimeType: 'image/webp' };
    });
    const persist = vi.fn();
    const service = createThumbnailService({
      root: cacheRoot,
      processor: process,
      persist,
      maxRetries: 1,
    });
    const base = {
      copyId: 'copy-1',
      sourceFileId: 'file-1',
      destinationPath: path.join(directory, 'source.jpg'),
      destinationChecksum: 'abc',
      mediaType: 'photo' as const,
      extension: '.jpg',
    };
    await expect(service.enqueue({ ...base, copyStatus: 'started' as const })).rejects.toThrow(
      /verified/i,
    );
    await writeFile(base.destinationPath, 'source');
    const first = await service.enqueue({ ...base, copyStatus: 'verified' as const });
    await writeFile(first.cachePath, '');
    await service.enqueue({ ...base, copyStatus: 'verified' as const });
    expect(process).toHaveBeenCalledTimes(2);
    expect((await stat(first.cachePath)).size).toBeGreaterThan(0);
    await writeFile(first.cachePath, 'corrupt non-empty cache entry');
    await service.enqueue({ ...base, copyStatus: 'verified' as const });
    expect(process).toHaveBeenCalledTimes(3);

    const failing = createThumbnailService({
      root: path.join(directory, 'failed-cache'),
      maxRetries: 1,
      processor: async () => {
        throw new Error('/private/path decoder exploded');
      },
      persist,
    });
    await expect(failing.enqueue({ ...base, copyStatus: 'verified' as const })).rejects.toThrow();
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'THUMBNAIL_FAILED',
        safeMessage: 'Thumbnail unavailable.',
        retryCount: 2,
        attemptCount: 2,
      }),
    );
    await failing.close();
    await service.close();
  });

  it('aborts queued and active work on shutdown', async () => {
    const directory = await root();
    let release: (() => void) | undefined;
    const service = createThumbnailService({
      root: path.join(directory, 'cache'),
      concurrency: 1,
      processor: async (_input, output) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await writeFile(output, 'ok');
        return { width: 1, height: 1, mimeType: 'image/webp' };
      },
      persist: async () => undefined,
    });
    const job = (id: string) => ({
      copyId: id,
      sourceFileId: id,
      destinationPath: path.join(directory, `${id}.jpg`),
      destinationChecksum: id,
      copyStatus: 'verified' as const,
      mediaType: 'photo' as const,
      extension: '.jpg',
    });
    await Promise.all([
      writeFile(job('a').destinationPath, 'a'),
      writeFile(job('b').destinationPath, 'b'),
    ]);
    const active = service.enqueue(job('a'));
    const queued = service.enqueue(job('b'));
    while (release === undefined) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const closing = service.close();
    await expect(queued).rejects.toThrow(/closed/i);
    release?.();
    await expect(active).rejects.toThrow(/closed|abort/i);
    await closing;
  });
});

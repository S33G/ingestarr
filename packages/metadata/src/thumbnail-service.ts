import { createHash, randomUUID } from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { open, mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import { ExifTool } from 'exiftool-vendored';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';

export const THUMBNAIL_GENERATOR_VERSION = 'thumb-v1';
const RAW_EXTENSIONS = new Set([
  '.arw',
  '.cr2',
  '.cr3',
  '.dng',
  '.nef',
  '.orf',
  '.pef',
  '.raf',
  '.raw',
  '.rw2',
  '.srw',
]);

export interface ThumbnailSpec {
  width: number;
  height: number;
  format: 'webp' | 'jpeg';
  version: string;
}

export interface ThumbnailJob {
  copyId: string;
  sourceFileId: string;
  destinationPath: string;
  destinationChecksum: string;
  copyStatus: 'planned' | 'started' | 'failed' | 'verified';
  mediaType: 'photo' | 'video' | 'unknown';
  extension: string;
  durationSeconds?: number | null;
  signal?: AbortSignal;
  retryOverride?: boolean;
}

export interface ThumbnailReady {
  status: 'ready';
  copyId: string;
  sourceFileId: string;
  cacheKey: string;
  cachePath: string;
  checksum: string;
  generatorVersion: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  retryCount: number;
  updatedAt: string;
}

export interface ThumbnailFailed {
  status: 'failed';
  copyId: string;
  sourceFileId: string;
  errorCode: 'THUMBNAIL_FAILED' | 'THUMBNAIL_TIMEOUT' | 'THUMBNAIL_ABORTED';
  safeMessage: 'Thumbnail unavailable.';
  retryCount: number;
  attemptCount: number;
  nextRetryAt: string | null;
  maxAttempts: number;
  updatedAt: string;
}

export type ThumbnailState = ThumbnailReady | ThumbnailFailed;

export function thumbnailCacheKey(checksum: string, spec: ThumbnailSpec): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        checksum,
        format: spec.format,
        height: spec.height,
        version: spec.version,
        width: spec.width,
      }),
    )
    .digest('hex');
}

export async function generateImageThumbnail(
  input: string | Buffer,
  output: string,
  spec: Pick<ThumbnailSpec, 'width' | 'height' | 'format'>,
  options: { signal?: AbortSignal } = {},
): Promise<{ width: number; height: number; mimeType: string }> {
  let pipeline = sharp(input, { failOn: 'error', limitInputPixels: 268_402_689 })
    .autoOrient()
    .resize({
      width: spec.width,
      height: spec.height,
      fit: 'inside',
      withoutEnlargement: true,
    });
  pipeline =
    spec.format === 'webp'
      ? pipeline.webp({ quality: 82, effort: 4 })
      : pipeline.jpeg({ quality: 85, progressive: true, mozjpeg: true });
  const isAborted = (): boolean => options.signal?.aborted === true;
  if (isAborted()) {
    pipeline.destroy();
    throw new DOMException('Thumbnail generation aborted', 'AbortError');
  }
  const abort = (): void => {
    pipeline.destroy(new DOMException('Thumbnail generation aborted', 'AbortError'));
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  let info: { width: number; height: number };
  try {
    info = await pipeline.toFile(output);
    if (isAborted()) {
      throw new DOMException('Thumbnail generation aborted', 'AbortError');
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
  return {
    width: info.width,
    height: info.height,
    mimeType: spec.format === 'webp' ? 'image/webp' : 'image/jpeg',
  };
}

export async function extractRawPreview(
  file: string,
  extract: (file: string, tag: 'PreviewImage' | 'JpgFromRaw' | 'ThumbnailImage') => Promise<Buffer>,
  options: { signal?: AbortSignal } = {},
): Promise<Buffer> {
  let lastError: unknown;
  for (const tag of ['PreviewImage', 'JpgFromRaw', 'ThumbnailImage'] as const) {
    try {
      if (options.signal?.aborted === true) {
        throw new DOMException('RAW extraction aborted', 'AbortError');
      }
      let rejectAbort!: (error: Error) => void;
      const abort = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      const abortExtraction = (): void =>
        rejectAbort(new DOMException('RAW extraction aborted', 'AbortError'));
      options.signal?.addEventListener('abort', abortExtraction, { once: true });
      const value = await Promise.race([extract(file, tag), abort]).finally(() =>
        options.signal?.removeEventListener('abort', abortExtraction),
      );
      if (value.length > 0) return value;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('RAW preview unavailable');
}

export function ffmpegPosterArgs(
  input: string,
  output: string,
  seekSeconds: number,
  size = 640,
): string[] {
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(seekSeconds),
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    `scale='min(${String(size)},iw)':'min(${String(size)},ih)':force_original_aspect_ratio=decrease`,
    '-map_metadata',
    '-1',
    '-y',
    output,
  ];
}

export function resolveBundledFfmpegPath(exportedPath: string | null): string | null {
  return exportedPath?.replace(/([\\/]app\.asar)([\\/])/, '$1.unpacked$2') ?? null;
}

export interface SpawnLike {
  (
    executable: string,
    args: readonly string[],
    options: { shell: false; detached: boolean; stdio: ['ignore', 'ignore', 'pipe'] },
  ): ChildProcessWithoutNullStreams;
}

function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    const killer = nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => child.kill('SIGKILL'));
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export async function generateVideoThumbnail(
  input: string,
  output: string,
  options: {
    durationSeconds?: number | null;
    size?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    executable?: string | null;
    spawn?: SpawnLike;
  } = {},
): Promise<{ width: number; height: number; mimeType: 'image/jpeg' }> {
  const executable =
    options.executable === undefined ? resolveBundledFfmpegPath(ffmpegPath) : options.executable;
  if (executable === null) throw new Error('Bundled FFmpeg is unavailable');
  const spawn = options.spawn ?? (nodeSpawn as SpawnLike);
  const seek = Math.max(0, Math.min(4, Math.max(0, (options.durationSeconds ?? 0) / 3)));
  const attempts = seek > 0 ? [seek, 0] : [0];
  let lastError: unknown;
  for (const position of attempts) {
    try {
      await new Promise<void>((resolve, reject) => {
        if (options.signal?.aborted === true) {
          reject(new DOMException('Thumbnail generation aborted', 'AbortError'));
          return;
        }
        const child = spawn(executable, ffmpegPosterArgs(input, output, position, options.size), {
          shell: false,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < 16_384)
            stderr += chunk.toString('utf8').slice(0, 16_384 - stderr.length);
        });
        const abort = (): void => {
          clearTimeout(timer);
          killTree(child);
          reject(new DOMException('Thumbnail generation aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
          killTree(child);
          reject(new Error('FFmpeg thumbnail timeout'));
        }, options.timeoutMs ?? 20_000);
        child.once('error', (error) => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg exited ${String(code)}: ${stderr}`));
        });
        options.signal?.addEventListener('abort', abort, { once: true });
      });
      const metadata = await sharp(output).metadata();
      if (metadata.width === undefined || metadata.height === undefined) {
        throw new Error('FFmpeg emitted an invalid poster');
      }
      return { width: metadata.width, height: metadata.height, mimeType: 'image/jpeg' };
    } catch (error) {
      lastError = error;
      if (
        options.signal?.aborted === true ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('FFmpeg poster unavailable');
}

async function fsyncFile(file: string): Promise<void> {
  const handle = await open(file, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function inspectCache(
  file: string,
): Promise<{ width: number; height: number; mimeType: string; sizeBytes: number } | undefined> {
  try {
    const facts = await stat(file);
    if (!facts.isFile() || facts.size === 0) return undefined;
    const metadata = await sharp(file).metadata();
    if (
      metadata.width === undefined ||
      metadata.height === undefined ||
      (metadata.format !== 'webp' && metadata.format !== 'jpeg')
    ) {
      return undefined;
    }
    return {
      width: metadata.width,
      height: metadata.height,
      mimeType: metadata.format === 'jpeg' ? 'image/jpeg' : 'image/webp',
      sizeBytes: facts.size,
    };
  } catch {
    return undefined;
  }
}

export interface ThumbnailServiceOptions {
  root: string;
  concurrency?: number;
  timeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxRetries?: number;
  maxAttempts?: number;
  spec?: Partial<ThumbnailSpec>;
  processor?: (
    input: string,
    output: string,
    job: ThumbnailJob,
    signal: AbortSignal,
  ) => Promise<{ width: number; height: number; mimeType: string }>;
  persist(state: ThumbnailState): Promise<unknown>;
  loadRetryState?: (
    job: ThumbnailJob,
  ) =>
    | { attemptCount: number; nextRetryAt: string | null; maxAttempts: number }
    | undefined
    | Promise<
        { attemptCount: number; nextRetryAt: string | null; maxAttempts: number } | undefined
      >;
  now?: () => string;
}

interface QueueItem {
  job: ThumbnailJob;
  key: string;
  resolve(value: GeneratedArtifact): void;
  reject(error: Error): void;
}

interface GeneratedArtifact {
  cacheKey: string;
  cachePath: string;
  checksum: string;
  generatorVersion: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  retryCount: number;
}

class ThumbnailProcessingError extends Error {
  constructor(
    readonly code: ThumbnailFailed['errorCode'],
    readonly retryCount: number,
    message: string,
  ) {
    super(message);
    this.name = code === 'THUMBNAIL_ABORTED' ? 'AbortError' : 'ThumbnailProcessingError';
  }
}

export function createThumbnailService(options: ThumbnailServiceOptions) {
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new RangeError('thumbnail concurrency must be an integer from 1 through 8');
  }
  const spec: ThumbnailSpec = {
    width: options.spec?.width ?? 640,
    height: options.spec?.height ?? 640,
    format: options.spec?.format ?? 'webp',
    version: options.spec?.version ?? THUMBNAIL_GENERATOR_VERSION,
  };
  const maxRetries = options.maxRetries ?? 2;
  const defaultMaxAttempts = options.maxAttempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
  const now = options.now ?? (() => new Date().toISOString());
  const queue: QueueItem[] = [];
  const pending = new Map<string, Promise<GeneratedArtifact>>();
  const associations = new Map<string, Promise<ThumbnailReady>>();
  const active = new Set<Promise<void>>();
  const activeControllers = new Set<AbortController>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let rawTool: ExifTool | undefined;

  const defaultProcessor = async (
    input: string,
    output: string,
    job: ThumbnailJob,
    signal: AbortSignal,
  ) => {
    if (job.mediaType === 'video') {
      return generateVideoThumbnail(input, output, {
        durationSeconds: job.durationSeconds,
        size: Math.max(spec.width, spec.height),
        signal,
      });
    }
    let image: string | Buffer = input;
    if (RAW_EXTENSIONS.has(job.extension.toLowerCase())) {
      const tool = (rawTool ??= new ExifTool({
        maxProcs: 1,
        taskRetries: 0,
        taskTimeoutMillis: timeoutMs,
      }));
      try {
        image = await extractRawPreview(
          input,
          async (file, tag) => {
            if (signal.aborted) throw new DOMException('RAW extraction aborted', 'AbortError');
            const operation = tool.extractBinaryTagToBuffer(tag, file);
            let rejectAbort!: (error: Error) => void;
            const abort = new Promise<never>((_resolve, reject) => {
              rejectAbort = reject;
            });
            const abortWorker = (): void => {
              if (rawTool === tool) rawTool = undefined;
              void tool.end(false).catch(() => undefined);
              rejectAbort(new DOMException('RAW extraction aborted', 'AbortError'));
            };
            signal.addEventListener('abort', abortWorker, { once: true });
            try {
              return await Promise.race([operation, abort]);
            } finally {
              signal.removeEventListener('abort', abortWorker);
            }
          },
          { signal },
        );
      } catch {
        if (signal.aborted) throw new DOMException('RAW extraction aborted', 'AbortError');
        image = input;
      }
    }
    return generateImageThumbnail(image, output, spec, { signal });
  };
  const processor = options.processor ?? defaultProcessor;

  function drain(): void {
    while (!closed && active.size < concurrency) {
      const item = queue.shift();
      if (item === undefined) return;
      const operation = run(item).finally(() => {
        active.delete(operation);
        pending.delete(item.key);
        drain();
      });
      active.add(operation);
    }
  }

  async function run(item: QueueItem): Promise<void> {
    const { job, key } = item;
    const extension = job.mediaType === 'video' || spec.format === 'jpeg' ? '.jpg' : '.webp';
    const directory = path.join(options.root, key.slice(0, 2));
    const cachePath = path.join(directory, `${key}${extension}`);
    await mkdir(directory, { recursive: true });
    const cached = await inspectCache(cachePath);
    if (cached !== undefined) {
      item.resolve({
        cacheKey: key,
        cachePath,
        checksum: createHash('sha256')
          .update(await readBytes(cachePath))
          .digest('hex'),
        generatorVersion: spec.version,
        mimeType: cached.mimeType,
        width: cached.width,
        height: cached.height,
        sizeBytes: cached.sizeBytes,
        retryCount: 0,
      });
      return;
    }
    await unlink(cachePath).catch(() => undefined);
    const temporaryPath = path.join(directory, `.${key}.${randomUUID()}.tmp${extension}`);
    const controller = new AbortController();
    activeControllers.add(controller);
    const abort = (): void =>
      controller.abort(new ThumbnailProcessingError('THUMBNAIL_ABORTED', 0, 'Thumbnail aborted'));
    job.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new ThumbnailProcessingError('THUMBNAIL_TIMEOUT', 0, 'Thumbnail generation timed out'),
        ),
      timeoutMs,
    );
    let retryCount = 0;
    try {
      let generated: { width: number; height: number; mimeType: string } | undefined;
      let lastError: unknown;
      while (retryCount <= maxRetries && generated === undefined) {
        try {
          const processing = Promise.resolve().then(() =>
            processor(job.destinationPath, temporaryPath, job, controller.signal),
          );
          const aborted = new Promise<never>((_resolve, reject) => {
            const rejectAbort = (): void =>
              reject(
                controller.signal.reason instanceof Error
                  ? controller.signal.reason
                  : new DOMException('Thumbnail generation aborted', 'AbortError'),
              );
            if (controller.signal.aborted) rejectAbort();
            else controller.signal.addEventListener('abort', rejectAbort, { once: true });
          });
          try {
            generated = await Promise.race([processing, aborted]);
          } catch (error) {
            void processing
              .then(
                () => unlink(temporaryPath),
                () => unlink(temporaryPath),
              )
              .catch(() => undefined);
            throw error;
          }
        } catch (error) {
          lastError = error;
          await unlink(temporaryPath).catch(() => undefined);
          if (controller.signal.aborted || retryCount >= maxRetries) throw error;
          retryCount += 1;
        }
      }
      if (generated === undefined) throw lastError;
      if (controller.signal.aborted) throw controller.signal.reason;
      await fsyncFile(temporaryPath);
      if (controller.signal.aborted) throw controller.signal.reason;
      await rename(temporaryPath, cachePath);
      if (controller.signal.aborted) {
        await unlink(cachePath).catch(() => undefined);
        throw controller.signal.reason;
      }
      await fsyncDirectory(directory);
      const checksum = createHash('sha256')
        .update(await readBytes(cachePath))
        .digest('hex');
      const sizeBytes = (await stat(cachePath)).size;
      if (controller.signal.aborted) {
        await unlink(cachePath).catch(() => undefined);
        throw controller.signal.reason;
      }
      item.resolve({
        cacheKey: key,
        cachePath,
        checksum,
        generatorVersion: spec.version,
        mimeType: generated.mimeType,
        width: generated.width,
        height: generated.height,
        sizeBytes,
        retryCount,
      });
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      item.reject(
        reason instanceof ThumbnailProcessingError
          ? new ThumbnailProcessingError(reason.code, retryCount, reason.message)
          : new ThumbnailProcessingError(
              job.signal?.aborted === true ? 'THUMBNAIL_ABORTED' : 'THUMBNAIL_FAILED',
              retryCount,
              reason instanceof Error ? reason.message : String(reason),
            ),
      );
    } finally {
      clearTimeout(timer);
      job.signal?.removeEventListener('abort', abort);
      activeControllers.delete(controller);
    }
  }

  function enqueue(job: ThumbnailJob): Promise<ThumbnailReady> {
    if (job.copyStatus !== 'verified' || job.destinationChecksum.length === 0) {
      return Promise.reject(new Error('Thumbnail jobs require a verified copied file'));
    }
    if (closed) return Promise.reject(new Error('Thumbnail service is closed'));
    const key = thumbnailCacheKey(
      job.destinationChecksum,
      job.mediaType === 'video' ? { ...spec, version: `${spec.version}:video-poster` } : spec,
    );
    const associationKey = `${job.copyId}\0${key}`;
    const existingAssociation = associations.get(associationKey);
    if (existingAssociation !== undefined) return existingAssociation;
    const association = (async (): Promise<ThumbnailReady> => {
      const prior = (await options.loadRetryState?.(job)) ?? {
        attemptCount: 0,
        nextRetryAt: null,
        maxAttempts: defaultMaxAttempts,
      };
      if (prior.attemptCount >= prior.maxAttempts) {
        throw new Error('Thumbnail retry maximum attempts reached');
      }
      if (
        job.retryOverride !== true &&
        prior.nextRetryAt !== null &&
        Date.parse(prior.nextRetryAt) > Date.parse(now())
      ) {
        throw new Error('Thumbnail retry is not yet eligible');
      }
      let generation = pending.get(key);
      if (generation === undefined) {
        generation = new Promise<GeneratedArtifact>((resolve, reject) => {
          queue.push({ job, key, resolve, reject });
          drain();
        });
        pending.set(key, generation);
      }
      try {
        const artifact = await generation;
        if (closed || job.signal?.aborted === true) {
          throw new ThumbnailProcessingError(
            'THUMBNAIL_ABORTED',
            artifact.retryCount,
            closed ? 'Thumbnail service is closed' : 'Thumbnail generation aborted',
          );
        }
        const ready: ThumbnailReady = {
          status: 'ready',
          copyId: job.copyId,
          sourceFileId: job.sourceFileId,
          ...artifact,
          updatedAt: now(),
        };
        await options.persist(ready);
        return ready;
      } catch (error: unknown) {
        if (!(error instanceof ThumbnailProcessingError)) throw error;
        const processing =
          error instanceof ThumbnailProcessingError
            ? error
            : new ThumbnailProcessingError('THUMBNAIL_FAILED', 0, String(error));
        const attemptCount = Math.min(
          prior.maxAttempts,
          prior.attemptCount + processing.retryCount + 1,
        );
        const retryDelayMs = Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attemptCount - 1));
        const updatedAt = now();
        const failed: ThumbnailFailed = {
          status: 'failed',
          copyId: job.copyId,
          sourceFileId: job.sourceFileId,
          errorCode: processing.code,
          safeMessage: 'Thumbnail unavailable.',
          retryCount: attemptCount,
          attemptCount,
          nextRetryAt:
            attemptCount >= prior.maxAttempts
              ? null
              : new Date(Date.parse(updatedAt) + retryDelayMs).toISOString(),
          maxAttempts: prior.maxAttempts,
          updatedAt,
        };
        await Promise.resolve(options.persist(failed)).catch(() => undefined);
        throw processing;
      }
    })();
    associations.set(associationKey, association);
    void association.finally(() => associations.delete(associationKey)).catch(() => undefined);
    return association;
  }

  function close(): Promise<void> {
    closing ??= (async () => {
      closed = true;
      for (const item of queue.splice(0)) {
        item.reject(new Error('Thumbnail service is closed'));
        pending.delete(item.key);
      }
      for (const controller of activeControllers) {
        controller.abort(
          new ThumbnailProcessingError('THUMBNAIL_ABORTED', 0, 'Thumbnail service is closed'),
        );
      }
      await Promise.race([
        Promise.allSettled([...active]),
        new Promise<void>((resolve) => setTimeout(resolve, shutdownTimeoutMs)),
      ]);
      const tool = rawTool;
      rawTool = undefined;
      if (tool !== undefined) {
        await Promise.race([
          tool.end(false).catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, shutdownTimeoutMs)),
        ]);
      }
    })();
    return closing;
  }

  return { enqueue, close, status: () => ({ queued: queue.length, active: active.size, closed }) };
}

async function readBytes(file: string): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

import { ExifTool } from 'exiftool-vendored';

import type { CaptureDateCandidates } from './normalize-capture-date.js';

export interface MetadataTags {
  dates: CaptureDateCandidates;
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
  mimeType: string | null;
  fileType: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  gpsPresent: boolean;
  warnings: string[];
}

export interface ExifToolReader {
  read(file: string, options?: { readArgs: string[] }): Promise<unknown>;
  end(gracefully?: boolean): Promise<void>;
}

export class MetadataTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Metadata extraction exceeded ${timeoutMs}ms`);
    this.name = 'MetadataTimeoutError';
  }
}

export class MetadataAbortError extends Error {
  constructor() {
    super('Metadata extraction aborted');
    this.name = 'AbortError';
  }
}

export class MetadataClientClosedError extends Error {
  constructor() {
    super('Metadata client is closed');
    this.name = 'MetadataClientClosedError';
  }
}

export class MetadataClientUnavailableError extends Error {
  constructor() {
    super('Metadata client is unavailable after worker cleanup failed');
    this.name = 'MetadataClientUnavailableError';
  }
}

export class MetadataGenerationRecycledError extends Error {
  constructor() {
    super('Metadata worker generation was recycled');
    this.name = 'MetadataGenerationRecycledError';
  }
}

export interface ExifToolClient {
  extract(
    file: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<MetadataTags>;
  close(): Promise<void>;
  status(): {
    queued: number;
    active: number;
    generations: number;
    closed: boolean;
    circuitOpen: boolean;
  };
}

export interface ExifToolClientOptions {
  exiftool?: ExifToolReader;
  exiftoolFactory?: () => ExifToolReader;
  concurrency?: number;
  maxProcs?: number;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

interface Generation {
  tool: ExifToolReader;
  active: Set<Task>;
  retired: boolean;
}

type CleanupResult = 'ended' | 'failed' | 'timeout';

interface Task {
  file: string;
  signal?: AbortSignal;
  timeoutMs: number;
  state: 'queued' | 'active' | 'settled';
  generation?: Generation;
  timer?: ReturnType<typeof setTimeout>;
  abort(): void;
  resolve(value: MetadataTags): void;
  reject(error: Error): void;
}

const DATE_TAGS = [
  'DateTimeOriginal',
  'CreateDate',
  'QuickTimeCreateDate',
  'CreationDate',
  'ContentCreateDate',
  'TrackCreateDate',
  'MediaCreateDate',
  'OffsetTimeOriginal',
  'OffsetTimeDigitized',
  'TimeZone',
] as const;

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function rawString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object' && 'rawValue' in value) {
    const raw = (value as { rawValue?: unknown }).rawValue;
    if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
  }
  const rendered = String(value);
  return rendered === '[object Object]' ? undefined : rendered;
}

function vendoredOffset(value: unknown): string | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('tzoffsetMinutes' in value) ||
    ('inferredZone' in value && value.inferredZone === true)
  ) {
    return undefined;
  }
  const minutes = (value as { tzoffsetMinutes?: unknown }).tzoffsetMinutes;
  if (
    typeof minutes !== 'number' ||
    !Number.isInteger(minutes) ||
    minutes < -840 ||
    minutes > 840
  ) {
    return undefined;
  }
  const absolute = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(
    absolute % 60,
  ).padStart(2, '0')}`;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function messages(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(messages);
  const message = nonEmptyString(value);
  return message === null ? [] : [message];
}

function presentGpsValue(value: unknown): boolean {
  return (
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.trim() !== '')
  );
}

function normalizeTags(value: unknown): MetadataTags {
  const tags =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const dates: CaptureDateCandidates = {};
  for (const tag of DATE_TAGS) {
    const raw = rawString(tags[tag]);
    if (raw !== undefined) dates[tag] = raw;
  }
  const originalOffset = vendoredOffset(tags.DateTimeOriginal);
  if (dates.OffsetTimeOriginal === undefined && originalOffset !== undefined) {
    dates.DateTimeOriginalOffset = originalOffset;
  }
  const createOffset = vendoredOffset(tags.CreateDate);
  if (dates.OffsetTimeDigitized === undefined && createOffset !== undefined) {
    dates.CreateDateOffset = createOffset;
  }
  return {
    dates,
    cameraMake: nonEmptyString(tags.Make),
    cameraModel: nonEmptyString(tags.Model),
    lensModel: nonEmptyString(tags.LensModel),
    mimeType: nonEmptyString(tags.MIMEType),
    fileType: nonEmptyString(tags.FileType),
    width: finiteNumber(tags.ImageWidth ?? tags.SourceImageWidth),
    height: finiteNumber(tags.ImageHeight ?? tags.SourceImageHeight),
    durationSeconds: finiteNumber(tags.Duration),
    gpsPresent:
      (presentGpsValue(tags.GPSLatitude) && presentGpsValue(tags.GPSLongitude)) ||
      presentGpsValue(tags.GPSPosition) ||
      presentGpsValue(tags.GPSCoordinates),
    warnings: [...messages(tags.Warning), ...messages(tags.warnings), ...messages(tags.errors)],
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be positive`);
  return value;
}

function positiveTimeout(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 1) throw new RangeError(`${name} must be positive`);
  return value;
}

export function createExifToolClient(options: ExifToolClientOptions = {}): ExifToolClient {
  const maxProcs = positiveInteger(options.maxProcs ?? 2, 'maxProcs');
  const concurrency = positiveInteger(options.concurrency ?? maxProcs, 'concurrency');
  const defaultTimeoutMs = positiveTimeout(options.timeoutMs ?? 30_000, 'timeoutMs');
  const cleanupTimeoutMs = positiveTimeout(options.cleanupTimeoutMs ?? 5_000, 'cleanupTimeoutMs');
  const shutdownTimeoutMs = positiveTimeout(
    options.shutdownTimeoutMs ?? 5_000,
    'shutdownTimeoutMs',
  );
  const defaultFactory = (): ExifToolReader =>
    new ExifTool({
      maxProcs,
      taskTimeoutMillis: defaultTimeoutMs,
      taskRetries: 0,
      backfillTimezones: false,
      inferTimezoneFromDatestamps: false,
      inferTimezoneFromTimeStamp: false,
      preferTimezoneInferenceFromGps: false,
      defaultVideosToUTC: false,
      geolocation: false,
      readArgs: [],
    });
  const factory =
    options.exiftoolFactory ?? (options.exiftool === undefined ? defaultFactory : undefined);
  let initialTool = options.exiftool;
  const queue: Task[] = [];
  let active = 0;
  let closed = false;
  let circuitOpen = false;
  let closing: Promise<void> | undefined;
  let current: Generation | undefined;
  let pendingCleanup: Promise<CleanupResult> | undefined;

  function createGeneration(): Generation {
    const tool = initialTool ?? factory?.();
    initialTool = undefined;
    if (tool === undefined) throw new MetadataClientClosedError();
    return {
      tool,
      active: new Set(),
      retired: false,
    };
  }

  current = createGeneration();

  function removeQueued(task: Task): void {
    const index = queue.indexOf(task);
    if (index >= 0) queue.splice(index, 1);
  }

  function releaseActive(task: Task): void {
    if (task.state !== 'active') return;
    task.generation?.active.delete(task);
    active -= 1;
  }

  function settle(task: Task, operation: () => void): boolean {
    if (task.state === 'settled') return false;
    if (task.state === 'queued') removeQueued(task);
    else releaseActive(task);
    task.state = 'settled';
    if (task.timer !== undefined) clearTimeout(task.timer);
    task.signal?.removeEventListener('abort', task.abort);
    operation();
    return true;
  }

  async function cleanupWithDeadline(
    operation: () => Promise<void>,
    deadlineMs: number,
  ): Promise<CleanupResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      Promise.resolve()
        .then(operation)
        .then(
          () => 'ended' as const,
          () => 'failed' as const,
        ),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), deadlineMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return result;
  }

  function rejectQueue(error: Error): void {
    for (const task of [...queue]) settle(task, () => task.reject(error));
  }

  function openCircuit(): void {
    circuitOpen = true;
    rejectQueue(new MetadataClientUnavailableError());
  }

  function forceGeneration(generation: Generation): Promise<CleanupResult> {
    generation.retired = true;
    if (pendingCleanup !== undefined) return pendingCleanup;
    const cleanup = cleanupWithDeadline(() => generation.tool.end(false), cleanupTimeoutMs);
    pendingCleanup = cleanup;
    void cleanup.then((result) => {
      if (pendingCleanup === cleanup) pendingCleanup = undefined;
      if (closed) return;
      if (result !== 'ended') {
        openCircuit();
        return;
      }
      try {
        current = createGeneration();
      } catch {
        openCircuit();
        return;
      }
      drain();
    });
    return cleanup;
  }

  function replaceGeneration(generation: Generation): void {
    if (generation.retired) return;
    generation.retired = true;
    for (const task of [...generation.active]) {
      settle(task, () => task.reject(new MetadataGenerationRecycledError()));
    }
    if (current === generation) current = undefined;
    void forceGeneration(generation);
  }

  function failTimedOrAborted(task: Task, error: MetadataTimeoutError | MetadataAbortError): void {
    const generation = task.state === 'active' ? task.generation : undefined;
    if (!settle(task, () => task.reject(error))) return;
    if (generation !== undefined) replaceGeneration(generation);
    else drain();
  }

  function start(task: Task, generation: Generation): void {
    task.state = 'active';
    task.generation = generation;
    generation.active.add(task);
    active += 1;
    let reading: Promise<unknown>;
    try {
      reading = Promise.resolve(generation.tool.read(task.file, { readArgs: [] }));
    } catch (error) {
      reading = Promise.reject(error);
    }
    void reading.then(
      (tags) => {
        if (settle(task, () => task.resolve(normalizeTags(tags)))) drain();
      },
      (error: unknown) => {
        if (
          settle(task, () => task.reject(error instanceof Error ? error : new Error(String(error))))
        ) {
          drain();
        }
      },
    );
  }

  function drain(): void {
    while (!closed && active < concurrency && current !== undefined && !current.retired) {
      const task = queue.shift();
      if (task === undefined) return;
      if (task.state !== 'queued') continue;
      if (task.signal?.aborted === true) {
        settle(task, () => task.reject(new MetadataAbortError()));
        continue;
      }
      start(task, current);
    }
  }

  function extract(
    file: string,
    extractOptions: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<MetadataTags> {
    if (closed) return Promise.reject(new MetadataClientClosedError());
    if (circuitOpen) return Promise.reject(new MetadataClientUnavailableError());
    const signal = extractOptions.signal;
    if (signal?.aborted === true) return Promise.reject(new MetadataAbortError());
    const taskTimeoutMs = positiveTimeout(
      extractOptions.timeoutMs ?? defaultTimeoutMs,
      'timeoutMs',
    );
    return new Promise<MetadataTags>((resolve, reject) => {
      const task = {
        file,
        signal,
        timeoutMs: taskTimeoutMs,
        state: 'queued',
        resolve,
        reject,
      } as Task;
      task.abort = () => failTimedOrAborted(task, new MetadataAbortError());
      task.timer = setTimeout(() => {
        failTimedOrAborted(task, new MetadataTimeoutError(task.timeoutMs));
      }, task.timeoutMs);
      signal?.addEventListener('abort', task.abort, { once: true });
      queue.push(task);
      drain();
    });
  }

  async function shutdownGeneration(generation: Generation): Promise<CleanupResult> {
    const gracefulDeadlineMs = Math.max(
      1,
      Math.min(cleanupTimeoutMs, Math.floor(shutdownTimeoutMs / 2)),
    );
    const graceful = await cleanupWithDeadline(() => generation.tool.end(true), gracefulDeadlineMs);
    if (graceful === 'ended') return graceful;
    return cleanupWithDeadline(() => generation.tool.end(false), cleanupTimeoutMs);
  }

  function close(): Promise<void> {
    closing ??= (async () => {
      closed = true;
      rejectQueue(new MetadataClientClosedError());
      const liveGeneration = current;
      current = undefined;
      if (liveGeneration !== undefined) {
        for (const task of [...liveGeneration.active]) {
          settle(task, () => task.reject(new MetadataClientClosedError()));
        }
        const cleanup = shutdownGeneration(liveGeneration);
        pendingCleanup = cleanup;
        void cleanup.then(() => {
          if (pendingCleanup === cleanup) pendingCleanup = undefined;
        });
      }
      const cleanup = pendingCleanup;
      if (cleanup === undefined) return;
      const result = await cleanupWithDeadline(async () => {
        if ((await cleanup) !== 'ended') throw new Error('Metadata cleanup failed');
      }, shutdownTimeoutMs);
      if (result !== 'ended') circuitOpen = true;
      if (pendingCleanup === cleanup) pendingCleanup = undefined;
    })();
    return closing;
  }

  function status() {
    return {
      queued: queue.length,
      active,
      generations: (current === undefined ? 0 : 1) + (pendingCleanup === undefined ? 0 : 1),
      closed,
      circuitOpen,
    };
  }

  return { extract, close, status };
}

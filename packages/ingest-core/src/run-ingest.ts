import {
  ingestMetadataSchema,
  type IngestMetadata as SharedIngestMetadata,
} from '@ingestarr/shared-types';

export type IngestSessionStatus =
  | 'discovering'
  | 'analyzing'
  | 'ready'
  | 'copying'
  | 'verifying'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface IngestFile {
  relativePath: string;
  pathSegments: readonly string[];
  sizeBytes: number;
  modifiedAt: string;
}

export interface IngestClassification {
  decision: 'new' | 'known' | 'recoverable' | 'ambiguous';
  /** Must come from a durable copied-file record with status `verified`. */
  verifiedCopy: boolean;
}

export type IngestMetadata = SharedIngestMetadata;

export type DurableIngestFile = IngestFile & {
  id: string;
  sourceId: string;
  sessionId: string;
} & IngestMetadata;

export type RunIngestProgressEvent =
  | { type: 'session-status'; sessionId: string; status: IngestSessionStatus; occurredAt: string }
  | {
      type: 'file-status';
      sessionId: string;
      fileId: string;
      status: 'ready' | 'skipped' | 'copying' | 'failed';
      occurredAt: string;
    }
  | {
      type: 'file-completed';
      sessionId: string;
      fileId: string;
      bytes: number;
      checksum: string;
      occurredAt: string;
    }
  | {
      type: 'collision';
      sessionId: string;
      fileId: string;
      destinationPath: string;
      occurredAt: string;
    };

export interface RunIngestInput {
  sourceRoot: string;
  destinationRoot: string;
  sourceLabel: string;
  precreatedSessionId?: string;
}

export interface RunIngestDependencies {
  now?: () => string;
  signal?: AbortSignal;
  copyConcurrency?: number;
  ids: {
    source(): string;
    session(): string;
    file(file: IngestFile): string;
  };
  identifySource(input: RunIngestInput): Promise<{ kind: 'new' | 'existing'; sourceId?: string }>;
  upsertSource(source: { id: string; displayName: string; seenAt: string }): Promise<unknown>;
  createSession(session: {
    id: string;
    sourceId: string;
    status: 'discovering';
    startedAt: string;
  }): Promise<unknown>;
  adoptSessionSource?(sessionId: string, sourceId: string, at: string): Promise<unknown>;
  updateSession(
    sessionId: string,
    status: IngestSessionStatus,
    at: string,
    failure?: { code: string; message: string },
  ): Promise<unknown>;
  scan(sourceRoot: string, signal?: AbortSignal): AsyncIterable<IngestFile>;
  classify(file: IngestFile, sourceId: string): Promise<IngestClassification>;
  metadata?(file: IngestFile, sourcePath: string, signal?: AbortSignal): Promise<IngestMetadata>;
  joinSourcePath?(root: string, segments: readonly string[]): string;
  persistSourceFile(
    file: DurableIngestFile,
    classification: IngestClassification,
  ): Promise<{ id: string }>;
  plan(file: DurableIngestFile): Promise<{ destinationPath: string }>;
  copy(
    file: DurableIngestFile & {
      sourcePath: string;
      destinationPath: string;
    },
  ): Promise<
    | { status: 'completed'; bytesCopied: number; checksum: string }
    | { status: 'collision'; destinationPath: string }
  >;
  markFileFailed(fileId: string, code: string, message: string, at: string): Promise<unknown>;
  snapshotManifest(sessionId: string): Promise<unknown>;
  emit?(event: RunIngestProgressEvent): void;
  log?(event: {
    phase: string;
    message: string;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void>;
}

export interface RunIngestResult {
  sessionId: string;
  status: 'completed' | 'cancelled' | 'failed';
  completedFiles: number;
  failedFiles: number;
  skippedFiles: number;
  collisions: number;
}

export class FatalIngestError extends Error {
  constructor(
    public readonly code: 'SOURCE_UNAVAILABLE' | 'DATABASE_FAILED' | 'INGEST_FAILED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FatalIngestError';
  }
}

function errorFacts(error: unknown): { code: string; message: string } {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'FILE_FAILED';
  return { code, message: error instanceof Error ? error.message : String(error) };
}

function cancellation(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException('Ingest cancelled', 'AbortError');
}

async function ignoreFailure(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    // Logging and manifest projection failures cannot corrupt authoritative database state.
  }
}

function fallbackMetadata(modifiedAt: string, sessionStartedAt: string): IngestMetadata {
  const modifiedInstant = new Date(modifiedAt);
  const useSession = Number.isNaN(modifiedInstant.getTime());
  const instant = useSession
    ? new Date(sessionStartedAt).toISOString()
    : modifiedInstant.toISOString();
  return ingestMetadataSchema.parse({
    captureAt: instant,
    captureDay: instant.slice(0, 10),
    captureAtSource: useSession ? 'session-start' : 'filesystem-modifiedAt',
    captureAtRaw: useSession ? sessionStartedAt : modifiedAt,
    captureTimezoneKind: 'fallback',
    captureOffsetMinutes: 0,
    captureOffsetSource: null,
    captureOffsetRaw: null,
    cameraMake: null,
    cameraModel: null,
    lensModel: null,
    mimeType: null,
    mediaType: 'unknown',
    width: null,
    height: null,
    durationSeconds: null,
    gpsPresent: false,
    warnings: [],
  });
}

export async function runIngest(
  input: RunIngestInput,
  dependencies: RunIngestDependencies,
): Promise<RunIngestResult> {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const sessionStartedAt = now();
  const sessionId = input.precreatedSessionId ?? dependencies.ids.session();
  let sourceId = dependencies.ids.source();
  let sessionCreated = input.precreatedSessionId !== undefined;
  let completedFiles = 0;
  let failedFiles = 0;
  let skippedFiles = 0;
  let collisions = 0;
  const emit = (event: RunIngestProgressEvent): void => {
    try {
      dependencies.emit?.(event);
    } catch (error) {
      void ignoreFailure(
        async () =>
          dependencies.log?.({
            phase: 'progress',
            message: 'Progress callback failed',
            errorCode: 'PROGRESS_CALLBACK_FAILED',
            errorMessage: error instanceof Error ? error.message : String(error),
          }) ?? Promise.resolve(),
      );
    }
  };
  const emitStatus = (status: IngestSessionStatus) =>
    emit({ type: 'session-status', sessionId, status, occurredAt: now() });
  const setStatus = async (
    status: IngestSessionStatus,
    failure?: { code: string; message: string },
  ) => {
    await dependencies.updateSession(sessionId, status, now(), failure);
    emitStatus(status);
  };

  try {
    cancellation(dependencies.signal);
    const identity = await dependencies.identifySource(input);
    sourceId = identity.sourceId ?? sourceId;
    await dependencies.upsertSource({
      id: sourceId,
      displayName: input.sourceLabel,
      seenAt: now(),
    });
    if (input.precreatedSessionId !== undefined) {
      if (dependencies.adoptSessionSource === undefined) {
        throw new FatalIngestError(
          'DATABASE_FAILED',
          'A precreated session requires source adoption',
        );
      }
      await dependencies.adoptSessionSource(sessionId, sourceId, now());
    } else {
      await dependencies.createSession({
        id: sessionId,
        sourceId,
        status: 'discovering',
        startedAt: sessionStartedAt,
      });
      sessionCreated = true;
      emitStatus('discovering');
    }
    await setStatus('analyzing');

    const queued: DurableIngestFile[] = [];
    try {
      for await (const file of dependencies.scan(input.sourceRoot, dependencies.signal)) {
        cancellation(dependencies.signal);
        const fileId = dependencies.ids.file(file);
        const sourcePath =
          dependencies.joinSourcePath?.(input.sourceRoot, file.pathSegments) ??
          [input.sourceRoot, ...file.pathSegments].join('/');
        let metadata = fallbackMetadata(file.modifiedAt, sessionStartedAt);
        if (dependencies.metadata !== undefined) {
          try {
            metadata = ingestMetadataSchema.parse(
              await dependencies.metadata(file, sourcePath, dependencies.signal),
            );
            if (metadata.degradation !== undefined) {
              await ignoreFailure(
                async () =>
                  dependencies.log?.({
                    phase: 'metadata',
                    message: 'Metadata extraction failed; using fallback timestamp',
                    errorCode: 'METADATA_FAILED',
                    errorMessage: metadata.degradation?.message,
                  }) ?? Promise.resolve(),
              );
            }
            for (const warning of metadata.warnings ?? []) {
              await ignoreFailure(
                async () =>
                  dependencies.log?.({
                    phase: 'metadata',
                    message: 'Metadata extraction warning',
                    errorCode: 'METADATA_WARNING',
                    errorMessage: warning,
                  }) ?? Promise.resolve(),
              );
            }
          } catch (error) {
            if (
              dependencies.signal?.aborted === true ||
              (error instanceof Error && error.name === 'AbortError')
            ) {
              throw new DOMException('Ingest cancelled', 'AbortError');
            }
            await ignoreFailure(
              async () =>
                dependencies.log?.({
                  phase: 'metadata',
                  message: 'Metadata extraction failed; using filesystem timestamp',
                  errorCode: 'METADATA_FAILED',
                  errorMessage: error instanceof Error ? error.message : String(error),
                }) ?? Promise.resolve(),
            );
          }
        }
        let classification: IngestClassification;
        try {
          classification = await dependencies.classify(file, sourceId);
        } catch (error) {
          throw new FatalIngestError('DATABASE_FAILED', 'File classification query failed', {
            cause: error,
          });
        }
        if (classification.decision === 'known' && classification.verifiedCopy !== true) {
          throw new FatalIngestError(
            'DATABASE_FAILED',
            'Storage classified a file as known without a verified copy',
          );
        }
        const durable = {
          ...file,
          id: fileId,
          sourceId,
          sessionId,
          ...ingestMetadataSchema.parse(metadata),
        };
        try {
          await dependencies.persistSourceFile(durable, classification);
        } catch (error) {
          throw new FatalIngestError('DATABASE_FAILED', 'Source-file persistence failed', {
            cause: error,
          });
        }
        if (classification.decision === 'known') {
          skippedFiles += 1;
          emit({
            type: 'file-status',
            sessionId,
            fileId,
            status: 'skipped',
            occurredAt: now(),
          });
        } else {
          queued.push(durable);
          emit({
            type: 'file-status',
            sessionId,
            fileId,
            status: 'ready',
            occurredAt: now(),
          });
        }
      }
    } catch (error) {
      if (
        error instanceof FatalIngestError ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        throw error;
      }
      throw new FatalIngestError('SOURCE_UNAVAILABLE', 'Source became unavailable during scan', {
        cause: error,
      });
    }

    await setStatus('ready');
    await setStatus('copying');
    const copyConcurrency = dependencies.copyConcurrency ?? 1;
    if (!Number.isInteger(copyConcurrency) || copyConcurrency < 1 || copyConcurrency > 8) {
      throw new RangeError('copyConcurrency must be an integer from 1 through 8');
    }
    const processFile = async (file: DurableIngestFile): Promise<void> => {
      cancellation(dependencies.signal);
      const sourcePath =
        dependencies.joinSourcePath?.(input.sourceRoot, file.pathSegments) ??
        [input.sourceRoot, ...file.pathSegments].join('/');
      try {
        const plan = await dependencies.plan(file);
        emit({
          type: 'file-status',
          sessionId,
          fileId: file.id,
          status: 'copying',
          occurredAt: now(),
        });
        const result = await dependencies.copy({
          ...file,
          sourcePath,
          destinationPath: plan.destinationPath,
        });
        if (result.status === 'collision') {
          collisions += 1;
          emit({
            type: 'collision',
            sessionId,
            fileId: file.id,
            destinationPath: result.destinationPath,
            occurredAt: now(),
          });
        } else {
          completedFiles += 1;
          emit({
            type: 'file-completed',
            sessionId,
            fileId: file.id,
            bytes: result.bytesCopied,
            checksum: result.checksum,
            occurredAt: now(),
          });
        }
      } catch (error) {
        if (error instanceof FatalIngestError) throw error;
        if (
          (error instanceof DOMException && error.name === 'AbortError') ||
          dependencies.signal?.aborted === true
        ) {
          throw new DOMException('Ingest cancelled', 'AbortError');
        }
        const failure = errorFacts(error);
        if (failure.code === 'DATABASE_FAILED' || failure.code === 'SOURCE_UNAVAILABLE') {
          throw new FatalIngestError(
            failure.code === 'DATABASE_FAILED' ? 'DATABASE_FAILED' : 'SOURCE_UNAVAILABLE',
            failure.message,
            { cause: error },
          );
        }
        await dependencies.markFileFailed(file.id, failure.code, failure.message, now());
        failedFiles += 1;
        emit({
          type: 'file-status',
          sessionId,
          fileId: file.id,
          status: 'failed',
          occurredAt: now(),
        });
        await ignoreFailure(
          async () =>
            dependencies.log?.({
              phase: 'copy',
              message: 'File transfer failed',
              errorCode: failure.code,
              errorMessage: failure.message,
            }) ?? Promise.resolve(),
        );
      }
      await ignoreFailure(() => dependencies.snapshotManifest(sessionId));
    };
    let nextIndex = 0;
    let fatal: unknown;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (fatal !== undefined) throw fatal;
        const index = nextIndex;
        nextIndex += 1;
        const file = queued[index];
        if (file === undefined) return;
        try {
          await processFile(file);
        } catch (error) {
          fatal = error;
          throw error;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(copyConcurrency, Math.max(queued.length, 1)) }, () => worker()),
    );

    await setStatus('verifying');
    await setStatus('completed');
    await ignoreFailure(() => dependencies.snapshotManifest(sessionId));
    return {
      sessionId,
      status: 'completed',
      completedFiles,
      failedFiles,
      skippedFiles,
      collisions,
    };
  } catch (error) {
    const cancelled =
      (error instanceof DOMException && error.name === 'AbortError') ||
      dependencies.signal?.aborted === true;
    const failure = cancelled
      ? { code: 'INGEST_CANCELLED', message: 'Ingest cancelled' }
      : error instanceof FatalIngestError
        ? { code: error.code, message: error.message }
        : {
            code: 'DATABASE_FAILED',
            message: error instanceof Error ? error.message : String(error),
          };
    if (sessionCreated) {
      try {
        await setStatus(cancelled ? 'cancelled' : 'failed', failure);
      } catch {
        // A database outage can prevent the final status write; prior durable state remains resumable.
      }
      await ignoreFailure(() => dependencies.snapshotManifest(sessionId));
    }
    return {
      sessionId,
      status: cancelled ? 'cancelled' : 'failed',
      completedFiles,
      failedFiles,
      skippedFiles,
      collisions,
    };
  }
}

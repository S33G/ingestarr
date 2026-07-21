import { createHash } from 'node:crypto';
import path from 'node:path';

import { hashFile } from './hashing.js';

export interface SourceStatFacts {
  sizeBytes: number;
  modifiedAtMs: number;
  fileId?: string;
}

export interface TransferFileSystem {
  dirname(value: string): string;
  basename(value: string): string;
  joinPath(parent: string, segment: string): string;
  realpath(value: string): Promise<string>;
  mkdir(value: string): Promise<unknown>;
  lstat(
    value: string,
  ): Promise<
    | { exists: false }
    | { exists: true; kind: 'file' | 'directory' | 'symlink' | 'other'; fileId?: string }
  >;
  stat(value: string): Promise<SourceStatFacts & { kind?: string }>;
  openRead(value: string, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  createExclusive(value: string): Promise<{
    write(chunk: Uint8Array): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
  remove(value: string): Promise<void>;
  promoteVerifiedNoReplace(
    tempPath: string,
    destinationPath: string,
  ): Promise<
    | { status: 'collision' }
    | {
        status: 'committed';
        mode: 'atomic-link' | 'exclusive-copy';
        cleanupWarning?: {
          code: 'TEMP_CLEANUP_FAILED' | 'TEMP_CLEANUP_SYNC_FAILED';
          message: string;
          temporaryPath: string;
        };
      }
  >;
  syncDirectory(value: string): Promise<void>;
}

export interface CopyJob {
  id: string;
  sessionId: string;
  sourcePath: string;
  destinationRoot: string;
  destinationPath: string;
  expectedBytes: number;
  expectedChecksum?: string;
  expectedSource: SourceStatFacts;
}

export type CopyLifecycleEvent =
  | { type: 'planned'; jobId: string; at: string }
  | { type: 'started'; jobId: string; at: string }
  | { type: 'progress'; jobId: string; bytes: number; at: string }
  | { type: 'verified'; jobId: string; bytes: number; checksum: string; at: string }
  | { type: 'failed'; jobId: string; code: string; message: string; at: string };

export interface CopyLifecycle {
  plan(job: CopyJob, at: string): Promise<unknown>;
  markStarted(id: string, at: string): Promise<unknown>;
  updateProgress(id: string, copiedBytes: number, at: string): Promise<unknown>;
  markVerified(id: string, copiedBytes: number, checksum: string, at: string): Promise<unknown>;
  markFailed(id: string, errorCode: string, errorMessage: string, at: string): Promise<unknown>;
}

export interface CopyAndVerifyOptions {
  fileSystem: TransferFileSystem;
  lifecycle: CopyLifecycle;
  now?: () => string;
  signal?: AbortSignal;
  progressIntervalBytes?: number;
  temporaryRetention?: 'delete' | 'retain-on-recoverable';
}

export interface CopyCleanupWarning {
  code: 'TEMP_CLEANUP_FAILED' | 'TEMP_CLEANUP_SYNC_FAILED';
  message: string;
  temporaryPath: string;
}

export type CopyAndVerifyResult =
  | {
      status: 'completed';
      jobId: string;
      bytesCopied: number;
      checksum: string;
      completedAt: string;
      promotionMode: 'atomic-link' | 'exclusive-copy';
      cleanupWarning?: CopyCleanupWarning;
    }
  | {
      status: 'collision';
      jobId: string;
      destinationPath: string;
      reason: 'destination-exists';
      cleanupWarning?: CopyCleanupWarning;
    };

export class CopyTransferError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions & {
      recoverable?: boolean;
      temporaryPath?: string;
      provisionalFinalPath?: string;
      cleanupWarning?: unknown;
    },
  ) {
    super(message, options);
    this.name = 'CopyTransferError';
    this.recoverable = options?.recoverable ?? true;
    this.temporaryPath = options?.temporaryPath;
    this.provisionalFinalPath = options?.provisionalFinalPath;
    this.cleanupWarning = options?.cleanupWarning;
  }

  readonly recoverable: boolean;
  readonly temporaryPath?: string;
  readonly provisionalFinalPath?: string;
  readonly cleanupWarning?: unknown;
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new CopyTransferError('COPY_CANCELLED', 'Copy cancelled', { recoverable: true });
  }
}

function validateTemporaryIdentifier(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.length > 128 ||
    value === '.' ||
    value === '..' ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new CopyTransferError(
      'INVALID_TEMP_IDENTIFIER',
      `${label} is not safe for a temporary filename`,
      { recoverable: false },
    );
  }
}

function nativeErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

function sourceFailure(error: unknown, message: string): CopyTransferError {
  return ['ENOENT', 'ENODEV', 'EIO'].includes(nativeErrorCode(error) ?? '')
    ? new CopyTransferError('SOURCE_UNAVAILABLE', message, { cause: error })
    : new CopyTransferError('READ_FAILED', message, { cause: error });
}

function sameFacts(left: SourceStatFacts, right: SourceStatFacts): boolean {
  return (
    left.sizeBytes === right.sizeBytes &&
    left.modifiedAtMs === right.modifiedAtMs &&
    (left.fileId === undefined || right.fileId === undefined || left.fileId === right.fileId)
  );
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

function verifyLexicalContainment(destinationRoot: string, candidate: string): void {
  const lexicalRoot = path.resolve(destinationRoot);
  const lexicalCandidate = path.resolve(candidate);
  if (!isInside(lexicalRoot, lexicalCandidate)) {
    throw new CopyTransferError('DESTINATION_OUTSIDE_ROOT', 'Destination escaped its root', {
      recoverable: false,
    });
  }
}

async function verifyContainment(
  fs: TransferFileSystem,
  destinationRoot: string,
  candidate: string,
): Promise<void> {
  const lexicalRoot = path.resolve(destinationRoot);
  const lexicalCandidate = path.resolve(candidate);
  const canonicalRoot = await fs.realpath(destinationRoot);
  const rootFacts = await fs.lstat(canonicalRoot);
  if (!rootFacts.exists || rootFacts.kind !== 'directory') {
    throw new CopyTransferError('DESTINATION_ROOT_INVALID', 'Destination root is not a directory');
  }
  verifyLexicalContainment(lexicalRoot, lexicalCandidate);

  let ancestor = lexicalCandidate;
  const missing: string[] = [];
  while (ancestor !== lexicalRoot) {
    const facts = await fs.lstat(ancestor);
    if (facts.exists) {
      const canonicalAncestor = await fs.realpath(ancestor);
      const resolved = path.resolve(canonicalAncestor, ...missing.reverse());
      if (!isInside(canonicalRoot, resolved)) {
        throw new CopyTransferError(
          'DESTINATION_OUTSIDE_ROOT',
          'Destination ancestor resolves outside its root',
        );
      }
      return;
    }
    missing.push(fs.basename(ancestor));
    const parent = fs.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const projected = path.resolve(canonicalRoot, ...missing.reverse());
  if (!isInside(canonicalRoot, projected)) {
    throw new CopyTransferError(
      'DESTINATION_OUTSIDE_ROOT',
      'Could not establish destination containment',
    );
  }
}

function stableError(error: unknown): CopyTransferError {
  if (error instanceof CopyTransferError) return error;
  if (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  ) {
    return new CopyTransferError('COPY_CANCELLED', 'Copy cancelled', { cause: error });
  }
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  return new CopyTransferError(
    code === 'EEXIST'
      ? 'TEMP_COLLISION'
      : code === 'EIO'
        ? 'COPY_IO_FAILED'
        : code === 'PROMOTION_PROVISIONAL_FAILED'
          ? code
          : 'COPY_FAILED',
    error instanceof Error ? error.message : String(error),
    {
      cause: error,
      ...(code === 'PROMOTION_PROVISIONAL_FAILED' &&
      typeof error === 'object' &&
      error !== null &&
      'provisionalFinalPath' in error &&
      typeof error.provisionalFinalPath === 'string'
        ? { provisionalFinalPath: error.provisionalFinalPath }
        : {}),
      ...(typeof error === 'object' &&
      error !== null &&
      'cleanupWarning' in error &&
      error.cleanupWarning !== undefined
        ? { cleanupWarning: error.cleanupWarning }
        : {}),
    },
  );
}

async function persistLifecycle(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    throw new CopyTransferError('DATABASE_FAILED', 'Copy lifecycle persistence failed', {
      cause: error,
      recoverable: false,
    });
  }
}

async function cleanupTemporary(
  fs: TransferFileSystem,
  temporaryPath: string,
  directory: string,
): Promise<CopyCleanupWarning | undefined> {
  try {
    await fs.remove(temporaryPath);
  } catch (error) {
    return {
      code: 'TEMP_CLEANUP_FAILED',
      message: error instanceof Error ? error.message : String(error),
      temporaryPath,
    };
  }
  try {
    await fs.syncDirectory(directory);
    return undefined;
  } catch (error) {
    return {
      code: 'TEMP_CLEANUP_SYNC_FAILED',
      message: error instanceof Error ? error.message : String(error),
      temporaryPath,
    };
  }
}

export async function copyAndVerify(
  job: CopyJob,
  options: CopyAndVerifyOptions,
): Promise<CopyAndVerifyResult> {
  const fs = options.fileSystem;
  const now = options.now ?? (() => new Date().toISOString());
  const progressInterval = options.progressIntervalBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(job.expectedBytes) || job.expectedBytes < 0) {
    throw new RangeError('Expected bytes must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(progressInterval) || progressInterval < 1) {
    throw new RangeError('Progress interval must be a positive safe integer');
  }

  abortIfRequested(options.signal);
  validateTemporaryIdentifier(job.sessionId, 'Session id');
  validateTemporaryIdentifier(job.id, 'Copy id');
  const destinationDirectory = fs.dirname(job.destinationPath);
  const tempPath = fs.joinPath(
    destinationDirectory,
    `.${fs.basename(job.destinationPath)}.${job.sessionId}.${job.id}.tmp`,
  );
  verifyLexicalContainment(job.destinationRoot, destinationDirectory);
  verifyLexicalContainment(job.destinationRoot, job.destinationPath);
  verifyLexicalContainment(job.destinationRoot, tempPath);

  await persistLifecycle(() => options.lifecycle.plan(job, now()));
  await persistLifecycle(() => options.lifecycle.markStarted(job.id, now()));
  let temporaryCreated = false;
  let writer: Awaited<ReturnType<TransferFileSystem['createExclusive']>> | undefined;
  try {
    await verifyContainment(fs, job.destinationRoot, destinationDirectory);
    await verifyContainment(fs, job.destinationRoot, job.destinationPath);
    await verifyContainment(fs, job.destinationRoot, tempPath);
    abortIfRequested(options.signal);
    let before: SourceStatFacts;
    try {
      before = await fs.stat(job.sourcePath);
    } catch (error) {
      throw sourceFailure(error, 'Source is unavailable before copy');
    }
    if (!sameFacts(before, job.expectedSource) || before.sizeBytes !== job.expectedBytes) {
      throw new CopyTransferError(
        'SOURCE_MUTATED',
        'Source facts changed after scan and before copy',
      );
    }

    await fs.mkdir(destinationDirectory);
    await verifyContainment(fs, job.destinationRoot, destinationDirectory);
    await verifyContainment(fs, job.destinationRoot, job.destinationPath);
    await verifyContainment(fs, job.destinationRoot, tempPath);
    try {
      writer = await fs.createExclusive(tempPath);
      temporaryCreated = true;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EEXIST'
      ) {
        throw new CopyTransferError('TEMP_COLLISION', 'Session temporary file already exists', {
          cause: error,
        });
      }
      throw error;
    }

    const sourceHash = createHash('sha256');
    let bytes = 0;
    let nextProgress = progressInterval;
    try {
      for await (const chunk of fs.openRead(job.sourcePath, options.signal)) {
        abortIfRequested(options.signal);
        try {
          await writer.write(chunk);
        } catch (error) {
          throw new CopyTransferError('WRITE_FAILED', 'Could not write temporary copy', {
            cause: error,
          });
        }
        sourceHash.update(chunk);
        bytes += chunk.byteLength;
        if (bytes >= nextProgress) {
          await persistLifecycle(() => options.lifecycle.updateProgress(job.id, bytes, now()));
          nextProgress = bytes + progressInterval;
        }
      }
    } catch (error) {
      const failure = stableError(error);
      if (['ENOENT', 'ENODEV', 'EIO'].includes(nativeErrorCode(error) ?? '')) {
        throw new CopyTransferError(
          'SOURCE_UNAVAILABLE',
          'Source became unavailable while copying',
          {
            cause: error,
          },
        );
      }
      throw failure.code === 'COPY_FAILED'
        ? new CopyTransferError('READ_FAILED', 'Could not read source file', { cause: error })
        : failure;
    }
    if (bytes !== job.expectedBytes) {
      throw new CopyTransferError('SIZE_MISMATCH', 'Copied bytes do not match the expected size');
    }
    try {
      await writer.sync();
    } catch (error) {
      throw new CopyTransferError('FSYNC_FAILED', 'Could not flush copied data', { cause: error });
    }
    await writer.close();
    writer = undefined;

    let after: SourceStatFacts;
    try {
      after = await fs.stat(job.sourcePath);
    } catch (error) {
      throw sourceFailure(error, 'Source is unavailable after copy');
    }
    if (!sameFacts(before, after)) {
      throw new CopyTransferError('SOURCE_MUTATED', 'Source changed while it was being copied');
    }
    const sourceChecksum = sourceHash.digest('hex');
    if (
      job.expectedChecksum !== undefined &&
      sourceChecksum.toLowerCase() !== job.expectedChecksum.toLowerCase()
    ) {
      throw new CopyTransferError('CHECKSUM_MISMATCH', 'Source checksum differs from expected');
    }
    let destinationHash: Awaited<ReturnType<typeof hashFile>>;
    try {
      destinationHash = await hashFile(fs, tempPath, options.signal);
    } catch (error) {
      throw new CopyTransferError(
        'VERIFY_READ_FAILED',
        'Could not independently hash temporary file',
        {
          cause: error,
        },
      );
    }
    if (destinationHash.bytes !== bytes || destinationHash.checksum !== sourceChecksum) {
      throw new CopyTransferError(
        'CHECKSUM_MISMATCH',
        'Temporary copy checksum does not match source',
      );
    }

    await verifyContainment(fs, job.destinationRoot, destinationDirectory);
    await verifyContainment(fs, job.destinationRoot, job.destinationPath);
    await verifyContainment(fs, job.destinationRoot, tempPath);
    const promotion = await fs.promoteVerifiedNoReplace(tempPath, job.destinationPath);
    if (promotion.status === 'collision') {
      const cleanupWarning = await cleanupTemporary(fs, tempPath, destinationDirectory);
      temporaryCreated = false;
      await persistLifecycle(() =>
        options.lifecycle.markFailed(
          job.id,
          'DESTINATION_COLLISION',
          'Destination appeared before promotion; replanning is required',
          now(),
        ),
      );
      return {
        status: 'collision',
        jobId: job.id,
        destinationPath: job.destinationPath,
        reason: 'destination-exists',
        ...(cleanupWarning === undefined ? {} : { cleanupWarning }),
      };
    }
    temporaryCreated = false;
    const completedAt = now();
    await persistLifecycle(() =>
      options.lifecycle.markVerified(job.id, bytes, sourceChecksum, completedAt),
    );
    return {
      status: 'completed',
      jobId: job.id,
      bytesCopied: bytes,
      checksum: sourceChecksum,
      completedAt,
      promotionMode: promotion.mode,
      ...(promotion.cleanupWarning === undefined
        ? {}
        : { cleanupWarning: promotion.cleanupWarning }),
    };
  } catch (error) {
    const failure = stableError(error);
    let cleanupWarning = failure.cleanupWarning;
    if (writer !== undefined) {
      try {
        await writer.close();
      } catch {
        // The original failure remains authoritative.
      }
    }
    const retain =
      options.temporaryRetention === 'retain-on-recoverable' &&
      failure.recoverable &&
      failure.code !== 'COPY_CANCELLED';
    if (temporaryCreated && !retain) {
      const cleanupResult = await cleanupTemporary(fs, tempPath, destinationDirectory);
      if (cleanupWarning === undefined && cleanupResult !== undefined) {
        cleanupWarning = cleanupResult;
      }
    }
    await persistLifecycle(() =>
      options.lifecycle.markFailed(job.id, failure.code, failure.message, now()),
    );
    throw new CopyTransferError(failure.code, failure.message, {
      cause: failure,
      recoverable: failure.recoverable,
      ...(temporaryCreated && retain ? { temporaryPath: tempPath } : {}),
      ...(failure.provisionalFinalPath === undefined
        ? {}
        : { provisionalFinalPath: failure.provisionalFinalPath }),
      ...(cleanupWarning === undefined ? {} : { cleanupWarning }),
    });
  }
}

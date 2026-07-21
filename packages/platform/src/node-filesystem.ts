import { createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import {
  copyFile,
  constants,
  link,
  lstat as nodeLstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  stat as nodeStat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

export type NodeTraversalEntryKind = 'file' | 'directory' | 'symlink' | 'other';

function kindOf(value: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): NodeTraversalEntryKind {
  if (value.isFile()) return 'file';
  if (value.isDirectory()) return 'directory';
  if (value.isSymbolicLink()) return 'symlink';
  return 'other';
}

async function traversalStats(operation: typeof nodeStat | typeof nodeLstat, value: string) {
  const stats = await operation(value);
  return {
    kind: kindOf(stats),
    sizeBytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    ...(stats.birthtimeMs > 0 ? { birthtime: stats.birthtime.toISOString() } : {}),
    ...(stats.ino === 0 ? {} : { fileId: `${String(stats.dev)}:${String(stats.ino)}` }),
  };
}

export const nodeTraversalFileSystem = {
  realpath,
  joinPath: path.join,
  async *openDirectory(value: string) {
    const directory = await opendir(value);
    for await (const entry of directory) {
      yield { name: entry.name, kind: kindOf(entry) };
    }
  },
  lstat: (value: string) => traversalStats(nodeLstat, value),
  stat: (value: string) => traversalStats(nodeStat, value),
};

export const nodeDestinationFileSystem = {
  async lstat(
    value: string,
  ): Promise<
    { exists: false } | { exists: true; kind: 'file' | 'directory' | 'symlink' | 'other' }
  > {
    try {
      const stats = await nodeLstat(value);
      return { exists: true, kind: kindOf(stats) };
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return { exists: false };
      }
      throw error;
    }
  },
  realpath,
};

function transferStats(stats: Stats) {
  return {
    kind: kindOf(stats),
    sizeBytes: stats.size,
    modifiedAtMs: stats.mtimeMs,
    ...(stats.ino === 0 ? {} : { fileId: `${String(stats.dev)}:${String(stats.ino)}` }),
  };
}

async function exists(value: string): Promise<boolean> {
  try {
    await nodeLstat(value);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export interface PromotionCleanupWarning {
  code: 'TEMP_CLEANUP_FAILED' | 'TEMP_CLEANUP_SYNC_FAILED';
  message: string;
  temporaryPath: string;
}

export type VerifiedPromotionResult =
  | { status: 'collision' }
  | {
      status: 'committed';
      mode: 'atomic-link' | 'exclusive-copy';
      cleanupWarning?: PromotionCleanupWarning;
    };

export interface PromotionOperations {
  link(tempPath: string, destinationPath: string): Promise<void>;
  copyExclusive(tempPath: string, destinationPath: string): Promise<void>;
  syncFile(value: string): Promise<void>;
  syncDirectory(value: string): Promise<void>;
  unlink(value: string): Promise<void>;
  remove(value: string): Promise<void>;
}

export class PromotionFailure extends Error {
  constructor(
    message: string,
    public readonly provisionalFinalPath: string,
    public readonly cleanupWarning?: {
      code: 'PROVISIONAL_CLEANUP_FAILED' | 'PROVISIONAL_CLEANUP_SYNC_FAILED';
      message: string;
      path: string;
    },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PromotionFailure';
  }

  readonly code = 'PROMOTION_PROVISIONAL_FAILED';
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function syncNodeFile(value: string): Promise<void> {
  const handle = await open(value, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncNodeDirectory(value: string): Promise<void> {
  const handle = await open(value, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const nodePromotionOperations: PromotionOperations = {
  link,
  copyExclusive: (tempPath, destinationPath) =>
    copyFile(tempPath, destinationPath, constants.COPYFILE_EXCL),
  syncFile: syncNodeFile,
  syncDirectory: syncNodeDirectory,
  unlink,
  remove: (value) => rm(value, { force: true }),
};

async function cleanupWarning(
  operations: PromotionOperations,
  temporaryPath: string,
  directory: string,
): Promise<PromotionCleanupWarning | undefined> {
  try {
    await operations.unlink(temporaryPath);
  } catch (error) {
    return {
      code: 'TEMP_CLEANUP_FAILED',
      message: errorMessage(error),
      temporaryPath,
    };
  }
  try {
    await operations.syncDirectory(directory);
    return undefined;
  } catch (error) {
    return {
      code: 'TEMP_CLEANUP_SYNC_FAILED',
      message: errorMessage(error),
      temporaryPath,
    };
  }
}

async function removeProvisional(
  operations: PromotionOperations,
  destinationPath: string,
  directory: string,
): Promise<PromotionFailure['cleanupWarning']> {
  try {
    await operations.remove(destinationPath);
  } catch (error) {
    return {
      code: 'PROVISIONAL_CLEANUP_FAILED',
      message: errorMessage(error),
      path: destinationPath,
    };
  }
  try {
    await operations.syncDirectory(directory);
    return undefined;
  } catch (error) {
    return {
      code: 'PROVISIONAL_CLEANUP_SYNC_FAILED',
      message: errorMessage(error),
      path: destinationPath,
    };
  }
}

export async function promoteVerifiedNoReplace(
  tempPath: string,
  destinationPath: string,
  operations: PromotionOperations = nodePromotionOperations,
): Promise<VerifiedPromotionResult> {
  const directory = path.dirname(destinationPath);
  try {
    await operations.link(tempPath, destinationPath);
    try {
      await operations.syncDirectory(directory);
    } catch (error) {
      const warning = await removeProvisional(operations, destinationPath, directory);
      throw new PromotionFailure(
        'Atomic promotion directory fsync failed',
        destinationPath,
        warning,
        { cause: error },
      );
    }
    const warning = await cleanupWarning(operations, tempPath, directory);
    return {
      status: 'committed',
      mode: 'atomic-link',
      ...(warning === undefined ? {} : { cleanupWarning: warning }),
    };
  } catch (error) {
    if (error instanceof PromotionFailure) throw error;
    if (errorCode(error) === 'EEXIST') return { status: 'collision' };
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(errorCode(error) ?? '')) throw error;
  }

  let provisional = false;
  try {
    provisional = true;
    await operations.copyExclusive(tempPath, destinationPath);
    await operations.syncFile(destinationPath);
    await operations.syncDirectory(directory);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return { status: 'collision' };
    const warning = provisional
      ? await removeProvisional(operations, destinationPath, directory)
      : undefined;
    throw new PromotionFailure(
      'Exclusive-copy promotion failed before durable commit',
      destinationPath,
      warning,
      { cause: error },
    );
  }
  const warning = await cleanupWarning(operations, tempPath, directory);
  return {
    status: 'committed',
    mode: 'exclusive-copy',
    ...(warning === undefined ? {} : { cleanupWarning: warning }),
  };
}

export const nodeTransferFileSystem = {
  joinPath: path.join,
  dirname: path.dirname,
  basename: path.basename,
  realpath,
  mkdir: (value: string) => mkdir(value, { recursive: true }),
  async lstat(value: string) {
    try {
      return { exists: true as const, ...(await traversalStats(nodeLstat, value)) };
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return { exists: false as const };
      }
      throw error;
    }
  },
  async stat(value: string) {
    return transferStats(await nodeStat(value));
  },
  async *openRead(value: string, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    const stream = createReadStream(value, { highWaterMark: 256 * 1024, signal });
    for await (const chunk of stream) {
      yield chunk as Buffer;
    }
  },
  async createExclusive(value: string) {
    const handle = await open(value, 'wx', 0o600);
    return {
      async write(chunk: Uint8Array) {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle.write(chunk, offset);
          if (bytesWritten === 0) throw new Error('Zero-byte write');
          offset += bytesWritten;
        }
      },
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  remove: (value: string) => rm(value, { force: true }),
  promoteVerifiedNoReplace,
  async replaceAtomic(tempPath: string, destinationPath: string) {
    await rename(tempPath, destinationPath);
  },
  async syncDirectory(value: string) {
    await syncNodeDirectory(value);
  },
  async listDirectory(value: string): Promise<string[]> {
    if (!(await exists(value))) return [];
    const directory = await opendir(value);
    const names: string[] = [];
    for await (const entry of directory) names.push(entry.name);
    return names.sort();
  },
};

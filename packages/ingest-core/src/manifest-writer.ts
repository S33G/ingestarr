import { randomUUID } from 'node:crypto';

export interface ManifestState {
  session: {
    id: string;
    sourceId: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  };
  source: { id: string; kind: string; displayName: string };
  files: Array<{
    id: string;
    relativePath: string;
    sizeBytes: number;
    modifiedAt: string;
    status: string;
    checksum: string | null;
    destinationPath: string | null;
    copiedBytes: number;
    errorCode: string | null;
    errorMessage: string | null;
  }>;
}

export interface ManifestRepository {
  loadManifest(sessionId: string): Promise<ManifestState>;
}

export interface ManifestFileSystem {
  dirname(value: string): string;
  basename(value: string): string;
  joinPath(parent: string, segment: string): string;
  createExclusive(value: string): Promise<{
    write(chunk: Uint8Array): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
  remove(value: string): Promise<void>;
  replaceAtomic(tempPath: string, destinationPath: string): Promise<void>;
  syncDirectory(value: string): Promise<void>;
}

export interface ManifestWriterOptions {
  manifestPath: string;
  sessionId: string;
  repository: ManifestRepository;
  fileSystem: ManifestFileSystem;
  now?: () => string;
  uniqueId?: () => string;
}

export interface ManifestWriter {
  snapshot(): Promise<void>;
}

export function createManifestWriter(options: ManifestWriterOptions): ManifestWriter {
  let running: Promise<void> | undefined;
  let requested = false;
  const now = options.now ?? (() => new Date().toISOString());
  const uniqueId = options.uniqueId ?? randomUUID;

  async function writeOne(): Promise<void> {
    const state = await options.repository.loadManifest(options.sessionId);
    if (state.session.id !== options.sessionId || state.source.id !== state.session.sourceId) {
      throw new Error('Manifest repository returned inconsistent session state');
    }
    const document = {
      schemaVersion: 1,
      generatedAt: now(),
      session: state.session,
      source: state.source,
      files: state.files,
    };
    const bytes = new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
    const fs = options.fileSystem;
    const directory = fs.dirname(options.manifestPath);
    const temporaryPath = fs.joinPath(
      directory,
      `.${fs.basename(options.manifestPath)}.${options.sessionId}.${uniqueId()}.tmp`,
    );
    let handle: Awaited<ReturnType<ManifestFileSystem['createExclusive']>> | undefined;
    let temporaryExists = false;
    try {
      handle = await fs.createExclusive(temporaryPath);
      temporaryExists = true;
      await handle.write(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;

      await fs.replaceAtomic(temporaryPath, options.manifestPath);
      temporaryExists = false;
      await fs.syncDirectory(directory);
    } finally {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          // Preserve the snapshot error.
        }
      }
      if (temporaryExists) {
        try {
          await fs.remove(temporaryPath);
          await fs.syncDirectory(directory);
        } catch {
          // Preserve the snapshot error and the prior valid manifest.
        }
      }
    }
  }

  return {
    snapshot(): Promise<void> {
      requested = true;
      if (running !== undefined) return running;
      running = (async () => {
        while (requested) {
          requested = false;
          await writeOne();
        }
      })().finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}

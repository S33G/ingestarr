import { createHash } from 'node:crypto';

export interface HashReadFileSystem {
  openRead(path: string, signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException('Hashing aborted', 'AbortError');
}

export async function hashChunks(
  chunks: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<{ checksum: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of chunks) {
    abortIfRequested(signal);
    hash.update(chunk);
    bytes += chunk.byteLength;
    if (!Number.isSafeInteger(bytes)) throw new RangeError('Hashed byte count exceeds safe range');
  }
  abortIfRequested(signal);
  return { checksum: hash.digest('hex'), bytes };
}

export function hashFile(
  fileSystem: HashReadFileSystem,
  path: string,
  signal?: AbortSignal,
): Promise<{ checksum: string; bytes: number }> {
  return hashChunks(fileSystem.openRead(path, signal), signal);
}

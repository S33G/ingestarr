import path from 'node:path';

export const DEFAULT_MEDIA_EXTENSIONS = [
  '.3gp',
  '.arw',
  '.avi',
  '.cr2',
  '.cr3',
  '.dng',
  '.heic',
  '.heif',
  '.jpeg',
  '.jpg',
  '.m2ts',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.mts',
  '.nef',
  '.orf',
  '.pef',
  '.png',
  '.raf',
  '.raw',
  '.rw2',
  '.srw',
  '.tif',
  '.tiff',
  '.webm',
] as const;

export const DEFAULT_EXCLUDED_DIRECTORY_NAMES = [
  '.fseventsd',
  '.spotlight-v100',
  '.temporaryitems',
  '.trashes',
  '$recycle.bin',
  'system volume information',
] as const;

export type TraversalEntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface TraversalDirectoryEntry {
  name: string;
  kind: TraversalEntryKind;
}

export interface TraversalStats {
  kind: TraversalEntryKind;
  sizeBytes?: number;
  modifiedAt?: string;
  birthtime?: string;
  fileId?: string;
}

export interface TraversalFileSystem {
  realpath(value: string): Promise<string>;
  joinPath(parent: string, segment: string): string;
  openDirectory(value: string): AsyncIterable<TraversalDirectoryEntry>;
  lstat(value: string): Promise<TraversalStats>;
  stat(value: string): Promise<TraversalStats>;
}

export interface ScannedMediaFile {
  /** Ephemeral path for this scan only; never persist as source identity. */
  absolutePath: string;
  /** Lossless separator-normalized path used for persistence and reopening. */
  relativePath: string;
  pathSegments: readonly string[];
  /** NFC-normalized key used only for deterministic ordering and fingerprints. */
  canonicalPathKey: string;
  extension: string;
  sizeBytes: number;
  modifiedAt: string;
  birthtime?: string;
  fileId?: string;
}

export interface ScanEntryError {
  absolutePath: string;
  relativePath: string;
  code: string;
  message: string;
  recoverable: true;
}

export type ScanResult =
  { type: 'file'; file: ScannedMediaFile } | { type: 'error'; error: ScanEntryError };

export interface ScanMediaOptions {
  fileSystem: TraversalFileSystem;
  extensions?: readonly string[];
  excludedDirectoryNames?: readonly string[];
  includeHidden?: boolean;
  followSymlinks?: boolean;
  maxDepth?: number;
  maxEntries?: number;
  signal?: AbortSignal;
}

function compareRelativePath(left: string, right: string): number {
  const foldedLeft = left.toLocaleLowerCase('en-US');
  const foldedRight = right.toLocaleLowerCase('en-US');
  return foldedLeft < foldedRight
    ? -1
    : foldedLeft > foldedRight
      ? 1
      : left < right
        ? -1
        : left > right
          ? 1
          : 0;
}

export type SourcePathFlavor = 'canonical' | 'posix' | 'windows';

export function normalizeSourceRelativePath(value: string, flavor: SourcePathFlavor): string {
  if (
    (flavor === 'windows' && /^(?:[A-Za-z]:|[/\\])/.test(value)) ||
    (flavor !== 'windows' && value.startsWith('/'))
  ) {
    throw new Error(`Expected a source-relative path: ${value}`);
  }
  const separatorsNormalized = flavor === 'windows' ? value.replaceAll('\\', '/') : value;
  const normalized = path.posix.normalize(separatorsNormalized.replace(/^\.\/+/, ''));
  if (
    normalized === '' ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Expected a source-relative path: ${value}`);
  }
  return normalized;
}

export function canonicalizeSourceRelativePath(value: string, flavor: SourcePathFlavor): string {
  return normalizeSourceRelativePath(value, flavor)
    .split('/')
    .map((segment) => segment.normalize('NFC'))
    .join('/');
}

export function sourceRelativePathFromSegments(segments: readonly string[]): string {
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('/'),
    )
  ) {
    throw new Error('Source-relative path segments must be non-empty literal entry names');
  }
  return segments.join('/');
}

export function sourceRelativePathToSegments(relativePath: string): string[] {
  return normalizeSourceRelativePath(relativePath, 'canonical').split('/');
}

export function canonicalSourcePathKeyFromSegments(segments: readonly string[]): string {
  return sourceRelativePathFromSegments(segments.map((segment) => segment.normalize('NFC')));
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException('Media scan aborted', 'AbortError');
  }
}

function errorCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'SCAN_ENTRY_ERROR';
}

function recoverableError(
  absolutePath: string,
  relativePath: string,
  error: unknown,
  code = errorCode(error),
): ScanResult {
  return {
    type: 'error',
    error: {
      absolutePath,
      relativePath,
      code,
      message: error instanceof Error ? error.message : String(error),
      recoverable: true,
    },
  };
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export async function* scanMedia(
  selectedRoot: string,
  options: ScanMediaOptions,
): AsyncGenerator<ScanResult> {
  const fs = options.fileSystem;
  const root = await fs.realpath(selectedRoot);
  const rootStats = await fs.stat(root);
  if (rootStats.kind !== 'directory')
    throw new Error(`Media source root is not a directory: ${selectedRoot}`);

  const extensions = new Set(
    (options.extensions ?? DEFAULT_MEDIA_EXTENSIONS).map((extension) =>
      `.${extension.replace(/^\./, '')}`.toLocaleLowerCase('en-US'),
    ),
  );
  const exclusions = new Set(
    [...DEFAULT_EXCLUDED_DIRECTORY_NAMES, ...(options.excludedDirectoryNames ?? [])].map((name) =>
      name.toLocaleLowerCase('en-US'),
    ),
  );
  const maxDepth = options.maxDepth ?? 64;
  const maxEntries = options.maxEntries ?? 100_000;
  if (!Number.isInteger(maxDepth) || maxDepth < 0)
    throw new RangeError('maxDepth must be non-negative');
  if (!Number.isInteger(maxEntries) || maxEntries < 1)
    throw new RangeError('maxEntries must be positive');

  interface PendingEntry {
    absolutePath: string;
    relativePath: string;
    canonicalPathKey: string;
    pathSegments: string[];
    depth: number;
    isRoot?: true;
  }

  const comparePending = (left: PendingEntry, right: PendingEntry): number =>
    compareRelativePath(left.canonicalPathKey, right.canonicalPathKey) ||
    (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  const pending: PendingEntry[] = [];
  const pushPending = (value: PendingEntry): void => {
    pending.push(value);
    let index = pending.length - 1;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const parent = pending[parentIndex];
      const child = pending[index];
      if (parent === undefined || child === undefined || comparePending(parent, child) <= 0) break;
      pending[parentIndex] = child;
      pending[index] = parent;
      index = parentIndex;
    }
  };
  const popPending = (): PendingEntry | undefined => {
    const first = pending[0];
    const last = pending.pop();
    if (first === undefined || last === undefined || pending.length === 0) return first;
    pending[0] = last;
    let index = 0;
    while (true) {
      const leftIndex = index * 2 + 1;
      const rightIndex = leftIndex + 1;
      let smallestIndex = index;
      const smallest = pending[smallestIndex];
      const left = pending[leftIndex];
      const right = pending[rightIndex];
      if (smallest === undefined) break;
      if (left !== undefined && comparePending(left, smallest) < 0) smallestIndex = leftIndex;
      const currentSmallest = pending[smallestIndex];
      if (
        right !== undefined &&
        currentSmallest !== undefined &&
        comparePending(right, currentSmallest) < 0
      ) {
        smallestIndex = rightIndex;
      }
      if (smallestIndex === index) break;
      const replacement = pending[smallestIndex];
      if (replacement === undefined) break;
      pending[index] = replacement;
      pending[smallestIndex] = smallest;
      index = smallestIndex;
    }
    return first;
  };
  pushPending({
    absolutePath: root,
    relativePath: '',
    canonicalPathKey: '',
    pathSegments: [],
    depth: -1,
    isRoot: true,
  });
  const visitedDirectories = new Set<string>();
  let visitedEntries = 0;
  let limitReached = false;

  while (pending.length > 0 && !limitReached) {
    abortIfRequested(options.signal);
    const entry = popPending();
    if (entry === undefined) break;

    let stats: TraversalStats = rootStats;
    let canonicalTarget = entry.absolutePath;
    if (entry.isRoot !== true) {
      try {
        stats = await fs.lstat(entry.absolutePath);
      } catch (error) {
        yield recoverableError(entry.absolutePath, entry.relativePath, error);
        continue;
      }

      if (stats.kind === 'symlink') {
        if (options.followSymlinks !== true) continue;
        try {
          canonicalTarget = await fs.realpath(entry.absolutePath);
        } catch (error) {
          yield recoverableError(entry.absolutePath, entry.relativePath, error);
          continue;
        }
        if (!isInsideRoot(root, canonicalTarget)) {
          yield recoverableError(
            entry.absolutePath,
            entry.relativePath,
            new Error('Symbolic link resolves outside the selected source root'),
            'SYMLINK_OUTSIDE_ROOT',
          );
          continue;
        }
        try {
          stats = await fs.stat(entry.absolutePath);
        } catch (error) {
          yield recoverableError(entry.absolutePath, entry.relativePath, error);
          continue;
        }
      }
    }

    if (stats.kind === 'directory') {
      if (entry.isRoot !== true && entry.depth >= maxDepth) {
        yield recoverableError(
          entry.absolutePath,
          entry.relativePath,
          new Error(`Maximum traversal depth ${maxDepth} reached`),
          'DEPTH_LIMIT_REACHED',
        );
        continue;
      }
      if (visitedDirectories.has(canonicalTarget)) continue;
      visitedDirectories.add(canonicalTarget);

      try {
        for await (const child of fs.openDirectory(entry.absolutePath)) {
          abortIfRequested(options.signal);
          visitedEntries += 1;
          if (visitedEntries > maxEntries) {
            limitReached = true;
            break;
          }
          const foldedName = child.name.normalize('NFC').toLocaleLowerCase('en-US');
          if (
            (options.includeHidden !== true && child.name.startsWith('.')) ||
            ((child.kind === 'directory' || child.kind === 'symlink') && exclusions.has(foldedName))
          ) {
            continue;
          }
          if (
            child.kind === 'file' &&
            !extensions.has(path.extname(child.name).toLocaleLowerCase('en-US'))
          ) {
            continue;
          }
          if (!['file', 'directory', 'symlink'].includes(child.kind)) continue;
          const pathSegments = [...entry.pathSegments, child.name];
          const relativePath = sourceRelativePathFromSegments(pathSegments);
          pushPending({
            absolutePath: fs.joinPath(entry.absolutePath, child.name),
            relativePath,
            canonicalPathKey: canonicalSourcePathKeyFromSegments(pathSegments),
            pathSegments,
            depth: entry.depth + 1,
          });
        }
      } catch (error) {
        yield recoverableError(entry.absolutePath, entry.relativePath || '.', error);
        continue;
      }
      continue;
    }

    if (stats.kind !== 'file') continue;
    const extension = path.extname(entry.relativePath).toLocaleLowerCase('en-US');
    if (!extensions.has(extension)) continue;
    const file: ScannedMediaFile = {
      absolutePath: entry.absolutePath,
      relativePath: entry.relativePath,
      pathSegments: entry.pathSegments,
      canonicalPathKey: entry.canonicalPathKey,
      extension,
      sizeBytes: stats.sizeBytes ?? 0,
      modifiedAt: stats.modifiedAt ?? new Date(0).toISOString(),
    };
    if (stats.birthtime !== undefined) file.birthtime = stats.birthtime;
    if (stats.fileId !== undefined) file.fileId = stats.fileId;
    yield { type: 'file', file };
  }

  if (limitReached) {
    yield recoverableError(
      root,
      '.',
      new Error(`Maximum traversal entry count ${maxEntries} reached`),
      'ENTRY_LIMIT_REACHED',
    );
  }
}

import {
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  realpath,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  canonicalizeSourceRelativePath,
  DEFAULT_MEDIA_EXTENSIONS,
  normalizeSourceRelativePath,
  scanMedia,
  sourceRelativePathToSegments,
  type ScanMediaOptions,
  type ScanResult,
  type TraversalDirectoryEntry,
  type TraversalFileSystem,
  type TraversalStats,
} from './scan-media.js';
import { computeQuickFingerprint } from './quick-fingerprint.js';

function entryKind(entry: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): TraversalDirectoryEntry['kind'] {
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'directory';
  if (entry.isSymbolicLink()) return 'symlink';
  return 'other';
}

function mapStats(value: Awaited<ReturnType<typeof stat>>): TraversalStats {
  return {
    kind: entryKind(value),
    sizeBytes: value.size,
    modifiedAt: value.mtime.toISOString(),
    ...(value.birthtimeMs > 0 ? { birthtime: value.birthtime.toISOString() } : {}),
    ...(value.ino === 0 ? {} : { fileId: `${String(value.dev)}:${String(value.ino)}` }),
  };
}

const testFileSystem: TraversalFileSystem = {
  realpath,
  joinPath: path.join,
  async *openDirectory(value) {
    const directory = await opendir(value);
    for await (const entry of directory) yield { name: entry.name, kind: entryKind(entry) };
  },
  lstat: async (value) => mapStats(await lstat(value)),
  stat: async (value) => mapStats(await stat(value)),
};

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-scan-'));
  await mkdir(path.join(root, 'DCIM', 'B'), { recursive: true });
  await mkdir(path.join(root, '.Trashes'), { recursive: true });
  await mkdir(path.join(root, 'System Volume Information'), { recursive: true });
  await writeFile(path.join(root, 'DCIM', 'B', 'z.MP4'), 'video');
  await writeFile(path.join(root, 'DCIM', 'a.jpg'), 'photo');
  await writeFile(path.join(root, 'root.HEIC'), 'photo');
  await writeFile(path.join(root, 'ignore.txt'), 'text');
  await writeFile(path.join(root, '.Trashes', 'trash.jpg'), 'trash');
  return root;
}

async function collect(
  root: string,
  options: Omit<ScanMediaOptions, 'fileSystem'> & {
    fileSystem?: TraversalFileSystem;
  } = {},
): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  for await (const result of scanMedia(root, {
    ...options,
    fileSystem: options.fileSystem ?? testFileSystem,
  }))
    results.push(result);
  return results;
}

describe('scanMedia', () => {
  it('discovers recursively in deterministic normalized relative-path order', async () => {
    const results = await collect(await fixture());
    const files = results.filter((result) => result.type === 'file').map((result) => result.file);

    expect(files.map((file) => file.relativePath)).toEqual([
      'DCIM/a.jpg',
      'DCIM/B/z.MP4',
      'root.HEIC',
    ]);
    expect(files.every((file) => path.isAbsolute(file.absolutePath))).toBe(true);
    expect(files[0]).toMatchObject({ extension: '.jpg', sizeBytes: 5 });
    expect(DEFAULT_MEDIA_EXTENSIONS).toContain('.mp4');
  });

  it('supports a case-insensitive allowlist and configurable exclusions without assuming DCIM', async () => {
    const root = await fixture();
    await mkdir(path.join(root, 'DCIM', 'skip-me'));
    await writeFile(path.join(root, 'DCIM', 'skip-me', 'x.JpG'), 'x');

    const results = await collect(root, {
      extensions: ['JPG'],
      excludedDirectoryNames: ['skip-me'],
    });

    expect(
      results.filter((result) => result.type === 'file').map((result) => result.file.relativePath),
    ).toEqual(['DCIM/a.jpg']);
  });

  it('skips hidden media files by default and includes them only when configured', async () => {
    const root = await fixture();
    await writeFile(path.join(root, '.hidden.jpg'), 'hidden');

    expect(JSON.stringify(await collect(root))).not.toContain('.hidden.jpg');
    expect(JSON.stringify(await collect(root, { includeHidden: true }))).toContain('.hidden.jpg');
  });

  it('skips symlinks by default and does not escape root when following them', async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'ingestarr-outside-'));
    await writeFile(path.join(outside, 'secret.jpg'), 'secret');
    await symlink(outside, path.join(root, 'DCIM', 'escape'));
    await symlink(path.join(root, 'DCIM'), path.join(root, '.hidden-link'));

    const defaultResults = await collect(root);
    const followedResults = await collect(root, { followSymlinks: true });

    expect(JSON.stringify(defaultResults)).not.toContain('secret.jpg');
    expect(JSON.stringify(followedResults)).not.toContain('secret.jpg');
    expect(JSON.stringify(followedResults)).not.toContain('.hidden-link');
    expect(followedResults).toContainEqual(
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ code: 'SYMLINK_OUTSIDE_ROOT', recoverable: true }),
      }),
    );
  });

  it('honors AbortSignal and reports recoverable per-entry filesystem errors', async () => {
    const root = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(async () => collect(root, { signal: controller.signal })).rejects.toThrow(
      /aborted/i,
    );

    const results = await collect(root, {
      fileSystem: {
        ...testFileSystem,
        async *openDirectory(value) {
          if (value.endsWith(`${path.sep}DCIM`)) {
            throw Object.assign(new Error('denied'), { code: 'EACCES' });
          }
          yield* testFileSystem.openDirectory(value);
        },
      },
    });
    expect(results).toContainEqual(
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ code: 'EACCES', relativePath: 'DCIM' }),
      }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        type: 'file',
        file: expect.objectContaining({ relativePath: 'root.HEIC' }),
      }),
    );
  });

  it('normalizes Windows and POSIX relative paths and rejects traversal', () => {
    expect(normalizeSourceRelativePath(String.raw`DCIM\100MEDIA\IMG_1.JPG`, 'windows')).toBe(
      'DCIM/100MEDIA/IMG_1.JPG',
    );
    expect(normalizeSourceRelativePath('./DCIM//IMG_1.JPG', 'posix')).toBe('DCIM/IMG_1.JPG');
    expect(() => normalizeSourceRelativePath('../outside.jpg', 'posix')).toThrow(/relative path/i);
    expect(() => normalizeSourceRelativePath('C:\\outside.jpg', 'windows')).toThrow(
      /relative path/i,
    );
    expect(() => normalizeSourceRelativePath('C:outside.jpg', 'windows')).toThrow(/relative path/i);
    expect(() => normalizeSourceRelativePath('C:', 'windows')).toThrow(/relative path/i);
    expect(() =>
      normalizeSourceRelativePath(String.raw`\\server\share\image.jpg`, 'windows'),
    ).toThrow(/relative path/i);
    expect(normalizeSourceRelativePath(`DCIM/cafe\u0301.jpg`, 'posix')).toBe(`DCIM/cafe\u0301.jpg`);
    expect(canonicalizeSourceRelativePath(`DCIM/cafe\u0301.jpg`, 'posix')).toBe('DCIM/café.jpg');
    expect(normalizeSourceRelativePath(String.raw`album\photo.jpg`, 'posix')).toBe(
      String.raw`album\photo.jpg`,
    );
  });

  it('keeps a POSIX backslash filename distinct and reopenable from a nested path', async () => {
    const literalBackslash = String.raw`album\photo.jpg`;
    const opened: string[] = [];
    const results = await collect('/source', {
      fileSystem: {
        realpath: async () => '/source',
        joinPath: (parent, segment) => `${parent}/${segment}`,
        stat: async () => ({ kind: 'directory' }),
        async *openDirectory(value) {
          if (value === '/source') {
            yield { name: literalBackslash, kind: 'file' as const };
            yield { name: 'album', kind: 'directory' as const };
          } else {
            yield { name: 'photo.jpg', kind: 'file' as const };
          }
        },
        lstat: async (value) => {
          opened.push(value);
          return value === '/source/album'
            ? { kind: 'directory' }
            : {
                kind: 'file',
                sizeBytes: 5,
                modifiedAt: '2026-01-01T00:00:00.000Z',
              };
        },
      },
    });
    const files = results.filter((result) => result.type === 'file').map((result) => result.file);

    expect(
      files.map((file) => ({
        relativePath: file.relativePath,
        pathSegments: file.pathSegments,
        canonicalPathKey: file.canonicalPathKey,
      })),
    ).toEqual([
      {
        relativePath: 'album/photo.jpg',
        pathSegments: ['album', 'photo.jpg'],
        canonicalPathKey: 'album/photo.jpg',
      },
      {
        relativePath: literalBackslash,
        pathSegments: [literalBackslash],
        canonicalPathKey: literalBackslash,
      },
    ]);
    expect(opened).toEqual(
      expect.arrayContaining(['/source/album/photo.jpg', `/source/${literalBackslash}`]),
    );
    expect(sourceRelativePathToSegments(literalBackslash)).toEqual([literalBackslash]);
    expect(sourceRelativePathToSegments('album/photo.jpg')).toEqual(['album', 'photo.jpg']);
    expect(
      computeQuickFingerprint({
        relativePath: files[0]?.relativePath ?? '',
        canonicalPathKey: files[0]?.canonicalPathKey ?? '',
        sizeBytes: 5,
        modifiedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).not.toBe(
      computeQuickFingerprint({
        relativePath: files[1]?.relativePath ?? '',
        canonicalPathKey: files[1]?.canonicalPathKey ?? '',
        sizeBytes: 5,
        modifiedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
  });

  it('uses raw names as a deterministic tie-break for NFC-equivalent emitted paths', async () => {
    const decomposed = `cafe\u0301.jpg`;
    const composed = 'café.jpg';
    async function scanNames(names: string[]): Promise<number[]> {
      const results = await collect('/unicode', {
        fileSystem: {
          realpath: async () => '/unicode',
          joinPath: (parent, segment) => `${parent}/${segment}`,
          stat: async () => ({ kind: 'directory' }),
          async *openDirectory() {
            for (const name of names) yield { name, kind: 'file' as const };
          },
          lstat: async (value) => ({
            kind: 'file',
            sizeBytes: value.endsWith(decomposed) ? 1 : 2,
            modifiedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });
      expect(
        results
          .filter((result) => result.type === 'file')
          .map((result) => ({
            relativePath: result.file.relativePath,
            canonicalPathKey: result.file.canonicalPathKey,
          })),
      ).toEqual([
        { relativePath: decomposed, canonicalPathKey: composed },
        { relativePath: composed, canonicalPathKey: composed },
      ]);
      return results
        .filter((result) => result.type === 'file')
        .map((result) => result.file.sizeBytes);
    }

    await expect(scanNames([composed, decomposed])).resolves.toEqual([1, 2]);
    await expect(scanNames([decomposed, composed])).resolves.toEqual([1, 2]);
  });

  it('enforces traversal entry bounds as a recoverable scan error', async () => {
    const results = await collect(await fixture(), { maxEntries: 1 });
    expect(results.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'ENTRY_LIMIT_REACHED', recoverable: true },
    });
  });

  it('stops directory iteration before materializing more than the entry ceiling', async () => {
    let reads = 0;
    const results = await collect('/bounded', {
      maxEntries: 2,
      fileSystem: {
        realpath: async () => '/bounded',
        joinPath: (parent, segment) => `${parent}/${segment}`,
        stat: async () => ({ kind: 'directory' }),
        lstat: async () => ({ kind: 'file' }),
        async *openDirectory() {
          for (const name of ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']) {
            reads += 1;
            yield { name, kind: 'file' };
          }
        },
      },
    });

    expect(reads).toBe(3);
    expect(results.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'ENTRY_LIMIT_REACHED' },
    });
  });

  it('applies async-generator backpressure before traversing later directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-backpressure-'));
    await mkdir(path.join(root, 'z-later'));
    await writeFile(path.join(root, 'a.jpg'), 'a');
    await writeFile(path.join(root, 'z-later', 'z.jpg'), 'z');
    let traversedLaterDirectory = false;
    const iterator = scanMedia(root, {
      fileSystem: {
        ...testFileSystem,
        async *openDirectory(value) {
          if (value.endsWith(`${path.sep}z-later`)) traversedLaterDirectory = true;
          yield* testFileSystem.openDirectory(value);
        },
      },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'file', file: { relativePath: 'a.jpg' } },
    });
    expect(traversedLaterDirectory).toBe(false);
    await iterator.return(undefined);
  });
});

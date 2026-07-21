import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  nodeDestinationFileSystem,
  nodeTraversalFileSystem,
  promoteVerifiedNoReplace,
  type PromotionOperations,
} from './node-filesystem.js';

describe('nodeTraversalFileSystem', () => {
  it('iterates directory entries lazily and maps filesystem facts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-platform-fs-'));
    await writeFile(path.join(root, 'image.jpg'), 'image');
    await mkdir(path.join(root, 'folder'));

    const entries = [];
    for await (const entry of nodeTraversalFileSystem.openDirectory(root)) entries.push(entry);

    expect(entries).toEqual(
      expect.arrayContaining([
        { name: 'image.jpg', kind: 'file' },
        { name: 'folder', kind: 'directory' },
      ]),
    );
    await expect(nodeTraversalFileSystem.stat(root)).resolves.toMatchObject({
      kind: 'directory',
    });
  });
});

describe('nodeDestinationFileSystem', () => {
  it('reports missing paths and canonicalizes symlinks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-destination-fs-'));
    const target = path.join(root, 'target');
    const link = path.join(root, 'link');
    await mkdir(target);
    await symlink(target, link);

    await expect(nodeDestinationFileSystem.lstat(path.join(root, 'missing'))).resolves.toEqual({
      exists: false,
    });
    await expect(nodeDestinationFileSystem.lstat(target)).resolves.toEqual({
      exists: true,
      kind: 'directory',
    });
    await expect(nodeDestinationFileSystem.realpath(link)).resolves.toBe(await realpath(target));
  });
});

function promotionOperations(
  calls: string[],
  faults: Partial<
    Record<'link' | 'copy' | 'fileSync' | 'directorySync' | 'unlink' | 'remove', string>
  >,
): PromotionOperations {
  const operation = async (name: keyof typeof faults): Promise<void> => {
    calls.push(name);
    const code = faults[name];
    if (code !== undefined) throw Object.assign(new Error(`${name} failed`), { code });
  };
  return {
    link: async () => operation('link'),
    copyExclusive: async () => operation('copy'),
    syncFile: async () => operation('fileSync'),
    syncDirectory: async () => operation('directorySync'),
    unlink: async () => operation('unlink'),
    remove: async () => operation('remove'),
  };
}

describe('promoteVerifiedNoReplace', () => {
  it('keeps atomic hard-link commit successful when temp cleanup fails', async () => {
    const calls: string[] = [];

    await expect(
      promoteVerifiedNoReplace(
        '/destination/.temp',
        '/destination/final.mov',
        promotionOperations(calls, { unlink: 'EIO' }),
      ),
    ).resolves.toEqual({
      status: 'committed',
      mode: 'atomic-link',
      cleanupWarning: {
        code: 'TEMP_CLEANUP_FAILED',
        message: 'unlink failed',
        temporaryPath: '/destination/.temp',
      },
    });
    expect(calls).toEqual(['link', 'directorySync', 'unlink']);
  });

  it('commits fallback only after destination and parent fsync', async () => {
    const calls: string[] = [];

    await expect(
      promoteVerifiedNoReplace(
        '/destination/.temp',
        '/destination/final.mov',
        promotionOperations(calls, { link: 'ENOTSUP' }),
      ),
    ).resolves.toEqual({ status: 'committed', mode: 'exclusive-copy' });
    expect(calls).toEqual(['link', 'copy', 'fileSync', 'directorySync', 'unlink', 'directorySync']);
  });

  it('reports a fallback collision without removing or overwriting the racer', async () => {
    const calls: string[] = [];

    await expect(
      promoteVerifiedNoReplace(
        '/destination/.temp',
        '/destination/final.mov',
        promotionOperations(calls, { link: 'ENOTSUP', copy: 'EEXIST' }),
      ),
    ).resolves.toEqual({ status: 'collision' });
    expect(calls).toEqual(['link', 'copy']);
  });

  it.each([
    ['copy', { link: 'ENOTSUP', copy: 'EIO' }],
    ['file fsync', { link: 'ENOTSUP', fileSync: 'EIO' }],
    ['directory fsync', { link: 'ENOTSUP', directorySync: 'EIO' }],
  ] as const)('cleans a provisional fallback after %s failure', async (_label, faults) => {
    const calls: string[] = [];

    await expect(
      promoteVerifiedNoReplace(
        '/destination/.temp',
        '/destination/final.mov',
        promotionOperations(calls, faults),
      ),
    ).rejects.toMatchObject({
      code: 'PROMOTION_PROVISIONAL_FAILED',
      provisionalFinalPath: '/destination/final.mov',
    });
    expect(calls.slice(-2)).toEqual(['remove', 'directorySync']);
    expect(calls).not.toContain('unlink');
  });

  it('reports deterministic recovery diagnostics when provisional cleanup fails', async () => {
    const calls: string[] = [];

    await expect(
      promoteVerifiedNoReplace(
        '/destination/.temp',
        '/destination/final.mov',
        promotionOperations(calls, { link: 'ENOTSUP', fileSync: 'EIO', remove: 'EBUSY' }),
      ),
    ).rejects.toMatchObject({
      code: 'PROMOTION_PROVISIONAL_FAILED',
      cleanupWarning: {
        code: 'PROVISIONAL_CLEANUP_FAILED',
        message: 'remove failed',
        path: '/destination/final.mov',
      },
    });
  });

  it('does not turn fallback temp unlink failure into copy failure', async () => {
    const calls: string[] = [];

    await expect(
      promoteVerifiedNoReplace(
        '/destination/.temp',
        '/destination/final.mov',
        promotionOperations(calls, { link: 'ENOTSUP', unlink: 'EIO' }),
      ),
    ).resolves.toMatchObject({
      status: 'committed',
      mode: 'exclusive-copy',
      cleanupWarning: { code: 'TEMP_CLEANUP_FAILED' },
    });
  });

  it('reports temp cleanup directory-sync failure without undoing commit', async () => {
    const calls: string[] = [];
    let directorySyncs = 0;
    const operations = promotionOperations(calls, {});
    operations.syncDirectory = async () => {
      calls.push('directorySync');
      directorySyncs += 1;
      if (directorySyncs === 2) throw new Error('cleanup directory sync failed');
    };

    await expect(
      promoteVerifiedNoReplace('/destination/.temp', '/destination/final.mov', operations),
    ).resolves.toMatchObject({
      status: 'committed',
      mode: 'atomic-link',
      cleanupWarning: {
        code: 'TEMP_CLEANUP_SYNC_FAILED',
        message: 'cleanup directory sync failed',
      },
    });
    expect(calls).toEqual(['link', 'directorySync', 'unlink', 'directorySync']);
  });

  it('reports provisional removal sync failure as recovery diagnostics', async () => {
    const calls: string[] = [];

    await expect(
      promoteVerifiedNoReplace(
        '/destination/.temp',
        '/destination/final.mov',
        promotionOperations(calls, {
          link: 'ENOTSUP',
          fileSync: 'EIO',
          directorySync: 'EIO',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'PROMOTION_PROVISIONAL_FAILED',
      cleanupWarning: {
        code: 'PROVISIONAL_CLEANUP_SYNC_FAILED',
        path: '/destination/final.mov',
      },
    });
    expect(calls.slice(-2)).toEqual(['remove', 'directorySync']);
  });
});

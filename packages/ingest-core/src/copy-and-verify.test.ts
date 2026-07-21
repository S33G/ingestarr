import { mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { nodeTransferFileSystem } from '../../platform/src/node-filesystem.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  copyAndVerify,
  type CopyTransferError,
  type CopyLifecycle,
  type CopyLifecycleEvent,
} from './copy-and-verify.js';

const roots: string[] = [];
const now = () => '2026-07-19T12:00:00.000Z';

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-copy-'));
  roots.push(root);
  return root;
}

function lifecycle(events: CopyLifecycleEvent[]): CopyLifecycle {
  return {
    plan: async (job, at) => events.push({ type: 'planned', jobId: job.id, at }),
    markStarted: async (id, at) => events.push({ type: 'started', jobId: id, at }),
    updateProgress: async (id, bytes, at) =>
      events.push({ type: 'progress', jobId: id, bytes, at }),
    markVerified: async (id, bytes, checksum, at) =>
      events.push({ type: 'verified', jobId: id, bytes, checksum, at }),
    markFailed: async (id, code, message, at) =>
      events.push({ type: 'failed', jobId: id, code, message, at }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('copyAndVerify', () => {
  it('leaves no planned or started orphan when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const events: CopyLifecycleEvent[] = [];

    await expect(
      copyAndVerify(
        {
          id: 'copy-aborted',
          sessionId: 'session',
          sourcePath: '/does/not/matter',
          destinationRoot: '/does/not/matter',
          destinationPath: '/does/not/matter/file.mov',
          expectedBytes: 1,
          expectedSource: { sizeBytes: 1, modifiedAtMs: 1 },
        },
        {
          fileSystem: nodeTransferFileSystem,
          lifecycle: lifecycle(events),
          now,
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'COPY_CANCELLED' });
    expect(events).toEqual([]);
  });

  it('validates temp-name identifiers and containment before mkdir mutation', async () => {
    const root = await makeRoot();
    const destinationRoot = path.join(root, 'destination');
    const outsideDirectory = path.join(root, 'outside', 'nested');
    const sourcePath = path.join(root, 'source.mov');
    await nodeTransferFileSystem.mkdir(destinationRoot);
    await writeFile(sourcePath, 'x');
    const sourceFacts = await nodeTransferFileSystem.stat(sourcePath);
    const events: CopyLifecycleEvent[] = [];
    let mkdirCalls = 0;
    let canonicalCalls = 0;
    const fileSystem = {
      ...nodeTransferFileSystem,
      async realpath(value: string) {
        canonicalCalls += 1;
        return nodeTransferFileSystem.realpath(value);
      },
      async mkdir(value: string) {
        mkdirCalls += 1;
        return nodeTransferFileSystem.mkdir(value);
      },
    };

    await expect(
      copyAndVerify(
        {
          id: '../escape',
          sessionId: 'session',
          sourcePath,
          destinationRoot,
          destinationPath: path.join(outsideDirectory, 'clip.mov'),
          expectedBytes: 1,
          expectedSource: sourceFacts,
        },
        { fileSystem, lifecycle: lifecycle(events), now },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TEMP_IDENTIFIER' });
    expect(mkdirCalls).toBe(0);
    expect(events).toEqual([]);

    await expect(
      copyAndVerify(
        {
          id: 'copy',
          sessionId: 'session',
          sourcePath,
          destinationRoot,
          destinationPath: path.join(outsideDirectory, 'clip.mov'),
          expectedBytes: 1,
          expectedSource: sourceFacts,
        },
        { fileSystem, lifecycle: lifecycle(events), now },
      ),
    ).rejects.toMatchObject({ code: 'DESTINATION_OUTSIDE_ROOT' });
    expect(mkdirCalls).toBe(0);
    expect(canonicalCalls).toBe(0);
    expect(await nodeTransferFileSystem.lstat(outsideDirectory)).toEqual({ exists: false });
  });

  it('persists started before canonical checks and durably fails containment', async () => {
    const root = await makeRoot();
    const sourceRoot = path.join(root, 'source');
    const destinationRoot = path.join(root, 'destination');
    const outside = path.join(root, 'outside');
    const linkedDirectory = path.join(destinationRoot, 'linked');
    await nodeTransferFileSystem.mkdir(sourceRoot);
    await nodeTransferFileSystem.mkdir(destinationRoot);
    await nodeTransferFileSystem.mkdir(outside);
    await symlink(outside, linkedDirectory);
    const sourcePath = path.join(sourceRoot, 'clip.mov');
    await writeFile(sourcePath, 'source');
    const facts = await nodeTransferFileSystem.stat(sourcePath);
    const ordering: string[] = [];
    const events: CopyLifecycleEvent[] = [];
    const copyLifecycle = lifecycle(events);
    const fileSystem = {
      ...nodeTransferFileSystem,
      async realpath(value: string) {
        ordering.push(`fs:realpath:${value}`);
        return nodeTransferFileSystem.realpath(value);
      },
    };
    const orderedLifecycle: CopyLifecycle = {
      ...copyLifecycle,
      async plan(job, at) {
        ordering.push('lifecycle:planned');
        return copyLifecycle.plan(job, at);
      },
      async markStarted(id, at) {
        ordering.push('lifecycle:started');
        return copyLifecycle.markStarted(id, at);
      },
    };

    await expect(
      copyAndVerify(
        {
          id: 'copy-contained',
          sessionId: 'session',
          sourcePath,
          destinationRoot,
          destinationPath: path.join(linkedDirectory, 'clip.mov'),
          expectedBytes: 6,
          expectedSource: facts,
        },
        { fileSystem, lifecycle: orderedLifecycle, now },
      ),
    ).rejects.toMatchObject({ code: 'DESTINATION_OUTSIDE_ROOT' });

    expect(ordering.slice(0, 2)).toEqual(['lifecycle:planned', 'lifecycle:started']);
    expect(events.map((event) => event.type)).toEqual(['planned', 'started', 'failed']);
    expect(events.at(-1)).toMatchObject({ code: 'DESTINATION_OUTSIDE_ROOT' });
  });

  it('streams, independently verifies, and atomically promotes a file', async () => {
    const root = await makeRoot();
    const sourceRoot = path.join(root, 'source');
    const destinationRoot = path.join(root, 'destination');
    await nodeTransferFileSystem.mkdir(sourceRoot);
    await nodeTransferFileSystem.mkdir(destinationRoot);
    const sourcePath = path.join(sourceRoot, 'large.mov');
    const destinationPath = path.join(destinationRoot, 'large.mov');
    const contents = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
    await writeFile(sourcePath, contents);
    const sourceStat = await stat(sourcePath);
    const events: CopyLifecycleEvent[] = [];

    const result = await copyAndVerify(
      {
        id: 'copy-1',
        sessionId: 'session-1',
        sourcePath,
        destinationRoot,
        destinationPath,
        expectedBytes: contents.length,
        expectedSource: {
          sizeBytes: sourceStat.size,
          modifiedAtMs: sourceStat.mtimeMs,
          fileId: `${sourceStat.dev}:${sourceStat.ino}`,
        },
      },
      {
        fileSystem: nodeTransferFileSystem,
        lifecycle: lifecycle(events),
        now,
        progressIntervalBytes: 256 * 1024,
      },
    );

    expect(result).toMatchObject({ status: 'completed', promotionMode: 'atomic-link' });
    expect(await readFile(destinationPath)).toEqual(contents);
    expect(events[0]?.type).toBe('planned');
    expect(events[1]?.type).toBe('started');
    expect(events.at(-1)?.type).toBe('verified');
    expect(events.filter((event) => event.type === 'progress').length).toBeGreaterThan(1);
  });

  it('copies a zero-byte file', async () => {
    const root = await makeRoot();
    const sourceRoot = path.join(root, 'source');
    const destinationRoot = path.join(root, 'destination');
    await nodeTransferFileSystem.mkdir(sourceRoot);
    await nodeTransferFileSystem.mkdir(destinationRoot);
    const sourcePath = path.join(sourceRoot, 'empty.mov');
    const destinationPath = path.join(destinationRoot, 'empty.mov');
    await writeFile(sourcePath, '');
    const facts = await nodeTransferFileSystem.stat(sourcePath);

    const result = await copyAndVerify(
      {
        id: 'copy-empty',
        sessionId: 'session',
        sourcePath,
        destinationRoot,
        destinationPath,
        expectedBytes: 0,
        expectedSource: facts,
      },
      { fileSystem: nodeTransferFileSystem, lifecycle: lifecycle([]), now },
    );

    expect(result).toMatchObject({ status: 'completed', bytesCopied: 0 });
  });

  it('never overwrites a destination created during promotion', async () => {
    const root = await makeRoot();
    const sourceRoot = path.join(root, 'source');
    const destinationRoot = path.join(root, 'destination');
    await nodeTransferFileSystem.mkdir(sourceRoot);
    await nodeTransferFileSystem.mkdir(destinationRoot);
    const sourcePath = path.join(sourceRoot, 'clip.mov');
    const destinationPath = path.join(destinationRoot, 'clip.mov');
    await writeFile(sourcePath, 'incoming');
    const facts = await nodeTransferFileSystem.stat(sourcePath);
    const events: CopyLifecycleEvent[] = [];
    const cleanupCalls: string[] = [];
    const fileSystem = {
      ...nodeTransferFileSystem,
      async promoteVerifiedNoReplace(tempPath: string, finalPath: string) {
        await writeFile(finalPath, 'racer', { flag: 'wx' });
        return nodeTransferFileSystem.promoteVerifiedNoReplace(tempPath, finalPath);
      },
      async remove(value: string) {
        cleanupCalls.push('remove');
        return nodeTransferFileSystem.remove(value);
      },
      async syncDirectory(value: string) {
        cleanupCalls.push('syncDirectory');
        return nodeTransferFileSystem.syncDirectory(value);
      },
    };

    const result = await copyAndVerify(
      {
        id: 'copy-race',
        sessionId: 'session',
        sourcePath,
        destinationRoot,
        destinationPath,
        expectedBytes: 8,
        expectedSource: facts,
      },
      { fileSystem, lifecycle: lifecycle(events), now },
    );

    expect(result).toEqual({
      status: 'collision',
      jobId: 'copy-race',
      destinationPath,
      reason: 'destination-exists',
    });
    expect(await readFile(destinationPath, 'utf8')).toBe('racer');
    expect(events.at(-1)).toMatchObject({
      type: 'failed',
      code: 'DESTINATION_COLLISION',
    });
    expect(cleanupCalls).toEqual(['remove', 'syncDirectory']);
  });

  it('reports post-commit temp cleanup as a warning and remains verified', async () => {
    const root = await makeRoot();
    const sourceRoot = path.join(root, 'source');
    const destinationRoot = path.join(root, 'destination');
    await nodeTransferFileSystem.mkdir(sourceRoot);
    await nodeTransferFileSystem.mkdir(destinationRoot);
    const sourcePath = path.join(sourceRoot, 'clip.mov');
    const destinationPath = path.join(destinationRoot, 'clip.mov');
    await writeFile(sourcePath, 'source');
    const facts = await nodeTransferFileSystem.stat(sourcePath);
    const events: CopyLifecycleEvent[] = [];
    const fileSystem = {
      ...nodeTransferFileSystem,
      async promoteVerifiedNoReplace(tempPath: string, finalPath: string) {
        const promoted = await nodeTransferFileSystem.promoteVerifiedNoReplace(tempPath, finalPath);
        return promoted.status === 'collision'
          ? promoted
          : {
              ...promoted,
              cleanupWarning: {
                code: 'TEMP_CLEANUP_FAILED' as const,
                message: 'temp retained',
                temporaryPath: tempPath,
              },
            };
      },
    };

    const result = await copyAndVerify(
      {
        id: 'copy-warning',
        sessionId: 'session',
        sourcePath,
        destinationRoot,
        destinationPath,
        expectedBytes: 6,
        expectedSource: facts,
      },
      { fileSystem, lifecycle: lifecycle(events), now },
    );

    expect(result).toMatchObject({
      status: 'completed',
      cleanupWarning: { code: 'TEMP_CLEANUP_FAILED' },
    });
    expect(events.at(-1)?.type).toBe('verified');
    expect(await readFile(destinationPath, 'utf8')).toBe('source');
  });

  it('keeps storage unverified after provisional promotion failure', async () => {
    const root = await makeRoot();
    const sourceRoot = path.join(root, 'source');
    const destinationRoot = path.join(root, 'destination');
    await nodeTransferFileSystem.mkdir(sourceRoot);
    await nodeTransferFileSystem.mkdir(destinationRoot);
    const sourcePath = path.join(sourceRoot, 'clip.mov');
    const destinationPath = path.join(destinationRoot, 'clip.mov');
    await writeFile(sourcePath, 'source');
    const facts = await nodeTransferFileSystem.stat(sourcePath);
    const events: CopyLifecycleEvent[] = [];
    const fileSystem = {
      ...nodeTransferFileSystem,
      async promoteVerifiedNoReplace() {
        throw Object.assign(new Error('fallback fsync failed'), {
          code: 'PROMOTION_PROVISIONAL_FAILED',
          provisionalFinalPath: destinationPath,
        });
      },
    };

    await expect(
      copyAndVerify(
        {
          id: 'copy-provisional',
          sessionId: 'session',
          sourcePath,
          destinationRoot,
          destinationPath,
          expectedBytes: 6,
          expectedSource: facts,
        },
        { fileSystem, lifecycle: lifecycle(events), now },
      ),
    ).rejects.toMatchObject({
      code: 'PROMOTION_PROVISIONAL_FAILED',
      provisionalFinalPath: destinationPath,
    });
    expect(events.some((event) => event.type === 'verified')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'PROMOTION_PROVISIONAL_FAILED' });
  });

  it('records cancellation and removes the temporary file', async () => {
    const root = await makeRoot();
    const sourceRoot = path.join(root, 'source');
    const destinationRoot = path.join(root, 'destination');
    await nodeTransferFileSystem.mkdir(sourceRoot);
    await nodeTransferFileSystem.mkdir(destinationRoot);
    const sourcePath = path.join(sourceRoot, 'clip.mov');
    const destinationPath = path.join(destinationRoot, 'clip.mov');
    await writeFile(sourcePath, Buffer.alloc(1024 * 1024));
    const facts = await nodeTransferFileSystem.stat(sourcePath);
    const controller = new AbortController();
    const events: CopyLifecycleEvent[] = [];
    const fileSystem = {
      ...nodeTransferFileSystem,
      async *openRead(value: string, signal?: AbortSignal) {
        for await (const chunk of nodeTransferFileSystem.openRead(value, signal)) {
          yield chunk;
          controller.abort();
        }
      },
    };

    await expect(
      copyAndVerify(
        {
          id: 'copy-abort',
          sessionId: 'session',
          sourcePath,
          destinationRoot,
          destinationPath,
          expectedBytes: facts.sizeBytes,
          expectedSource: facts,
        },
        { fileSystem, lifecycle: lifecycle(events), now, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'COPY_CANCELLED' });
    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'COPY_CANCELLED' });
    expect(events.map((event) => event.type)).toEqual(['planned', 'started', 'failed']);
    expect(await nodeTransferFileSystem.listDirectory(destinationRoot)).toEqual([]);
  });

  it('rejects source mutation and checksum mismatch without promotion', async () => {
    const root = await makeRoot();
    const sourceRoot = path.join(root, 'source');
    const destinationRoot = path.join(root, 'destination');
    await nodeTransferFileSystem.mkdir(sourceRoot);
    await nodeTransferFileSystem.mkdir(destinationRoot);
    const sourcePath = path.join(sourceRoot, 'clip.mov');
    const destinationPath = path.join(destinationRoot, 'clip.mov');
    await writeFile(sourcePath, 'source');
    const facts = await nodeTransferFileSystem.stat(sourcePath);

    await expect(
      copyAndVerify(
        {
          id: 'copy-mismatch',
          sessionId: 'session',
          sourcePath,
          destinationRoot,
          destinationPath,
          expectedBytes: 6,
          expectedChecksum: '0'.repeat(64),
          expectedSource: facts,
        },
        { fileSystem: nodeTransferFileSystem, lifecycle: lifecycle([]), now },
      ),
    ).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    await expect(readFile(destinationPath)).rejects.toThrow();
  });

  it('detects source stat changes during copy', async () => {
    const root = await makeRoot();
    const sourceRoot = path.join(root, 'source');
    const destinationRoot = path.join(root, 'destination');
    await nodeTransferFileSystem.mkdir(sourceRoot);
    await nodeTransferFileSystem.mkdir(destinationRoot);
    const sourcePath = path.join(sourceRoot, 'clip.mov');
    const destinationPath = path.join(destinationRoot, 'clip.mov');
    await writeFile(sourcePath, 'source');
    const facts = await nodeTransferFileSystem.stat(sourcePath);
    let sourceStats = 0;
    const fileSystem = {
      ...nodeTransferFileSystem,
      async stat(value: string) {
        const result = await nodeTransferFileSystem.stat(value);
        if (value === sourcePath && ++sourceStats > 1) {
          return { ...result, modifiedAtMs: result.modifiedAtMs + 1 };
        }
        return result;
      },
    };

    await expect(
      copyAndVerify(
        {
          id: 'copy-mutated',
          sessionId: 'session',
          sourcePath,
          destinationRoot,
          destinationPath,
          expectedBytes: 6,
          expectedSource: facts,
        },
        { fileSystem, lifecycle: lifecycle([]), now },
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_MUTATED' });
    await expect(readFile(destinationPath)).rejects.toThrow();
  });

  it('rejects a session temporary collision without modifying it', async () => {
    const root = await makeRoot();
    const sourceRoot = path.join(root, 'source');
    const destinationRoot = path.join(root, 'destination');
    await nodeTransferFileSystem.mkdir(sourceRoot);
    await nodeTransferFileSystem.mkdir(destinationRoot);
    const sourcePath = path.join(sourceRoot, 'clip.mov');
    const destinationPath = path.join(destinationRoot, 'clip.mov');
    const temporaryPath = path.join(destinationRoot, '.clip.mov.session.copy-temp.tmp');
    await writeFile(sourcePath, 'source');
    await writeFile(temporaryPath, 'existing');
    const facts = await nodeTransferFileSystem.stat(sourcePath);

    await expect(
      copyAndVerify(
        {
          id: 'copy-temp',
          sessionId: 'session',
          sourcePath,
          destinationRoot,
          destinationPath,
          expectedBytes: 6,
          expectedSource: facts,
        },
        { fileSystem: nodeTransferFileSystem, lifecycle: lifecycle([]), now },
      ),
    ).rejects.toMatchObject({ code: 'TEMP_COLLISION' });
    expect(await readFile(temporaryPath, 'utf8')).toBe('existing');
  });

  it('detects a symlink ancestor swap immediately before promotion', async () => {
    const root = await makeRoot();
    const sourceRoot = path.join(root, 'source');
    const destinationRoot = path.join(root, 'destination');
    const destinationDirectory = path.join(destinationRoot, 'nested');
    const outside = path.join(root, 'outside');
    await nodeTransferFileSystem.mkdir(sourceRoot);
    await nodeTransferFileSystem.mkdir(destinationDirectory);
    await nodeTransferFileSystem.mkdir(outside);
    const sourcePath = path.join(sourceRoot, 'clip.mov');
    const destinationPath = path.join(destinationDirectory, 'clip.mov');
    await writeFile(sourcePath, 'source');
    const facts = await nodeTransferFileSystem.stat(sourcePath);
    let candidateChecks = 0;
    const fileSystem = {
      ...nodeTransferFileSystem,
      async lstat(value: string) {
        if (value === destinationPath && ++candidateChecks === 2) {
          await rename(destinationDirectory, `${destinationDirectory}-old`);
          await symlink(outside, destinationDirectory);
        }
        return nodeTransferFileSystem.lstat(value);
      },
    };

    await expect(
      copyAndVerify(
        {
          id: 'copy-swap',
          sessionId: 'session',
          sourcePath,
          destinationRoot,
          destinationPath,
          expectedBytes: 6,
          expectedSource: facts,
        },
        { fileSystem, lifecycle: lifecycle([]), now },
      ),
    ).rejects.toMatchObject({ code: 'DESTINATION_OUTSIDE_ROOT' });
    expect(await nodeTransferFileSystem.listDirectory(outside)).toEqual([]);
  });

  it('maps write and fsync faults to stable errors', async () => {
    const root = await makeRoot();
    const sourceRoot = path.join(root, 'source');
    const destinationRoot = path.join(root, 'destination');
    await nodeTransferFileSystem.mkdir(sourceRoot);
    await nodeTransferFileSystem.mkdir(destinationRoot);
    const sourcePath = path.join(sourceRoot, 'clip.mov');
    const destinationPath = path.join(destinationRoot, 'clip.mov');
    await writeFile(sourcePath, 'source');
    const facts = await nodeTransferFileSystem.stat(sourcePath);
    const fileSystem = {
      ...nodeTransferFileSystem,
      async createExclusive(value: string) {
        const handle = await nodeTransferFileSystem.createExclusive(value);
        return {
          ...handle,
          async sync() {
            throw Object.assign(new Error('disk fault'), { code: 'EIO' });
          },
        };
      },
    };

    await expect(
      copyAndVerify(
        {
          id: 'copy-fsync',
          sessionId: 'session',
          sourcePath,
          destinationRoot,
          destinationPath,
          expectedBytes: 6,
          expectedSource: facts,
        },
        { fileSystem, lifecycle: lifecycle([]), now },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CopyTransferError>>({ code: 'FSYNC_FAILED' }),
    );
  });

  it.each([
    ['read', 'READ_FAILED'],
    ['write', 'WRITE_FAILED'],
    ['verify', 'VERIFY_READ_FAILED'],
  ] as const)('maps %s faults to stable errors', async (fault, expectedCode) => {
    const root = await makeRoot();
    const sourceRoot = path.join(root, 'source');
    const destinationRoot = path.join(root, 'destination');
    await nodeTransferFileSystem.mkdir(sourceRoot);
    await nodeTransferFileSystem.mkdir(destinationRoot);
    const sourcePath = path.join(sourceRoot, 'clip.mov');
    const destinationPath = path.join(destinationRoot, 'clip.mov');
    await writeFile(sourcePath, 'source');
    const facts = await nodeTransferFileSystem.stat(sourcePath);
    const fileSystem = {
      ...nodeTransferFileSystem,
      async *openRead(value: string, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
        if (fault === 'read' || (fault === 'verify' && value !== sourcePath)) {
          throw new Error(`${fault} fault`);
        }
        yield* nodeTransferFileSystem.openRead(value, signal);
      },
      async createExclusive(value: string) {
        const handle = await nodeTransferFileSystem.createExclusive(value);
        return fault === 'write'
          ? { ...handle, write: async () => Promise.reject(new Error('write fault')) }
          : handle;
      },
    };

    await expect(
      copyAndVerify(
        {
          id: `copy-${fault}`,
          sessionId: 'session',
          sourcePath,
          destinationRoot,
          destinationPath,
          expectedBytes: 6,
          expectedSource: facts,
        },
        { fileSystem, lifecycle: lifecycle([]), now },
      ),
    ).rejects.toMatchObject({ code: expectedCode });
  });

  it.each(['ENOENT', 'ENODEV', 'EIO'] as const)(
    'preserves source-side %s as SOURCE_UNAVAILABLE',
    async (nativeCode) => {
      const root = await makeRoot();
      const destinationRoot = path.join(root, 'destination');
      await nodeTransferFileSystem.mkdir(destinationRoot);
      const events: CopyLifecycleEvent[] = [];
      const fileSystem = {
        ...nodeTransferFileSystem,
        async stat() {
          throw Object.assign(new Error('source disappeared'), { code: nativeCode });
        },
      };

      await expect(
        copyAndVerify(
          {
            id: `copy-${nativeCode}`,
            sessionId: 'session',
            sourcePath: path.join(root, 'missing.mov'),
            destinationRoot,
            destinationPath: path.join(destinationRoot, 'clip.mov'),
            expectedBytes: 1,
            expectedSource: { sizeBytes: 1, modifiedAtMs: 1 },
          },
          { fileSystem, lifecycle: lifecycle(events), now },
        ),
      ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
      expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'SOURCE_UNAVAILABLE' });
    },
  );

  it('surfaces lifecycle persistence failures as fatal database errors', async () => {
    const root = await makeRoot();
    const sourceRoot = path.join(root, 'source');
    const destinationRoot = path.join(root, 'destination');
    await nodeTransferFileSystem.mkdir(sourceRoot);
    await nodeTransferFileSystem.mkdir(destinationRoot);
    const sourcePath = path.join(sourceRoot, 'clip.mov');
    const destinationPath = path.join(destinationRoot, 'clip.mov');
    await writeFile(sourcePath, Buffer.alloc(1024));
    const facts = await nodeTransferFileSystem.stat(sourcePath);
    const copyLifecycle = lifecycle([]);
    copyLifecycle.updateProgress = async () => {
      throw new Error('database unavailable');
    };

    await expect(
      copyAndVerify(
        {
          id: 'copy-database',
          sessionId: 'session',
          sourcePath,
          destinationRoot,
          destinationPath,
          expectedBytes: facts.sizeBytes,
          expectedSource: facts,
        },
        {
          fileSystem: nodeTransferFileSystem,
          lifecycle: copyLifecycle,
          now,
          progressIntervalBytes: 1,
        },
      ),
    ).rejects.toMatchObject({ code: 'DATABASE_FAILED', recoverable: false });
  });
});

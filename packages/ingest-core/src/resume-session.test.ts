import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createResumeSessionCoordinator, type RecoveryDependencies } from './resume-session.js';

const roots = {
  destinationRoot: '/archive',
  temporaryRoot: '/user-data/temp/session-1',
  provisionalRoot: '/archive/.ingestarr/session-1',
};

function dependencies(overrides: Partial<RecoveryDependencies> = {}): RecoveryDependencies {
  const files = new Map<
    string,
    { kind: 'file' | 'directory' | 'symlink'; sizeBytes: number; fileId: string }
  >([
    ['/archive', { kind: 'directory', sizeBytes: 0, fileId: 'archive' }],
    ['/user-data/temp/session-1', { kind: 'directory', sizeBytes: 0, fileId: 'temp-root' }],
    ['/archive/.ingestarr/session-1', { kind: 'directory', sizeBytes: 0, fileId: 'prov-root' }],
  ]);
  const base: RecoveryDependencies = {
    loadSession: vi.fn().mockResolvedValue({
      id: 'session-1',
      status: 'copying',
      copies: [
        {
          id: 'copy-1',
          status: 'started',
          expectedBytes: 10,
          expectedChecksum: 'good',
          sourceRelativePath: 'DCIM/a.jpg',
          destinationPath: '/archive/2026/a.jpg',
          temporaryPath: '/user-data/temp/session-1/copy-1.partial',
          provisionalPath: '/archive/.ingestarr/session-1/copy-1.provisional',
        },
      ],
    }),
    roots: vi.fn().mockResolvedValue(roots),
    sourceAvailable: vi.fn().mockResolvedValue(true),
    lstat: vi.fn(async (value) => {
      const fact = files.get(value);
      return fact === undefined ? { exists: false as const } : { exists: true as const, ...fact };
    }),
    realpath: vi.fn(async (value) => path.resolve(value)),
    hash: vi.fn().mockResolvedValue('good'),
    remove: vi.fn(async (value) => {
      files.delete(value);
    }),
    quarantine: vi.fn().mockResolvedValue(undefined),
    resetCopy: vi.fn().mockResolvedValue(undefined),
    markVerified: vi.fn().mockResolvedValue(undefined),
    scheduleCopy: vi.fn().mockResolvedValue(undefined),
    markSession: vi.fn().mockResolvedValue(undefined),
    regenerateManifest: vi.fn().mockResolvedValue(undefined),
    audit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  Object.assign(base, { files });
  return base;
}

describe('resume session reconciliation', () => {
  it('removes an owned partial, restarts from byte zero, and reuses the session id', async () => {
    const deps = dependencies();
    (
      deps as RecoveryDependencies & {
        files: Map<string, { kind: 'file'; sizeBytes: number; fileId: string }>;
      }
    ).files.set('/user-data/temp/session-1/copy-1.partial', {
      kind: 'file',
      sizeBytes: 4,
      fileId: 'partial-1',
    });
    const result = await createResumeSessionCoordinator(deps).resume('session-1');

    expect(result).toEqual({ sessionId: 'session-1', status: 'completed', scheduled: 1 });
    expect(deps.remove).toHaveBeenCalledWith(
      '/user-data/temp/session-1/copy-1.partial',
      'partial-1',
    );
    expect(deps.resetCopy).toHaveBeenCalledWith('copy-1');
    expect(deps.scheduleCopy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'copy-1' }),
      expect.any(AbortSignal),
    );
    expect(deps.regenerateManifest).toHaveBeenCalledWith('session-1');
  });

  it('independently verifies a provisional final and does not reschedule it', async () => {
    const deps = dependencies({
      loadSession: vi.fn().mockResolvedValue({
        id: 'session-1',
        status: 'copying',
        copies: [
          {
            id: 'copy-1',
            status: 'started',
            expectedBytes: 10,
            expectedChecksum: 'good',
            sourceRelativePath: 'DCIM/a.jpg',
            destinationPath: '/archive/2026/a.jpg',
            temporaryPath: '/user-data/temp/session-1/copy-1.partial',
            provisionalPath: '/archive/.ingestarr/session-1/copy-1.provisional',
          },
        ],
      }),
    });
    (
      deps as RecoveryDependencies & {
        files: Map<string, { kind: 'file'; sizeBytes: number; fileId: string }>;
      }
    ).files.set('/archive/.ingestarr/session-1/copy-1.provisional', {
      kind: 'file',
      sizeBytes: 10,
      fileId: 'provisional-1',
    });

    const result = await createResumeSessionCoordinator(deps).resume('session-1');

    expect(result.scheduled).toBe(0);
    expect(deps.hash).toHaveBeenCalledWith(
      '/archive/.ingestarr/session-1/copy-1.provisional',
      'provisional-1',
    );
    expect(deps.markVerified).toHaveBeenCalledWith('copy-1', 'good', 10);
    expect(deps.scheduleCopy).not.toHaveBeenCalled();
  });

  it('quarantines an invalid provisional final and recopies it', async () => {
    const deps = dependencies({ hash: vi.fn().mockResolvedValue('wrong') });
    (
      deps as RecoveryDependencies & {
        files: Map<string, { kind: 'file'; sizeBytes: number; fileId: string }>;
      }
    ).files.set('/archive/.ingestarr/session-1/copy-1.provisional', {
      kind: 'file',
      sizeBytes: 10,
      fileId: 'provisional-1',
    });

    const result = await createResumeSessionCoordinator(deps).resume('session-1');

    expect(result).toMatchObject({ status: 'completed', scheduled: 1 });
    expect(deps.quarantine).toHaveBeenCalledWith(
      '/archive/.ingestarr/session-1/copy-1.provisional',
      'provisional-1',
    );
    expect(deps.scheduleCopy).toHaveBeenCalledOnce();
  });

  it('rehashes an inconsistent verified final while trusting consistent verified facts', async () => {
    const verified = {
      id: 'session-1',
      status: 'copying',
      copies: [
        {
          id: 'copy-1',
          status: 'verified' as const,
          expectedBytes: 10,
          expectedChecksum: 'good',
          checksum: 'stale',
          sourceRelativePath: 'DCIM/a.jpg',
          destinationPath: '/archive/2026/a.jpg',
        },
      ],
    };
    const deps = dependencies({ loadSession: vi.fn().mockResolvedValue(verified) });
    (
      deps as RecoveryDependencies & {
        files: Map<string, { kind: 'file'; sizeBytes: number; fileId: string }>;
      }
    ).files.set('/archive/2026/a.jpg', {
      kind: 'file',
      sizeBytes: 10,
      fileId: 'final-1',
    });

    await createResumeSessionCoordinator(deps).resume('session-1');

    expect(deps.hash).toHaveBeenCalledWith('/archive/2026/a.jpg', 'final-1');
    expect(deps.markVerified).toHaveBeenCalledWith('copy-1', 'good', 10);
    expect(deps.scheduleCopy).not.toHaveBeenCalled();

    vi.mocked(deps.loadSession).mockResolvedValue({
      ...verified,
      copies: [{ ...verified.copies[0]!, checksum: 'good' }],
    });
    vi.mocked(deps.hash).mockClear();
    await createResumeSessionCoordinator(deps).resume('session-1');
    expect(deps.hash).not.toHaveBeenCalled();
  });

  it('pauses recoverably when source is absent and resumes after it reappears', async () => {
    const available = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const deps = dependencies({ sourceAvailable: available });
    const coordinator = createResumeSessionCoordinator(deps);

    await expect(coordinator.resume('session-1')).resolves.toEqual({
      sessionId: 'session-1',
      status: 'paused',
      reason: 'source-unavailable',
      scheduled: 0,
    });
    await expect(coordinator.resume('session-1')).resolves.toMatchObject({
      sessionId: 'session-1',
      status: 'completed',
      scheduled: 1,
    });
  });

  it('rejects malicious paths and symlink swaps without deleting them', async () => {
    const deps = dependencies({
      loadSession: vi.fn().mockResolvedValue({
        id: 'session-1',
        status: 'copying',
        copies: [
          {
            id: 'copy-1',
            status: 'started',
            expectedBytes: 10,
            expectedChecksum: 'good',
            sourceRelativePath: 'DCIM/a.jpg',
            destinationPath: '/archive/2026/a.jpg',
            temporaryPath: '/etc/passwd',
          },
        ],
      }),
    });
    await expect(createResumeSessionCoordinator(deps).resume('session-1')).rejects.toThrow(
      /outside.*session-owned/i,
    );
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('never hashes or quarantines a final beneath a symlinked destination ancestor', async () => {
    const deps = dependencies({
      loadSession: vi.fn().mockResolvedValue({
        id: 'session-1',
        status: 'copying',
        copies: [
          {
            id: 'copy-1',
            status: 'verified',
            expectedBytes: 10,
            expectedChecksum: 'good',
            checksum: 'stale',
            sourceRelativePath: 'DCIM/a.jpg',
            destinationPath: '/archive/symlink/a.jpg',
          },
        ],
      }),
      realpath: vi.fn(async (value) =>
        value === '/archive/symlink/a.jpg' ? '/external/a.jpg' : path.resolve(value),
      ),
    });
    (
      deps as RecoveryDependencies & {
        files: Map<string, { kind: 'file'; sizeBytes: number; fileId: string }>;
      }
    ).files.set('/archive/symlink/a.jpg', {
      kind: 'file',
      sizeBytes: 10,
      fileId: 'external-file',
    });

    await expect(createResumeSessionCoordinator(deps).resume('session-1')).rejects.toThrow(
      /escapes.*canonical root/i,
    );
    expect(deps.hash).not.toHaveBeenCalled();
    expect(deps.quarantine).not.toHaveBeenCalled();
  });

  it('serializes concurrent resume and cleanup and makes cleanup idempotent', async () => {
    let release!: () => void;
    const scheduled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = dependencies({ scheduleCopy: vi.fn(() => scheduled) });
    const coordinator = createResumeSessionCoordinator(deps);

    const first = coordinator.resume('session-1');
    const duplicate = coordinator.resume('session-1');
    const cleanup = coordinator.cleanup('session-1');
    expect(first).toBe(duplicate);
    release();
    await first;
    await cleanup;
    await coordinator.cleanup('session-1');

    expect(deps.scheduleCopy).toHaveBeenCalledTimes(1);
    expect(deps.markSession).toHaveBeenCalledWith('session-1', 'cancelled');
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', action: 'cleanup' }),
    );
  });

  it('honors cancellation before reconciliation and persists cancellation', async () => {
    const deps = dependencies();
    const abort = new AbortController();
    abort.abort();

    await expect(
      createResumeSessionCoordinator(deps).resume('session-1', abort.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(deps.markSession).toHaveBeenCalledWith('session-1', 'cancelled');
    expect(deps.regenerateManifest).toHaveBeenCalledWith('session-1');
  });
});

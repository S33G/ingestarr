import { describe, expect, it } from 'vitest';

import {
  FatalIngestError,
  runIngest,
  type IngestFile,
  type IngestMetadata,
  type RunIngestDependencies,
  type RunIngestProgressEvent,
} from './run-ingest.js';

const timestamp = '2026-07-19T12:00:00.000Z';
const files: IngestFile[] = [
  {
    relativePath: 'DCIM/one.mov',
    pathSegments: ['DCIM', 'one.mov'],
    sizeBytes: 3,
    modifiedAt: timestamp,
  },
  {
    relativePath: String.raw`DCIM/literal\name.mov`,
    pathSegments: ['DCIM', String.raw`literal\name.mov`],
    sizeBytes: 4,
    modifiedAt: timestamp,
  },
];

function metadata(overrides: Partial<IngestMetadata> = {}): IngestMetadata {
  return {
    captureAt: timestamp,
    captureDay: '2026-07-19',
    captureAtSource: 'filesystem-modifiedAt',
    captureAtRaw: timestamp,
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
    ...overrides,
  };
}

function dependencies(calls: string[], progress: RunIngestProgressEvent[]): RunIngestDependencies {
  return {
    now: () => timestamp,
    ids: {
      source: () => 'source-1',
      session: () => 'session-1',
      file: (file) => file.relativePath,
    },
    identifySource: async () => ({ kind: 'new', sourceId: 'source-1' }),
    upsertSource: async () => calls.push('source'),
    createSession: async () => calls.push('session:discovering'),
    updateSession: async (_id, status) => calls.push(`session:${status}`),
    scan: async function* () {
      yield* files;
    },
    classify: async (file) => ({
      decision: file.relativePath.includes('one') ? 'new' : 'known',
      verifiedCopy: file.relativePath.includes('one') ? false : true,
    }),
    persistSourceFile: async (file, classification) => {
      calls.push(`persist:${file.relativePath}:${classification.decision}`);
      return { id: file.relativePath };
    },
    metadata: async (file) =>
      metadata({
        captureAt: file.modifiedAt,
        captureDay: file.modifiedAt.slice(0, 10),
        captureAtRaw: file.modifiedAt,
      }),
    plan: async (file) => {
      calls.push(`plan:${file.relativePath}`);
      return { destinationPath: `/archive/${file.pathSegments.join('|')}` };
    },
    copy: async (file) => {
      calls.push(`copy:${file.relativePath}`);
      return { status: 'completed', bytesCopied: file.sizeBytes, checksum: 'abc' };
    },
    markFileFailed: async (fileId, code) => calls.push(`failed:${fileId}:${code}`),
    snapshotManifest: async () => calls.push('manifest'),
    emit: (event) => progress.push(event),
  };
}

describe('runIngest', () => {
  it('adopts a precreated durable session without creating a duplicate', async () => {
    const calls: string[] = [];
    const progress: RunIngestProgressEvent[] = [];
    const deps = dependencies(calls, progress);
    deps.adoptSessionSource = async (sessionId, sourceId) =>
      calls.push(`adopt:${sessionId}:${sourceId}`);

    const result = await runIngest(
      {
        sourceRoot: '/source',
        destinationRoot: '/archive',
        sourceLabel: 'CARD',
        precreatedSessionId: 'session-1',
      },
      deps,
    );

    expect(result.status).toBe('completed');
    expect(calls).toContain('adopt:session-1:source-1');
    expect(calls).not.toContain('session:discovering');
  });

  it('runs the durable state machine sequentially and skips only storage-confirmed known files', async () => {
    const calls: string[] = [];
    const progress: RunIngestProgressEvent[] = [];

    const result = await runIngest(
      { sourceRoot: '/source', destinationRoot: '/archive', sourceLabel: 'CARD' },
      dependencies(calls, progress),
    );

    expect(result).toEqual({
      sessionId: 'session-1',
      status: 'completed',
      completedFiles: 1,
      failedFiles: 0,
      skippedFiles: 1,
      collisions: 0,
    });
    expect(calls).toEqual([
      'source',
      'session:discovering',
      'session:analyzing',
      'persist:DCIM/one.mov:new',
      String.raw`persist:DCIM/literal\name.mov:known`,
      'session:ready',
      'session:copying',
      'plan:DCIM/one.mov',
      'copy:DCIM/one.mov',
      'manifest',
      'session:verifying',
      'session:completed',
      'manifest',
    ]);
    expect(progress.some((event) => event.type === 'file-completed')).toBe(true);
  });

  it('records file failures and continues to the next file', async () => {
    const calls: string[] = [];
    const progress: RunIngestProgressEvent[] = [];
    const deps = dependencies(calls, progress);
    deps.classify = async () => ({ decision: 'new', verifiedCopy: false });
    let copies = 0;
    deps.copy = async (file) => {
      copies += 1;
      if (copies === 1) throw Object.assign(new Error('read failed'), { code: 'READ_FAILED' });
      return { status: 'completed', bytesCopied: file.sizeBytes, checksum: 'ok' };
    };

    const result = await runIngest(
      { sourceRoot: '/source', destinationRoot: '/archive', sourceLabel: 'CARD' },
      deps,
    );

    expect(result).toMatchObject({ status: 'completed', completedFiles: 1, failedFiles: 1 });
    expect(calls).toContain('failed:DCIM/one.mov:READ_FAILED');
    expect(copies).toBe(2);
  });

  it('honors bounded copy concurrency', async () => {
    const deps = dependencies([], []);
    deps.classify = async () => ({ decision: 'new', verifiedCopy: false });
    deps.copyConcurrency = 2;
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    deps.copy = async (file) => {
      active += 1;
      maximum = Math.max(maximum, active);
      if (maximum === 2) release();
      await gate;
      active -= 1;
      return { status: 'completed', bytesCopied: file.sizeBytes, checksum: 'ok' };
    };

    const result = await runIngest(
      { sourceRoot: '/source', destinationRoot: '/archive', sourceLabel: 'CARD' },
      deps,
    );

    expect(maximum).toBe(2);
    expect(result.completedFiles).toBe(2);
  });

  it('stops scheduling on source loss, database failure, and cancellation', async () => {
    for (const scenario of ['source', 'database', 'cancel'] as const) {
      const calls: string[] = [];
      const progress: RunIngestProgressEvent[] = [];
      const deps = dependencies(calls, progress);
      const terminalCodes: string[] = [];
      const updateSession = deps.updateSession;
      deps.updateSession = async (id, status, at, failure) => {
        if (failure !== undefined) terminalCodes.push(failure.code);
        return updateSession(id, status, at, failure);
      };
      const controller = new AbortController();
      if (scenario === 'source') {
        deps.scan = async function* () {
          yield files[0]!;
          throw new FatalIngestError('SOURCE_UNAVAILABLE', 'source removed');
        };
      } else if (scenario === 'database') {
        deps.persistSourceFile = async () => {
          throw new Error('database unavailable');
        };
      } else {
        deps.scan = async function* () {
          controller.abort();
          yield files[0]!;
        };
      }

      const result = await runIngest(
        { sourceRoot: '/source', destinationRoot: '/archive', sourceLabel: 'CARD' },
        { ...deps, signal: controller.signal },
      );

      expect(result.status).toBe(scenario === 'cancel' ? 'cancelled' : 'failed');
      expect(calls.some((call) => call.startsWith('copy:'))).toBe(false);
      expect(calls.at(-2)).toBe(`session:${scenario === 'cancel' ? 'cancelled' : 'failed'}`);
      expect(calls.at(-1)).toBe('manifest');
      expect(terminalCodes).toEqual([
        scenario === 'cancel'
          ? 'INGEST_CANCELLED'
          : scenario === 'database'
            ? 'DATABASE_FAILED'
            : 'SOURCE_UNAVAILABLE',
      ]);
    }
  });

  it('treats persistence failure from the copy lifecycle as fatal', async () => {
    const calls: string[] = [];
    const progress: RunIngestProgressEvent[] = [];
    const deps = dependencies(calls, progress);
    deps.classify = async () => ({ decision: 'new', verifiedCopy: false });
    let copies = 0;
    deps.copy = async () => {
      copies += 1;
      throw Object.assign(new Error('progress update failed'), { code: 'DATABASE_FAILED' });
    };

    const result = await runIngest(
      { sourceRoot: '/source', destinationRoot: '/archive', sourceLabel: 'CARD' },
      deps,
    );

    expect(result.status).toBe('failed');
    expect(copies).toBe(1);
    expect(calls.at(-2)).toBe('session:failed');
    expect(calls.at(-1)).toBe('manifest');
  });

  it('falls back to modifiedAt when metadata extraction fails and continues', async () => {
    const calls: string[] = [];
    const progress: RunIngestProgressEvent[] = [];
    const deps = dependencies(calls, progress);
    const captures: string[] = [];
    const warnings: string[] = [];
    deps.metadata = async () => {
      throw new Error('metadata tool failed');
    };
    deps.persistSourceFile = async (file) => {
      captures.push(file.captureAt);
      return { id: file.id };
    };
    deps.log = async (event) => {
      warnings.push(`${event.phase}:${event.message}`);
    };

    const result = await runIngest(
      { sourceRoot: '/source', destinationRoot: '/archive', sourceLabel: 'CARD' },
      deps,
    );

    expect(result.status).toBe('completed');
    expect(captures).toEqual([timestamp, timestamp]);
    expect(warnings).toEqual([
      'metadata:Metadata extraction failed; using filesystem timestamp',
      'metadata:Metadata extraction failed; using filesystem timestamp',
    ]);
  });

  it('persists normalized metadata before planning and plans with captureDay', async () => {
    const calls: string[] = [];
    const deps = dependencies(calls, []);
    deps.metadata = async () =>
      metadata({
        captureAt: '2024-12-31T23:30:01-07:00',
        captureDay: '2024-12-31',
        captureAtSource: 'DateTimeOriginal',
        captureAtRaw: '2024:12:31 23:30:01-07:00',
        captureTimezoneKind: 'offset',
        captureOffsetMinutes: -420,
        captureOffsetSource: 'inline',
        captureOffsetRaw: '-07:00',
      });
    const persisted: Array<{ captureDay: string; captureAtSource?: string }> = [];
    const planned: string[] = [];
    deps.persistSourceFile = async (file) => {
      persisted.push(file);
      return { id: file.id };
    };
    deps.plan = async (file) => {
      planned.push(file.captureDay);
      return { destinationPath: `/archive/${file.captureDay}/${file.relativePath}` };
    };

    const result = await runIngest(
      { sourceRoot: '/source', destinationRoot: '/archive', sourceLabel: 'CARD' },
      deps,
    );

    expect(result.status).toBe('completed');
    expect(persisted[0]).toMatchObject({
      captureAt: '2024-12-31T23:30:01-07:00',
      captureDay: '2024-12-31',
      captureAtSource: 'DateTimeOriginal',
    });
    expect(planned).toEqual(['2024-12-31']);
  });

  it('rejects invalid adapter metadata and degrades to a validated filesystem fallback', async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const persisted: Array<{ captureAtSource: string; captureDay: string; gpsPresent: boolean }> =
      [];
    const deps = dependencies(calls, []);
    deps.metadata = async () =>
      ({
        captureAt: 'not-a-date',
        captureDay: '../../escape',
        captureAtSource: 'renderer-value',
        captureTimezoneKind: 'guessed',
        gpsPresent: 'yes',
      }) as never;
    deps.persistSourceFile = async (file) => {
      persisted.push(file);
      return { id: file.id };
    };
    deps.log = async (event) => {
      logs.push(`${event.errorCode}:${event.message}`);
    };

    const result = await runIngest(
      { sourceRoot: '/source', destinationRoot: '/archive', sourceLabel: 'CARD' },
      deps,
    );

    expect(result.status).toBe('completed');
    expect(persisted[0]).toMatchObject({
      captureAtSource: 'filesystem-modifiedAt',
      captureDay: '2026-07-19',
      gpsPresent: false,
    });
    expect(logs).toContain(
      'METADATA_FAILED:Metadata extraction failed; using filesystem timestamp',
    );
  });

  it('uses session start end-to-end when metadata fails and modifiedAt is invalid', async () => {
    const deps = dependencies([], []);
    deps.scan = async function* () {
      yield { ...files[0]!, modifiedAt: 'invalid-mtime' };
    };
    deps.metadata = async () => {
      throw new Error('tool unavailable');
    };
    const persisted: IngestMetadata[] = [];
    const planned: string[] = [];
    deps.persistSourceFile = async (file) => {
      persisted.push(file);
      return { id: file.id };
    };
    deps.plan = async (file) => {
      planned.push(file.captureDay);
      return { destinationPath: `/archive/${file.captureDay}/one.mov` };
    };

    const result = await runIngest(
      { sourceRoot: '/source', destinationRoot: '/archive', sourceLabel: 'CARD' },
      deps,
    );

    expect(result.status).toBe('completed');
    expect(persisted[0]).toMatchObject({
      captureAt: timestamp,
      captureAtSource: 'session-start',
      captureAtRaw: timestamp,
      captureDay: '2026-07-19',
      captureTimezoneKind: 'fallback',
    });
    expect(planned).toEqual(['2026-07-19']);
  });

  it('isolates progress callback exceptions including completed events', async () => {
    const calls: string[] = [];
    const deps = dependencies(calls, []);
    const emitted: RunIngestProgressEvent[] = [];
    deps.emit = (event) => {
      emitted.push(event);
      throw new Error(`consumer rejected ${event.type}`);
    };

    const result = await runIngest(
      { sourceRoot: '/source', destinationRoot: '/archive', sourceLabel: 'CARD' },
      deps,
    );

    expect(result).toMatchObject({ status: 'completed', completedFiles: 1, skippedFiles: 1 });
    expect(calls).toContain('session:completed');
    expect(emitted.some((event) => event.type === 'file-completed')).toBe(true);
    expect(
      emitted.some((event) => event.type === 'session-status' && event.status === 'completed'),
    ).toBe(true);
  });

  it('stops subsequent jobs when a copy reports source disappearance', async () => {
    const calls: string[] = [];
    const deps = dependencies(calls, []);
    const terminalCodes: string[] = [];
    const updateSession = deps.updateSession;
    deps.updateSession = async (id, status, at, failure) => {
      if (failure !== undefined) terminalCodes.push(failure.code);
      return updateSession(id, status, at, failure);
    };
    deps.classify = async () => ({ decision: 'new', verifiedCopy: false });
    let copies = 0;
    deps.copy = async () => {
      copies += 1;
      throw Object.assign(new Error('card removed'), { code: 'SOURCE_UNAVAILABLE' });
    };

    const result = await runIngest(
      { sourceRoot: '/source', destinationRoot: '/archive', sourceLabel: 'CARD' },
      deps,
    );

    expect(result.status).toBe('failed');
    expect(copies).toBe(1);
    expect(calls.at(-2)).toBe('session:failed');
    expect(calls.at(-1)).toBe('manifest');
    expect(terminalCodes).toEqual(['SOURCE_UNAVAILABLE']);
  });
});

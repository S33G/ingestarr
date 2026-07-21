import { describe, expect, it } from 'vitest';

import { createRepositories, migrateDatabase, openDatabase } from './index.js';

const at = '2026-07-19T12:00:00.000Z';

describe('manifest repository projection', () => {
  it('loads a transactionally consistent full session snapshot', () => {
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const repositories = createRepositories(connection.database);
    repositories.sources.create({
      id: 'source',
      kind: 'folder',
      displayName: 'CARD',
      firstSeenAt: at,
      lastSeenAt: at,
      createdAt: at,
      updatedAt: at,
    });
    repositories.sessions.create({
      id: 'session',
      sourceId: 'source',
      status: 'copying',
      startedAt: at,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: at,
      updatedAt: at,
    });
    repositories.sourceFiles.recordVersion({
      id: 'file',
      sourceId: 'source',
      ingestSessionId: 'session',
      versionKey: 'v1',
      relativePath: 'DCIM/clip.mov',
      name: 'clip.mov',
      extension: '.mov',
      sizeBytes: 3,
      modifiedAt: at,
      kind: 'video',
      status: 'ready',
      quickChecksum: null,
      fullChecksum: null,
      captureAt: at,
      lastSeenAt: at,
      createdAt: at,
      updatedAt: at,
    });
    repositories.copiedFiles.plan({
      id: 'copy',
      sourceFileId: 'file',
      ingestSessionId: 'session',
      destinationPath: '/archive/clip.mov',
      status: 'planned',
      expectedBytes: 3,
      copiedBytes: 0,
      checksum: null,
      startedAt: null,
      verifiedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: at,
      updatedAt: at,
    });

    expect(repositories.manifests.loadSession('session')).toEqual({
      session: expect.objectContaining({ id: 'session', status: 'copying' }),
      source: expect.objectContaining({ id: 'source', displayName: 'CARD' }),
      files: [
        expect.objectContaining({
          id: 'file',
          relativePath: 'DCIM/clip.mov',
          destinationPath: '/archive/clip.mov',
          copiedBytes: 0,
        }),
      ],
    });
    connection.close();
  });

  it('rejects invalid session transitions and terminal timestamps', () => {
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const repositories = createRepositories(connection.database);
    repositories.sources.create({
      id: 'source',
      kind: 'folder',
      displayName: 'CARD',
      firstSeenAt: at,
      lastSeenAt: at,
      createdAt: at,
      updatedAt: at,
    });
    repositories.sessions.create({
      id: 'session',
      sourceId: 'source',
      status: 'discovering',
      startedAt: at,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: at,
      updatedAt: at,
    });

    expect(() =>
      repositories.sessions.updateStatus('session', {
        status: 'completed',
        completedAt: at,
        errorCode: null,
        errorMessage: null,
        updatedAt: at,
      }),
    ).toThrow(/invalid ingest-session transition/i);
    expect(() =>
      repositories.sessions.updateStatus('session', {
        status: 'analyzing',
        completedAt: at,
        errorCode: null,
        errorMessage: null,
        updatedAt: at,
      }),
    ).toThrow(/completedAt/i);
    connection.close();
  });
});

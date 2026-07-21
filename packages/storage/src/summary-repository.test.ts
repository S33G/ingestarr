import { describe, expect, it } from 'vitest';

import { createRepositories, migrateDatabase, openDatabase } from './index.js';

const at = '2026-07-19T12:00:00.000Z';

function fixture() {
  const connection = openDatabase(':memory:');
  migrateDatabase(connection.database);
  const repositories = createRepositories(connection.database);
  repositories.sources.create({
    id: 'source',
    kind: 'folder',
    displayName: 'Generated card',
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
  const add = (
    id: string,
    day: string,
    mediaType: 'photo' | 'video' | 'unknown',
    status: 'verified' | 'started',
    size: number,
  ) => {
    repositories.sourceFiles.recordVersion({
      id,
      sourceId: 'source',
      ingestSessionId: 'session',
      versionKey: id,
      relativePath: `DCIM/${id}.${mediaType === 'video' ? 'mov' : 'jpg'}`,
      name: `${id}.${mediaType === 'video' ? 'mov' : 'jpg'}`,
      extension: mediaType === 'video' ? '.mov' : '.jpg',
      sizeBytes: size,
      modifiedAt: `${day}T08:00:00.000Z`,
      kind: mediaType === 'video' ? 'video' : 'image',
      status: 'ready',
      quickChecksum: id,
      fullChecksum: null,
      captureAt: `${day}T08:00:00.000Z`,
      captureDay: day,
      mediaType,
      cameraMake: 'Safe',
      cameraModel: 'Generated',
      lastSeenAt: at,
      createdAt: at,
      updatedAt: at,
    });
    repositories.copiedFiles.plan({
      id: `copy-${id}`,
      sourceFileId: id,
      ingestSessionId: 'session',
      destinationPath: `/archive/${id}`,
      status: 'planned',
      expectedBytes: size,
      copiedBytes: 0,
      checksum: null,
      startedAt: null,
      verifiedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: at,
      updatedAt: at,
    });
    repositories.copiedFiles.markStarted(`copy-${id}`, at);
    if (status === 'verified')
      repositories.copiedFiles.markVerified(`copy-${id}`, size, `sha-${id}`, at);
  };
  return { connection, repositories, add };
}

describe('summary repository', () => {
  it('groups only verified copies with filters and deterministic fallback days', () => {
    const { connection, repositories, add } = fixture();
    add('photo', '2026-07-19', 'photo', 'verified', 10);
    add('video', '2026-07-19', 'video', 'verified', 20);
    add('unverified', '2026-07-20', 'photo', 'started', 99);

    expect(repositories.summaries.listDays({})).toEqual([
      {
        captureDay: '2026-07-19',
        photoCount: 1,
        videoCount: 1,
        unknownCount: 0,
        totalSizeBytes: 30,
      },
    ]);
    expect(repositories.summaries.listDays({ mediaType: 'photo' })[0]).toMatchObject({
      photoCount: 1,
      videoCount: 0,
      totalSizeBytes: 10,
    });
    connection.close();
  });

  it('uses stable path/id cursor paging without duplicates and never returns paths', () => {
    const { connection, repositories, add } = fixture();
    for (const id of ['c', 'a', 'b']) add(id, '2026-07-19', 'photo', 'verified', 10);

    const first = repositories.summaries.listMediaByDay({
      captureDay: '2026-07-19',
      limit: 2,
    });
    const second = repositories.summaries.listMediaByDay({
      captureDay: '2026-07-19',
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });

    expect(first.items.map((item) => item.originalFilename)).toEqual(['a.jpg', 'b.jpg']);
    expect(second.items.map((item) => item.originalFilename)).toEqual(['c.jpg']);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);
    expect(first.items[0]).not.toHaveProperty('destinationPath');
    expect(first.items[0]).not.toHaveProperty('cachePath');
    expect(first.items[0]).toMatchObject({
      copyId: 'copy-a',
      checksum: 'sha-a',
      thumbnail: { state: 'missing' },
    });
    connection.close();
  });

  it('stores success/failure only for verified copied files', () => {
    const { connection, repositories, add } = fixture();
    add('ready', '2026-07-19', 'photo', 'verified', 10);
    add('bad', '2026-07-19', 'photo', 'started', 10);

    expect(() =>
      repositories.thumbnails.recordFailure({
        id: 'failure',
        copiedFileId: 'copy-bad',
        sourceFileId: 'bad',
        variant: 'grid',
        errorCode: 'THUMBNAIL_FAILED',
        safeMessage: 'Thumbnail unavailable.',
        retryCount: 1,
        updatedAt: at,
      }),
    ).toThrow(/verified/i);
    repositories.thumbnails.recordFailure({
      id: 'failure-ready',
      copiedFileId: 'copy-ready',
      sourceFileId: 'ready',
      variant: 'grid',
      errorCode: 'THUMBNAIL_FAILED',
      safeMessage: 'Thumbnail unavailable.',
      retryCount: 2,
      updatedAt: at,
    });
    expect(
      repositories.summaries.listMediaByDay({ captureDay: '2026-07-19', limit: 10 }).items[0]
        ?.thumbnail,
    ).toEqual({
      state: 'failed',
      errorCode: 'THUMBNAIL_FAILED',
      safeMessage: 'Thumbnail unavailable.',
      retryCount: 2,
      attemptCount: 2,
      nextRetryAt: null,
      maxAttempts: 3,
    });
    connection.close();
  });

  it('stores one content artifact with distinct associations for equal checksums', () => {
    const { connection, repositories, add } = fixture();
    add('one', '2026-07-19', 'photo', 'verified', 10);
    add('two', '2026-07-19', 'photo', 'verified', 10);
    connection.database
      .prepare(
        "UPDATE copied_files SET checksum = 'same-checksum' WHERE id IN ('copy-one', 'copy-two')",
      )
      .run();
    for (const id of ['one', 'two']) {
      repositories.thumbnails.recordReady({
        id: `thumbnail-${id}`,
        copiedFileId: `copy-${id}`,
        sourceFileId: id,
        variant: 'grid',
        cachePath: '/cache/shared.webp',
        cacheKey: 'shared-key',
        checksum: 'artifact-sha',
        generatorVersion: 'thumb-v2',
        mimeType: 'image/webp',
        width: 10,
        height: 10,
        sizeBytes: 100,
        retryCount: 0,
        createdAt: at,
        updatedAt: at,
      });
    }

    expect(
      connection.database.prepare('SELECT COUNT(*) FROM thumbnail_artifacts').pluck().get(),
    ).toBe(1n);
    expect(connection.database.prepare('SELECT COUNT(*) FROM thumbnails').pluck().get()).toBe(2n);
    const items = repositories.summaries.listMediaByDay({
      captureDay: '2026-07-19',
      limit: 10,
    }).items;
    expect(items.map((item) => item.thumbnail.state)).toEqual(['ready', 'ready']);
    connection.close();
  });

  it('rolls back artifact creation when association persistence fails', () => {
    const { connection, repositories, add } = fixture();
    add('ready', '2026-07-19', 'photo', 'verified', 10);
    connection.database.exec(`
      CREATE TRIGGER inject_thumbnail_failure
      BEFORE INSERT ON thumbnails
      BEGIN
        SELECT RAISE(ABORT, 'injected association failure');
      END;
    `);

    expect(() =>
      repositories.thumbnails.recordReady({
        id: 'thumbnail',
        copiedFileId: 'copy-ready',
        sourceFileId: 'ready',
        variant: 'grid',
        cachePath: '/cache/rollback.webp',
        cacheKey: 'rollback-key',
        checksum: 'artifact-sha',
        generatorVersion: 'thumb-v2',
        mimeType: 'image/webp',
        width: 10,
        height: 10,
        sizeBytes: 100,
        retryCount: 0,
        createdAt: at,
        updatedAt: at,
      }),
    ).toThrow(/injected/i);
    expect(
      connection.database.prepare('SELECT COUNT(*) FROM thumbnail_artifacts').pluck().get(),
    ).toBe(0n);
    expect(connection.database.prepare('SELECT COUNT(*) FROM thumbnails').pluck().get()).toBe(0n);
    connection.close();
  });

  it('reloads durable retry state after repository recreation', () => {
    const { connection, repositories, add } = fixture();
    add('retry', '2026-07-19', 'photo', 'verified', 10);
    repositories.thumbnails.recordFailure({
      id: 'failure',
      copiedFileId: 'copy-retry',
      sourceFileId: 'retry',
      variant: 'grid',
      errorCode: 'THUMBNAIL_FAILED',
      safeMessage: 'Thumbnail unavailable.',
      retryCount: 1,
      attemptCount: 1,
      nextRetryAt: '2026-07-19T12:01:00.000Z',
      maxAttempts: 3,
      updatedAt: at,
    });

    const recreated = createRepositories(connection.database);

    expect(recreated.thumbnails.retryState('copy-retry', 'grid')).toEqual({
      attemptCount: 1,
      nextRetryAt: '2026-07-19T12:01:00.000Z',
      maxAttempts: 3,
    });
    connection.close();
  });
});

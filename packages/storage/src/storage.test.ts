import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultAppSettings } from '@ingestarr/shared-types';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createRepositories,
  fromSqliteInteger,
  migrateDatabase,
  migrations,
  openDatabase,
  toSqliteInteger,
  type Migration,
} from './index.js';

const timestamp = '2026-07-19T12:00:00.000Z';
const laterTimestamp = '2026-07-19T13:00:00.000Z';
const temporaryDirectories: string[] = [];

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ingestarr-storage-'));
  temporaryDirectories.push(directory);
  return join(directory, 'storage.sqlite');
}

function createMigratedStorage(path = ':memory:') {
  const connection = openDatabase(path);
  migrateDatabase(connection.database);
  return {
    connection,
    repositories: createRepositories(connection.database),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('database connection', () => {
  it('enables foreign keys, a busy timeout, and WAL where supported', () => {
    const connection = openDatabase(':memory:');

    expect(connection.database.pragma('foreign_keys', { simple: true })).toBe(1n);
    expect(connection.database.pragma('busy_timeout', { simple: true })).toBe(5_000n);
    expect(connection.journalMode).toBe('memory');

    connection.close();
    expect(connection.database.open).toBe(false);
  });

  it('uses WAL for a temporary on-disk database', () => {
    const connection = openDatabase(temporaryDatabasePath());

    expect(connection.journalMode).toBe('wal');
    connection.close();
  });
});

describe('migrations', () => {
  it('creates the complete schema, constraints, and lookup indexes', () => {
    const { connection } = createMigratedStorage();

    const tables = connection.database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .pluck()
      .all();
    expect(tables).toEqual([
      'copied_files',
      'ingest_sessions',
      'schema_migrations',
      'session_recovery_context',
      'settings',
      'source_files',
      'source_identity_aliases',
      'source_identity_observations',
      'source_reconciliation_audit',
      'source_throughput_stats',
      'sources',
      'thumbnail_artifacts',
      'thumbnails',
    ]);

    const indexes = connection.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
      .pluck()
      .all();
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_identity_fingerprint',
        'idx_identity_strong_platform_id',
        'idx_sessions_source_status',
        'idx_source_files_source_session_status',
        'idx_source_files_quick_checksum',
        'idx_source_files_full_checksum',
        'idx_source_files_capture_at',
        'idx_thumbnails_source_file',
      ]),
    );

    expect(() =>
      connection.database
        .prepare(
          `INSERT INTO ingest_sessions
            (id, source_id, status, started_at, created_at, updated_at)
           VALUES ('bad', 'missing', 'not-a-status', ?, ?, ?)`,
        )
        .run(timestamp, timestamp, timestamp),
    ).toThrow();
    connection.close();
  });

  it('is repeatable and rejects migration history tampering', () => {
    const connection = openDatabase(':memory:');

    expect(migrateDatabase(connection.database)).toEqual({
      applied: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      currentVersion: 9,
    });
    expect(migrateDatabase(connection.database)).toEqual({ applied: [], currentVersion: 9 });

    connection.database
      .prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1')
      .run('tampered');
    expect(() => migrateDatabase(connection.database)).toThrow(/checksum/i);
    connection.close();
  });

  it('rolls back every statement in a failed migration', () => {
    const connection = openDatabase(':memory:');
    const brokenMigration: Migration = {
      version: 1,
      name: 'broken',
      sql: 'CREATE TABLE should_rollback (id TEXT); THIS IS INVALID SQL;',
    };

    expect(() => migrateDatabase(connection.database, [brokenMigration])).toThrow();
    const table = connection.database
      .prepare("SELECT name FROM sqlite_master WHERE name = 'should_rollback'")
      .get();
    expect(table).toBeUndefined();
    expect(
      connection.database.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get(),
    ).toBe(0n);
    connection.close();
  });

  it('upgrades an existing version-three database to artifact associations', () => {
    const connection = openDatabase(':memory:');
    expect(migrateDatabase(connection.database, migrations.slice(0, 3))).toEqual({
      applied: [1, 2, 3],
      currentVersion: 3,
    });
    connection.database
      .prepare(
        `INSERT INTO sources
          (id, kind, display_name, first_seen_at, last_seen_at, created_at, updated_at)
         VALUES ('source', 'folder', 'Generated', ?, ?, ?, ?)`,
      )
      .run(timestamp, timestamp, timestamp, timestamp);
    connection.database
      .prepare(
        `INSERT INTO ingest_sessions
          (id, source_id, status, started_at, created_at, updated_at)
         VALUES ('session', 'source', 'copying', ?, ?, ?)`,
      )
      .run(timestamp, timestamp, timestamp);
    connection.database
      .prepare(
        `INSERT INTO source_files
          (id, source_id, ingest_session_id, version_key, relative_path, name, extension,
           size_bytes, modified_at, kind, status, quick_checksum, full_checksum, capture_at,
           last_seen_at, created_at, updated_at)
         VALUES ('file', 'source', 'session', 'v1', 'DCIM/a.jpg', 'a.jpg', '.jpg',
                 10, ?, 'image', 'completed', NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(timestamp, timestamp, timestamp, timestamp);
    connection.database
      .prepare(
        `INSERT INTO copied_files
          (id, source_id, source_file_id, ingest_session_id, destination_path, status,
           expected_bytes, copied_bytes, checksum, started_at, verified_at, created_at, updated_at)
         VALUES ('copy', 'source', 'file', 'session', '/archive/a.jpg', 'verified',
                 10, 10, 'copy-sha', ?, ?, ?, ?)`,
      )
      .run(timestamp, timestamp, timestamp, timestamp);
    connection.database
      .prepare(
        `INSERT INTO thumbnails
          (id, source_file_id, variant, cache_path, mime_type, width, height, size_bytes,
           created_at, updated_at, copied_file_id, cache_key, checksum,
           generator_version, retry_count)
         VALUES ('thumbnail', 'file', 'grid', '/cache/a.webp', 'image/webp', 10, 10, 100,
                 ?, ?, 'copy', 'cache-key', 'artifact-sha', 'thumb-v1', 1)`,
      )
      .run(timestamp, timestamp);

    expect(migrateDatabase(connection.database)).toEqual({
      applied: [4, 5, 6, 7, 8, 9],
      currentVersion: 9,
    });
    expect(
      connection.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thumbnail_artifacts'",
        )
        .pluck()
        .get(),
    ).toBe('thumbnail_artifacts');
    expect(
      connection.database
        .prepare(
          `SELECT association.id, artifact.cache_path AS cachePath
             FROM thumbnails association
             JOIN thumbnail_artifacts artifact
               ON artifact.cache_key = association.artifact_cache_key`,
        )
        .get(),
    ).toEqual({ id: 'thumbnail', cachePath: '/cache/a.webp' });
    connection.close();
  });
});

describe('safe SQLite integers', () => {
  it('round-trips zero and Number.MAX_SAFE_INTEGER', () => {
    expect(fromSqliteInteger(toSqliteInteger(0))).toBe(0);
    expect(fromSqliteInteger(toSqliteInteger(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('rejects unsafe domain numbers and database integers', () => {
    expect(() => toSqliteInteger(Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integer/i);
    expect(() => fromSqliteInteger(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(/safe integer/i);
    expect(() => fromSqliteInteger(-1n)).toThrow(/non-negative/i);
  });
});

describe('repositories', () => {
  it('persists sources and non-unique identity observations for candidate lookup', () => {
    const { connection, repositories } = createMigratedStorage();
    repositories.sources.create({
      id: 'source-1',
      kind: 'removable-volume',
      displayName: 'CARD A',
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    repositories.sources.create({
      id: 'source-2',
      kind: 'removable-volume',
      displayName: 'CARD B',
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    for (const [id, sourceId] of [
      ['observation-1', 'source-1'],
      ['observation-2', 'source-2'],
    ] as const) {
      repositories.identityObservations.create({
        id,
        sourceId,
        observedAt: timestamp,
        algorithmVersion: 1,
        fingerprint: 'same-fallback-fingerprint',
        rawFacts: { volumeName: 'UNTITLED' },
        confidence: 'medium',
        strongPlatformId: sourceId === 'source-1' ? 'volume-uuid-1' : null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    expect(
      repositories.identityObservations
        .findCandidates({ fingerprint: 'same-fallback-fingerprint' })
        .map((source) => source.id),
    ).toEqual(['source-1', 'source-2']);
    expect(
      repositories.identityObservations.findCandidates({
        strongPlatformId: 'volume-uuid-1',
      }),
    ).toHaveLength(1);
    expect(repositories.identityObservations.listForSource('source-1')[0]?.rawFacts).toEqual({
      volumeName: 'UNTITLED',
    });
    connection.close();
  });

  it('enforces foreign keys and keeps source-file path versions without absolute paths', () => {
    const { connection, repositories } = createMigratedStorage();
    expect(() =>
      repositories.sourceFiles.recordVersion({
        id: 'orphan',
        sourceId: 'missing',
        ingestSessionId: null,
        versionKey: 'version-1',
        relativePath: 'DCIM/clip.mov',
        name: 'clip.mov',
        extension: '.mov',
        sizeBytes: 10,
        modifiedAt: timestamp,
        kind: 'video',
        status: 'discovered',
        quickChecksum: null,
        fullChecksum: null,
        captureAt: null,
        lastSeenAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ).toThrow();

    repositories.sources.create({
      id: 'source-1',
      kind: 'folder',
      displayName: 'Import',
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const baseVersion = {
      sourceId: 'source-1',
      ingestSessionId: null,
      relativePath: 'DCIM/clip.mov',
      name: 'clip.mov',
      extension: '.mov',
      sizeBytes: 10,
      modifiedAt: timestamp,
      kind: 'video' as const,
      status: 'discovered' as const,
      quickChecksum: null,
      fullChecksum: null,
      captureAt: null,
      lastSeenAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    repositories.sourceFiles.recordVersion({
      ...baseVersion,
      id: 'file-v1',
      versionKey: 'content-v1',
    });
    repositories.sourceFiles.recordVersion({
      ...baseVersion,
      id: 'file-v2',
      versionKey: 'content-v2',
      sizeBytes: 11,
    });
    for (const [id, absolutePath] of [
      ['posix', '/Volumes/CARD/DCIM/clip.mov'],
      ['windows-forward', 'C:/DCIM/clip.mov'],
      ['windows-backward', 'C:\\DCIM\\clip.mov'],
      ['windows-unc', '\\\\camera\\share\\clip.mov'],
    ] as const) {
      expect(() =>
        repositories.sourceFiles.recordVersion({
          ...baseVersion,
          id: `absolute-${id}`,
          versionKey: `content-${id}`,
          relativePath: absolutePath,
        }),
      ).toThrow(/relative path/i);
    }

    const insertPathDirectly = connection.database.prepare(
      `INSERT INTO source_files
        (id, source_id, version_key, relative_path, name, extension, size_bytes,
         modified_at, kind, status, last_seen_at, created_at, updated_at)
       VALUES (?, 'source-1', ?, ?, 'clip.mov', '.mov', 10, ?, 'video',
               'discovered', ?, ?, ?)`,
    );
    for (const [id, absolutePath] of [
      ['posix', '/Volumes/CARD/DCIM/clip.mov'],
      ['windows-forward', 'C:/DCIM/clip.mov'],
      ['windows-backward', 'C:\\DCIM\\clip.mov'],
      ['windows-unc', '\\\\camera\\share\\clip.mov'],
    ] as const) {
      expect(() =>
        insertPathDirectly.run(
          `direct-${id}`,
          `direct-content-${id}`,
          absolutePath,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
        ),
      ).toThrow();
    }
    expect(() =>
      repositories.sourceFiles.recordVersion({
        ...baseVersion,
        id: 'duplicate-version',
        versionKey: 'content-v1',
      }),
    ).toThrow();

    expect(repositories.sourceFiles.listVersions('source-1', 'DCIM/clip.mov')).toHaveLength(2);
    expect(repositories.sourceFiles.findById('file-v1')).not.toHaveProperty('absolutePath');
    const sourceFileColumns = connection.database
      .prepare("PRAGMA table_info('source_files')")
      .all() as Array<{ name: string }>;
    expect(sourceFileColumns.map((column) => column.name)).not.toContain('absolute_path');
    connection.close();
  });

  it('requires source-file sessions to belong to the same source and preserves delete behavior', () => {
    const { connection, repositories } = createMigratedStorage();
    for (const sourceId of ['source-1', 'source-2']) {
      repositories.sources.create({
        id: sourceId,
        kind: 'folder',
        displayName: sourceId,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      repositories.sessions.create({
        id: `session-${sourceId}`,
        sourceId,
        status: 'discovering',
        startedAt: timestamp,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    const mismatchedFile = {
      id: 'mismatched-file',
      sourceId: 'source-1',
      ingestSessionId: 'session-source-2',
      versionKey: 'mismatched-version',
      relativePath: 'DCIM/mismatch.mov',
      name: 'mismatch.mov',
      extension: '.mov',
      sizeBytes: 10,
      modifiedAt: timestamp,
      kind: 'video' as const,
      status: 'discovered' as const,
      quickChecksum: null,
      fullChecksum: null,
      captureAt: null,
      lastSeenAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(() => repositories.sourceFiles.recordVersion(mismatchedFile)).toThrow(/same source/i);

    expect(() =>
      connection.database
        .prepare(
          `INSERT INTO source_files
            (id, source_id, ingest_session_id, version_key, relative_path, name, extension,
             size_bytes, modified_at, kind, status, last_seen_at, created_at, updated_at)
           VALUES ('direct-mismatch', 'source-1', 'session-source-2', 'direct-version',
                   'DCIM/direct.mov', 'direct.mov', '.mov', 10, ?, 'video', 'discovered',
                   ?, ?, ?)`,
        )
        .run(timestamp, timestamp, timestamp, timestamp),
    ).toThrow();

    repositories.sourceFiles.recordVersion({
      ...mismatchedFile,
      id: 'matched-file',
      ingestSessionId: 'session-source-1',
      versionKey: 'matched-version',
      relativePath: 'DCIM/matched.mov',
      name: 'matched.mov',
    });
    connection.database.prepare("DELETE FROM ingest_sessions WHERE id = 'session-source-1'").run();
    expect(repositories.sourceFiles.findById('matched-file')).toMatchObject({
      sourceId: 'source-1',
      ingestSessionId: null,
    });
    connection.close();
  });

  it('matches file observations, records checksums, and updates last seen atomically', () => {
    const { connection, repositories } = createMigratedStorage();
    repositories.sources.create({
      id: 'source-1',
      kind: 'folder',
      displayName: 'Import',
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    repositories.sourceFiles.recordVersion({
      id: 'file-1',
      sourceId: 'source-1',
      ingestSessionId: null,
      versionKey: 'content-v1',
      relativePath: 'a.jpg',
      name: 'a.jpg',
      extension: '.jpg',
      sizeBytes: Number.MAX_SAFE_INTEGER,
      modifiedAt: timestamp,
      kind: 'image',
      status: 'analyzing',
      quickChecksum: 'quick-1',
      fullChecksum: null,
      captureAt: timestamp,
      lastSeenAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(
      repositories.sourceFiles.findMatching({
        sourceId: 'source-1',
        relativePath: 'a.jpg',
        sizeBytes: Number.MAX_SAFE_INTEGER,
        modifiedAt: timestamp,
        quickChecksum: 'quick-1',
      })?.id,
    ).toBe('file-1');
    repositories.sourceFiles.recordObservation('file-1', {
      quickChecksum: 'quick-2',
      fullChecksum: 'full-1',
      lastSeenAt: laterTimestamp,
      updatedAt: laterTimestamp,
    });
    expect(repositories.sourceFiles.findById('file-1')).toMatchObject({
      sizeBytes: Number.MAX_SAFE_INTEGER,
      quickChecksum: 'quick-2',
      fullChecksum: 'full-1',
      lastSeenAt: laterTimestamp,
    });
    connection.close();
  });

  it('tracks sessions and finds only incomplete recovery work', () => {
    const { connection, repositories } = createMigratedStorage();
    repositories.sources.create({
      id: 'source-1',
      kind: 'folder',
      displayName: 'Import',
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    for (const [id, status] of [
      ['session-active', 'copying'],
      ['session-done', 'completed'],
    ] as const) {
      repositories.sessions.create({
        id,
        sourceId: 'source-1',
        status,
        startedAt: timestamp,
        completedAt: status === 'completed' ? laterTimestamp : null,
        errorCode: null,
        errorMessage: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    expect(repositories.sessions.findIncomplete().map((session) => session.id)).toEqual([
      'session-active',
    ]);
    repositories.sessions.updateStatus('session-active', {
      status: 'failed',
      completedAt: laterTimestamp,
      errorCode: 'COPY_INTERRUPTED',
      errorMessage: 'Device removed',
      updatedAt: laterTimestamp,
    });
    expect(repositories.sessions.findById('session-active')).toMatchObject({
      status: 'failed',
      errorCode: 'COPY_INTERRUPTED',
    });
    expect(repositories.sessions.findIncomplete()).toHaveLength(0);
    connection.close();
  });

  it('adopts a precreated session source before file discovery', () => {
    const { connection, repositories } = createMigratedStorage();
    for (const sourceId of ['pending-source', 'identified-source']) {
      repositories.sources.create({
        id: sourceId,
        kind: 'folder',
        displayName: sourceId,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
    repositories.sessions.create({
      id: 'session-1',
      sourceId: 'pending-source',
      status: 'discovering',
      startedAt: timestamp,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    repositories.sessions.adoptSource('session-1', 'identified-source', laterTimestamp);

    expect(repositories.sessions.findById('session-1')).toMatchObject({
      sourceId: 'identified-source',
      status: 'discovering',
      updatedAt: laterTimestamp,
    });
    expect(repositories.sources.findById('pending-source')).toBeUndefined();
    connection.close();
  });

  it('tracks copied-file lifecycle and separates observations from verified copies', () => {
    const { connection, repositories } = createMigratedStorage();
    repositories.sources.create({
      id: 'source-1',
      kind: 'folder',
      displayName: 'Import',
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    repositories.sessions.create({
      id: 'session-1',
      sourceId: 'source-1',
      status: 'copying',
      startedAt: timestamp,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    repositories.sourceFiles.recordVersion({
      id: 'file-1',
      sourceId: 'source-1',
      ingestSessionId: 'session-1',
      versionKey: 'content-v1',
      relativePath: 'a.mov',
      name: 'a.mov',
      extension: '.mov',
      sizeBytes: 100,
      modifiedAt: timestamp,
      kind: 'video',
      status: 'ready',
      quickChecksum: 'quick',
      fullChecksum: 'full',
      captureAt: null,
      lastSeenAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    repositories.sources.create({
      id: 'source-2',
      kind: 'folder',
      displayName: 'Other import',
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    repositories.sessions.create({
      id: 'session-other-source',
      sourceId: 'source-2',
      status: 'copying',
      startedAt: timestamp,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(() =>
      repositories.copiedFiles.plan({
        id: 'copy-source-mismatch',
        sourceFileId: 'file-1',
        ingestSessionId: 'session-other-source',
        destinationPath: '/archive/mismatch.mov',
        status: 'planned',
        expectedBytes: 100,
        copiedBytes: 0,
        checksum: null,
        startedAt: null,
        verifiedAt: null,
        errorCode: null,
        errorMessage: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ).toThrow(/same source/i);
    expect(() =>
      connection.database
        .prepare(
          `INSERT INTO copied_files
            (id, source_id, source_file_id, ingest_session_id, destination_path, status,
             expected_bytes, copied_bytes, created_at, updated_at)
           VALUES ('direct-source-mismatch', 'source-1', 'file-1', 'session-other-source',
                   '/archive/direct-mismatch.mov', 'planned', 100, 0, ?, ?)`,
        )
        .run(timestamp, timestamp),
    ).toThrow();
    repositories.copiedFiles.plan({
      id: 'copy-1',
      sourceFileId: 'file-1',
      ingestSessionId: 'session-1',
      destinationPath: '/archive/a.mov',
      status: 'planned',
      expectedBytes: 100,
      copiedBytes: 0,
      checksum: null,
      startedAt: null,
      verifiedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(repositories.copiedFiles.findVerifiedForSourceFile('file-1')).toBeUndefined();
    expect(repositories.copiedFiles.findIncomplete().map((copy) => copy.id)).toEqual(['copy-1']);
    expect(() => repositories.copiedFiles.updateProgress('copy-1', 1, laterTimestamp)).toThrow(
      /transition/i,
    );
    expect(() =>
      repositories.copiedFiles.markFailed('copy-1', 'PREMATURE', 'Not started', laterTimestamp),
    ).toThrow(/transition/i);
    expect(() =>
      repositories.copiedFiles.markVerified('copy-1', 100, 'full', laterTimestamp),
    ).toThrow(/transition/i);
    repositories.copiedFiles.markStarted('copy-1', timestamp);
    expect(() => repositories.copiedFiles.markStarted('copy-1', timestamp)).toThrow(/transition/i);
    repositories.copiedFiles.updateProgress('copy-1', 50, laterTimestamp);
    repositories.copiedFiles.markFailed('copy-1', 'IO_ERROR', 'Disconnected', laterTimestamp);
    expect(repositories.copiedFiles.findByDestination('/archive/a.mov')).toMatchObject({
      status: 'failed',
      copiedBytes: 50,
      errorCode: 'IO_ERROR',
      failedAt: laterTimestamp,
      lastProgressAt: laterTimestamp,
    });
    expect(() =>
      repositories.copiedFiles.plan({
        id: 'copy-duplicate',
        sourceFileId: 'file-1',
        ingestSessionId: 'session-1',
        destinationPath: '/archive/a.mov',
        status: 'planned',
        expectedBytes: 100,
        copiedBytes: 0,
        checksum: null,
        startedAt: null,
        verifiedAt: null,
        errorCode: null,
        errorMessage: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ).toThrow();

    repositories.copiedFiles.markStarted('copy-1', laterTimestamp);
    expect(repositories.copiedFiles.findByDestination('/archive/a.mov')).toMatchObject({
      status: 'started',
      recoveryStartedAt: laterTimestamp,
      failedAt: null,
      copiedBytes: 0,
      lastProgressAt: null,
      errorCode: null,
      errorMessage: null,
      verifiedAt: null,
      checksum: null,
    });
    expect(() =>
      repositories.copiedFiles.markVerified('copy-1', 99, 'full', laterTimestamp),
    ).toThrow(/source size/i);
    expect(() => repositories.copiedFiles.markVerified('copy-1', 100, '', laterTimestamp)).toThrow(
      /checksum/i,
    );
    repositories.copiedFiles.markVerified('copy-1', 100, 'full', laterTimestamp);
    expect(repositories.copiedFiles.findVerifiedForSourceFile('file-1')?.status).toBe('verified');
    expect(repositories.sourceFiles.findById('file-1')?.status).toBe('completed');
    expect(repositories.copiedFiles.findIncomplete()).toHaveLength(0);

    expect(() =>
      connection.database
        .prepare(
          `UPDATE copied_files
              SET status = 'verified', verified_at = NULL, checksum = NULL
            WHERE id = 'copy-1'`,
        )
        .run(),
    ).toThrow();
    connection.close();
  });

  it('upserts thumbnails and validates typed settings on writes and reads', () => {
    const { connection, repositories } = createMigratedStorage();
    repositories.sources.create({
      id: 'source-1',
      kind: 'folder',
      displayName: 'Import',
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    repositories.sessions.create({
      id: 'thumbnail-session',
      sourceId: 'source-1',
      status: 'copying',
      startedAt: timestamp,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    repositories.sourceFiles.recordVersion({
      id: 'file-1',
      sourceId: 'source-1',
      ingestSessionId: 'thumbnail-session',
      versionKey: 'content-v1',
      relativePath: 'a.jpg',
      name: 'a.jpg',
      extension: '.jpg',
      sizeBytes: 10,
      modifiedAt: timestamp,
      kind: 'image',
      status: 'ready',
      quickChecksum: null,
      fullChecksum: null,
      captureAt: null,
      lastSeenAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    repositories.copiedFiles.plan({
      id: 'thumbnail-copy',
      sourceFileId: 'file-1',
      ingestSessionId: 'thumbnail-session',
      destinationPath: '/archive/a.jpg',
      status: 'planned',
      expectedBytes: 10,
      copiedBytes: 0,
      checksum: null,
      startedAt: null,
      verifiedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    repositories.copiedFiles.markStarted('thumbnail-copy', timestamp);
    repositories.copiedFiles.markVerified('thumbnail-copy', 10, 'thumbnail-sha', timestamp);
    repositories.thumbnails.upsert({
      id: 'thumbnail-1',
      sourceFileId: 'file-1',
      variant: 'grid',
      cachePath: '/cache/a.webp',
      mimeType: 'image/webp',
      width: 320,
      height: 180,
      sizeBytes: 20,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const updatedThumbnail = repositories.thumbnails.upsert({
      id: 'thumbnail-replacement-id',
      sourceFileId: 'file-1',
      variant: 'grid',
      cachePath: '/cache/a-v2.webp',
      mimeType: 'image/webp',
      width: 640,
      height: 360,
      sizeBytes: 40,
      createdAt: laterTimestamp,
      updatedAt: laterTimestamp,
    });
    expect(updatedThumbnail).toMatchObject({
      id: 'thumbnail-1',
      createdAt: timestamp,
      cachePath: '/cache/a-v2.webp',
      updatedAt: laterTimestamp,
    });
    expect(repositories.thumbnails.listForSourceFile('file-1')).toEqual([
      expect.objectContaining({ cachePath: '/cache/a-v2.webp', width: 640 }),
    ]);

    repositories.settings.set('appSettings', defaultAppSettings, timestamp);
    expect(repositories.settings.get('appSettings')).toEqual(defaultAppSettings);
    const setUnknownSetting = repositories.settings.set as unknown as (
      key: string,
      value: typeof defaultAppSettings,
      updatedAt: string,
    ) => void;
    expect(() => setUnknownSetting('unknown', defaultAppSettings, timestamp)).toThrow(
      /setting key/i,
    );
    expect(() =>
      repositories.settings.set(
        'appSettings',
        { ...defaultAppSettings, copyConcurrency: 99 },
        timestamp,
      ),
    ).toThrow();

    connection.database
      .prepare("UPDATE settings SET value_json = '{}' WHERE key = 'appSettings'")
      .run();
    expect(repositories.settings.get('appSettings')).toEqual(defaultAppSettings);
    connection.database.prepare("UPDATE settings SET value_json = ? WHERE key = 'appSettings'").run(
      JSON.stringify({
        ...defaultAppSettings,
        schemaVersion: 99,
        futureAdditiveField: true,
      }),
    );
    expect(repositories.settings.get('appSettings')).toEqual(defaultAppSettings);
    connection.close();
  });
});

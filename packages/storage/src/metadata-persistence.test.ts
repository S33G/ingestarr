import { describe, expect, it } from 'vitest';

import type Database from 'better-sqlite3';

import { createRepositories, migrateDatabase, migrations, openDatabase } from './index.js';

const at = '2026-07-19T12:00:00.000Z';

function source(repositories: ReturnType<typeof createRepositories>) {
  repositories.sources.create({
    id: 'source',
    kind: 'folder',
    displayName: 'CARD',
    firstSeenAt: at,
    lastSeenAt: at,
    createdAt: at,
    updatedAt: at,
  });
}

/** Inserts a source using only the columns present in the initial (v1) schema. */
function legacySource(database: Database.Database) {
  database
    .prepare(
      `INSERT INTO sources
        (id, kind, display_name, first_seen_at, last_seen_at, created_at, updated_at)
       VALUES ('source', 'folder', 'CARD', ?, ?, ?, ?)`,
    )
    .run(at, at, at, at);
}

describe('source-file metadata migration and persistence', () => {
  it('upgrades an existing v1 database without losing source files and is idempotent', () => {
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database, migrations.slice(0, 1));
    legacySource(connection.database);
    connection.database
      .prepare(
        `INSERT INTO source_files
          (id, source_id, version_key, relative_path, name, extension, size_bytes,
           modified_at, kind, status, capture_at, last_seen_at, created_at, updated_at)
         VALUES ('legacy', 'source', 'v1', 'DCIM/legacy.jpg', 'legacy.jpg', '.jpg', 1,
                 ?, 'image', 'ready', ?, ?, ?, ?)`,
      )
      .run(at, at, at, at, at);

    expect(migrateDatabase(connection.database)).toEqual({
      applied: [2, 3, 4, 5, 6, 7, 8, 9],
      currentVersion: 9,
    });
    expect(migrateDatabase(connection.database)).toEqual({ applied: [], currentVersion: 9 });
    expect(connection.database.prepare('SELECT id FROM source_files').pluck().all()).toEqual([
      'legacy',
    ]);
    const columns = connection.database
      .prepare("PRAGMA table_info('source_files')")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'capture_at_source',
        'capture_at_raw',
        'capture_timezone_kind',
        'capture_offset_minutes',
        'capture_offset_source',
        'capture_offset_raw',
        'capture_day',
        'camera_make',
        'camera_model',
        'lens_model',
        'mime_type',
        'media_type',
        'gps_present',
      ]),
    );
    const indexes = connection.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .pluck()
      .all();
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_source_files_capture_day', 'idx_source_files_media_type']),
    );
    connection.close();
  });

  it('round-trips normalized metadata and reduces GPS to a validated boolean', () => {
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const repositories = createRepositories(connection.database);
    source(repositories);

    repositories.sourceFiles.recordVersion({
      id: 'photo',
      sourceId: 'source',
      ingestSessionId: null,
      versionKey: 'v1',
      relativePath: 'DCIM/photo.cr3',
      name: 'photo.cr3',
      extension: '.cr3',
      sizeBytes: 10,
      modifiedAt: at,
      kind: 'image',
      status: 'ready',
      quickChecksum: null,
      fullChecksum: null,
      captureAt: '2024-12-31T23:30:01-07:00',
      captureAtSource: 'DateTimeOriginal',
      captureAtRaw: '2024:12:31 23:30:01-07:00',
      captureTimezoneKind: 'offset',
      captureOffsetMinutes: -420,
      captureOffsetSource: 'inline',
      captureOffsetRaw: '-07:00',
      captureDay: '2024-12-31',
      cameraMake: 'Canon',
      cameraModel: 'EOS R5',
      lensModel: 'RF24-70mm',
      mimeType: 'image/x-canon-cr3',
      mediaType: 'photo',
      width: 8192,
      height: 5464,
      durationSeconds: null,
      gpsPresent: true,
      lastSeenAt: at,
      createdAt: at,
      updatedAt: at,
    });

    expect(repositories.sourceFiles.findById('photo')).toMatchObject({
      captureAtSource: 'DateTimeOriginal',
      captureAtRaw: '2024:12:31 23:30:01-07:00',
      captureTimezoneKind: 'offset',
      captureOffsetMinutes: -420,
      captureOffsetSource: 'inline',
      captureOffsetRaw: '-07:00',
      captureDay: '2024-12-31',
      cameraMake: 'Canon',
      cameraModel: 'EOS R5',
      lensModel: 'RF24-70mm',
      mimeType: 'image/x-canon-cr3',
      mediaType: 'photo',
      width: 8192,
      height: 5464,
      gpsPresent: true,
    });
    expect(JSON.stringify(repositories.sourceFiles.findById('photo'))).not.toContain('GPSLatitude');

    expect(() =>
      connection.database
        .prepare("UPDATE source_files SET gps_present = 2 WHERE id = 'photo'")
        .run(),
    ).toThrow();
    expect(() =>
      connection.database
        .prepare("UPDATE source_files SET capture_timezone_kind = 'guessed' WHERE id = 'photo'")
        .run(),
    ).toThrow();
    expect(() =>
      connection.database
        .prepare("UPDATE source_files SET media_type = 'audio' WHERE id = 'photo'")
        .run(),
    ).toThrow();
    connection.close();
  });
});

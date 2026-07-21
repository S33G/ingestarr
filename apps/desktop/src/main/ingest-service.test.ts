import {
  access,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyFile } from '@ingestarr/ingest-core';
import { createExifToolClient } from '@ingestarr/metadata';
import { migrateDatabase, openDatabase } from '@ingestarr/storage';

import { defaultAppSettings } from '@ingestarr/shared-types';

import { createComposedIngestService } from './ingest-service';

const temporaryDirectories: string[] = [];

// Naming a detected card always resolves to a single source (authoritative reconciliation or a
// fresh source) — there is no confirmation handshake. This helper is a thin pass-through kept for
// readability at call sites.
function expectRegistered(
  result: Awaited<
    ReturnType<ReturnType<typeof createComposedIngestService>['registerDetectedSource']>
  >,
): { sourceId: string; nickname: string | null } {
  return result;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('composed manual-folder ingest service', () => {
  it('caches reviewed metadata by file facts, persists it, and plans with captureDay', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'CARD');
    const destination = path.join(root, 'Archive');
    await Promise.all([mkdir(source), mkdir(destination), mkdir(path.join(root, 'logs'))]);
    await writeFile(path.join(source, 'photo.jpg'), 'photo');
    const metadataClient = {
      extract: vi.fn(async () => ({
        dates: { DateTimeOriginal: '2024:12:31 23:30:01-07:00' },
        cameraMake: 'Canon',
        cameraModel: 'EOS R5',
        lensModel: 'RF24-70mm',
        mimeType: 'image/jpeg',
        fileType: 'JPEG',
        width: 100,
        height: 50,
        durationSeconds: null,
        gpsPresent: true,
        warnings: [],
      })),
      close: vi.fn(async () => {}),
      status: () => ({
        queued: 0,
        active: 0,
        generations: 1,
        closed: false,
        circuitOpen: false,
      }),
    };
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const thumbnailProcessor = vi.fn(async (_input: string, output: string) => {
      await writeFile(output, 'generated thumbnail');
      return { width: 64, height: 32, mimeType: 'image/webp' };
    });
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: path.join(root, 'logs'),
      metadataClient,
      thumbnailProcessor,
    });

    const review = await service.review(source, destination);
    expect(review.destinationPreview).toContain(path.join('2024', '2024-12-31'));
    const handle = await service.start(source, destination, new AbortController().signal, () => {});
    expect((await handle.completion).status).toBe('completed');

    expect(metadataClient.extract).toHaveBeenCalledTimes(1);
    expect(
      connection.database
        .prepare(
          `SELECT capture_at_source AS captureAtSource, capture_day AS captureDay,
                  capture_offset_source AS captureOffsetSource,
                  capture_offset_raw AS captureOffsetRaw,
                  camera_model AS cameraModel, gps_present AS gpsPresent
             FROM source_files`,
        )
        .get(),
    ).toEqual({
      captureAtSource: 'DateTimeOriginal',
      captureDay: '2024-12-31',
      captureOffsetSource: 'inline',
      captureOffsetRaw: '-07:00',
      cameraModel: 'EOS R5',
      gpsPresent: 1n,
    });
    expect((await readdir(destination, { recursive: true })).join('/')).toContain('2024-12-31');
    const copy = connection.database
      .prepare('SELECT id FROM copied_files WHERE status = ?')
      .get('verified') as { id: string };
    expect(service.retryThumbnail(copy.id, 'grid')).toBe(false);
    connection.database
      .prepare(
        `UPDATE thumbnails
            SET state = 'failed',
                artifact_cache_key = NULL,
                error_code = 'THUMBNAIL_FAILED',
                safe_message = 'Thumbnail unavailable.',
                attempt_count = 1,
                next_retry_at = NULL,
                max_attempts = 3
          WHERE copied_file_id = ? AND variant = 'grid'`,
      )
      .run(copy.id);
    expect(service.retryThumbnail(copy.id, 'grid')).toBe(true);
    await service.close();
    expect(thumbnailProcessor).toHaveBeenCalledTimes(2);
    expect(
      connection.database
        .prepare(
          `SELECT artifact.width, artifact.height,
                  artifact.generator_version AS generatorVersion,
                  copy.status AS copyStatus
             FROM thumbnails thumbnail
             JOIN thumbnail_artifacts artifact
               ON artifact.cache_key = thumbnail.artifact_cache_key
             JOIN copied_files copy ON copy.id = thumbnail.copied_file_id`,
        )
        .get(),
    ).toEqual({
      width: 64n,
      height: 32n,
      generatorVersion: 'thumb-v1',
      copyStatus: 'verified',
    });
    expect(metadataClient.close).toHaveBeenCalledOnce();
    connection.close();
  });

  it('registers a detected source with a nickname before any ingest has run', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'logs'));
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: path.join(root, 'logs'),
    });

    const registered = expectRegistered(
      await service.registerDetectedSource(
        { platformVolumeId: 'volume-abc', label: 'AUTO CARD', kind: 'removable-volume' },
        'canon-r5',
      ),
    );
    expect(registered.nickname).toBe('canon-r5');
    expect(service.listKnownSources()).toEqual([
      expect.objectContaining({ id: registered.sourceId, nickname: 'canon-r5' }),
    ]);

    // Naming the same card again (e.g. re-inserting it later) must reconcile onto the same
    // source by platform volume id rather than creating a duplicate row.
    const reRegistered = expectRegistered(
      await service.registerDetectedSource(
        { platformVolumeId: 'volume-abc', label: 'AUTO CARD', kind: 'removable-volume' },
        'renamed-card',
      ),
    );
    expect(reRegistered.sourceId).toBe(registered.sourceId);
    expect(service.listKnownSources()).toEqual([
      expect.objectContaining({ id: registered.sourceId, nickname: 'renamed-card' }),
    ]);

    await service.close();
    connection.close();
  });

  it('writes an on-card identity marker directly onto the source volume when registering a detected source', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const cardMount = path.join(root, 'CARD-MOUNT');
    await Promise.all([mkdir(cardMount), mkdir(path.join(root, 'logs'))]);
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: path.join(root, 'logs'),
    });

    const registered = expectRegistered(
      await service.registerDetectedSource(
        {
          platformVolumeId: 'volume-abc',
          label: 'AUTO CARD',
          kind: 'removable-volume',
          mountPath: cardMount,
        },
        'canon-r5',
      ),
    );

    const marker = JSON.parse(
      await readFile(path.join(cardMount, '.ingestarr', 'card.json'), 'utf8'),
    );
    expect(marker).toMatchObject({
      schemaVersion: 1,
      sourceId: registered.sourceId,
      nickname: 'canon-r5',
    });
    expect(typeof marker.createdAt).toBe('string');
    expect(typeof marker.updatedAt).toBe('string');

    const eventLog = await readFile(path.join(cardMount, '.ingestarr', 'events.log'), 'utf8');
    expect(eventLog).toContain(registered.sourceId);
    expect(eventLog).toContain('source-added');

    await service.close();
    connection.close();
  });

  it('resolves directly to the marked source when a marker exists, bypassing platform-id/label matching', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const cardMount = path.join(root, 'CARD-MOUNT');
    await Promise.all([mkdir(cardMount), mkdir(path.join(root, 'logs'))]);
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: path.join(root, 'logs'),
    });

    const original = expectRegistered(
      await service.registerDetectedSource(
        {
          platformVolumeId: 'volume-abc',
          label: 'AUTO CARD',
          kind: 'removable-volume',
          mountPath: cardMount,
        },
        'big',
      ),
    );

    // Simulate the OS reporting a *different* strong platform id and a *different* label on
    // reconnect (e.g. reformatted, or read through a different reader/OS) — normally this would
    // either create a brand-new source or, if the label happened to collide with another known
    // fallback-only source, surface a "may already be known as" ambiguity. Because the on-card
    // marker is present and read first, none of that heuristic runs: it resolves directly.
    const reRegistered = expectRegistered(
      await service.registerDetectedSource(
        {
          platformVolumeId: 'volume-completely-different',
          label: 'RENAMED VOLUME',
          kind: 'removable-volume',
          mountPath: cardMount,
        },
        'big-renamed',
      ),
    );

    expect(reRegistered.sourceId).toBe(original.sourceId);
    expect(reRegistered.nickname).toBe('big-renamed');
    expect(service.listKnownSources()).toHaveLength(1);
    expect(service.listKnownSources()).toEqual([
      expect.objectContaining({ id: original.sourceId, nickname: 'big-renamed' }),
    ]);

    await service.close();
    connection.close();
  });

  it('resolves review() directly to the marked source, with no confirmation required', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'CARD');
    const destination = path.join(root, 'Archive');
    await Promise.all([mkdir(source), mkdir(destination), mkdir(path.join(root, 'logs'))]);
    await writeFile(path.join(source, 'photo.jpg'), 'photo');
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: path.join(root, 'logs'),
    });

    const registered = expectRegistered(
      await service.registerDetectedSource(
        { label: 'BIG', kind: 'removable-volume', mountPath: source },
        'big',
      ),
    );

    const review = await service.review(source, destination);
    expect(review.source).toMatchObject({
      identity: 'Known source candidate',
      confidence: 'high',
      requiresConfirmation: false,
    });
    expect(review.source.candidates).toEqual([
      expect.objectContaining({ sourceId: registered.sourceId, confidence: 'exact' }),
    ]);

    await service.close();
    connection.close();
  });

  it('refreshes the on-card marker at ingest start even if the card was never pre-named', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'CARD');
    const destination = path.join(root, 'Archive');
    await Promise.all([mkdir(source), mkdir(destination), mkdir(path.join(root, 'logs'))]);
    await writeFile(path.join(source, 'photo.jpg'), 'photo');
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: path.join(root, 'logs'),
    });

    await expect(access(path.join(source, '.ingestarr', 'card.json'))).rejects.toThrow();

    const handle = await service.start(source, destination, new AbortController().signal, () => {});
    expect((await handle.completion).status).toBe('completed');

    const marker = JSON.parse(
      await readFile(path.join(source, '.ingestarr', 'card.json'), 'utf8'),
    );
    expect(marker).toMatchObject({ schemaVersion: 1, nickname: null });
    expect(typeof marker.sourceId).toBe('string');

    // Reviewing/ingesting the same card again now resolves to the same source via its marker.
    const secondHandle = await service.start(
      source,
      destination,
      new AbortController().signal,
      () => {},
    );
    expect((await secondHandle.completion).sourceId).toBe(marker.sourceId);

    await service.close();
    connection.close();
  });

  it('never blocks naming or ingest when the on-card marker cannot be written', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'CARD');
    const destination = path.join(root, 'Archive');
    await Promise.all([mkdir(source), mkdir(destination), mkdir(path.join(root, 'logs'))]);
    await writeFile(path.join(source, 'photo.jpg'), 'photo');
    // Occupying the `.ingestarr` path with a file (instead of a directory) simulates a
    // write-protected/unwritable card: `mkdir(..., { recursive: true })` will fail on it.
    await writeFile(path.join(source, '.ingestarr'), 'not a directory');
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: path.join(root, 'logs'),
    });

    const registered = expectRegistered(
      await service.registerDetectedSource(
        { label: 'READ ONLY CARD', kind: 'removable-volume', mountPath: source },
        'ro-card',
      ),
    );
    expect(registered.nickname).toBe('ro-card');

    const handle = await service.start(source, destination, new AbortController().signal, () => {});
    expect((await handle.completion).status).toBe('completed');

    await service.close();
    connection.close();
  });

  it('reconciles a re-inserted card automatically by strong platform id, with no confirmation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'logs'));
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: path.join(root, 'logs'),
    });

    const original = expectRegistered(
      await service.registerDetectedSource(
        { platformVolumeId: 'volume-xyz', label: 'BIG', kind: 'removable-volume' },
        'big',
      ),
    );

    // Re-inserting the same card (same strong platform id) resolves straight to the same source
    // and simply updates the nickname — no prompt, no duplicate.
    const reRegistered = expectRegistered(
      await service.registerDetectedSource(
        { platformVolumeId: 'volume-xyz', label: 'BIG', kind: 'removable-volume' },
        'canon-r5',
      ),
    );
    expect(reRegistered.sourceId).toBe(original.sourceId);
    expect(service.listKnownSources()).toEqual([
      expect.objectContaining({ id: original.sourceId, nickname: 'canon-r5' }),
    ]);

    await service.close();
    connection.close();
  });

  it('keeps distinct cards separate without prompting, even when they share a label', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'logs'));
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: path.join(root, 'logs'),
    });

    // Two physically different cards that happen to share the generic label "UNTITLED": naming
    // each simply creates its own source. We never guess they're the same by label.
    const original = expectRegistered(
      await service.registerDetectedSource(
        { platformVolumeId: 'volume-a', label: 'UNTITLED', kind: 'removable-volume' },
        'sd-1',
      ),
    );
    const created = expectRegistered(
      await service.registerDetectedSource(
        { platformVolumeId: 'volume-different', label: 'UNTITLED', kind: 'removable-volume' },
        'sd-2',
      ),
    );
    expect(created.sourceId).not.toBe(original.sourceId);
    expect(service.listKnownSources()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: original.sourceId, nickname: 'sd-1' }),
        expect.objectContaining({ id: created.sourceId, nickname: 'sd-2' }),
      ]),
    );
    expect(service.listKnownSources()).toHaveLength(2);

    await service.close();
    connection.close();
  });

  it('writes a plain-text .ingestarr event when a source is added or renamed, if enabled', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const destination = path.join(root, 'Archive');
    await Promise.all([mkdir(destination), mkdir(path.join(root, 'logs'))]);
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: path.join(root, 'logs'),
    });

    // Disabled by default: no .ingestarr directory should appear at all.
    const firstAttempt = expectRegistered(
      await service.registerDetectedSource(
        { platformVolumeId: 'volume-abc', label: 'AUTO CARD', kind: 'removable-volume' },
        'canon-r5',
      ),
    );
    await expect(access(path.join(destination, '.ingestarr'))).rejects.toThrow();

    await service.updateSettings({
      ...defaultAppSettings,
      destinationRoot: destination,
      perCardEventLog: true,
    });

    await service.registerDetectedSource(
      { platformVolumeId: 'volume-def', label: 'SECOND CARD', kind: 'removable-volume' },
      'sony-a7iv',
    );
    const secondLog = await readFile(
      path.join(destination, '.ingestarr', 'sony-a7iv.log'),
      'utf8',
    );
    expect(secondLog).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(secondLog).toContain('sony-a7iv');

    // Renaming an already-known source must also append a timestamped event, using the new
    // nickname as the log filename so it stays discoverable by the name the user chose.
    await service.setSourceNickname(firstAttempt.sourceId, 'canon-r5-renamed');
    const renamedLog = await readFile(
      path.join(destination, '.ingestarr', 'canon-r5-renamed.log'),
      'utf8',
    );
    expect(renamedLog).toContain('canon-r5-renamed');

    await service.close();
    connection.close();
  });

  it('degrades to filesystem time when ExifTool is unavailable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'CARD');
    const destination = path.join(root, 'Archive');
    await Promise.all([mkdir(source), mkdir(destination), mkdir(path.join(root, 'logs'))]);
    const photo = path.join(source, 'photo.jpg');
    await writeFile(photo, 'photo');
    await utimes(photo, new Date('2023-05-06T07:08:09.000Z'), new Date('2023-05-06T07:08:09.000Z'));
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: path.join(root, 'logs'),
      metadataClient: {
        extract: vi.fn(async () => {
          throw Object.assign(new Error('ExifTool binary unavailable'), { code: 'ENOENT' });
        }),
        close: vi.fn(async () => {}),
        status: () => ({
          queued: 0,
          active: 0,
          generations: 1,
          closed: false,
          circuitOpen: false,
        }),
      },
    });

    const handle = await service.start(source, destination, new AbortController().signal, () => {});
    expect(await handle.completion).toMatchObject({ status: 'completed', completedFiles: 1 });
    expect(
      connection.database
        .prepare(
          'SELECT capture_at_source AS captureAtSource, capture_day AS captureDay FROM source_files',
        )
        .get(),
    ).toEqual({ captureAtSource: 'filesystem-modifiedAt', captureDay: '2023-05-06' });
    expect((await readdir(destination, { recursive: true })).join('/')).toContain('2023-05-06');
    await service.close();
    connection.close();
  });

  it('shuts down during an active metadata review without leaking tasks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'CARD');
    const destination = path.join(root, 'Archive');
    await Promise.all([mkdir(source), mkdir(destination)]);
    await writeFile(path.join(source, 'photo.jpg'), 'photo');
    const end = vi.fn(async () => {});
    let releaseClassification!: () => void;
    const classificationGate = new Promise<void>((resolve) => {
      releaseClassification = resolve;
    });
    let markClassificationStarted!: () => void;
    const classificationStarted = new Promise<void>((resolve) => {
      markClassificationStarted = resolve;
    });
    const metadataClient = createExifToolClient({
      exiftool: {
        read: vi.fn(async () => new Promise<Record<string, unknown>>(() => {})),
        end,
      },
      timeoutMs: 60_000,
    });
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: root,
      metadataClient,
      classify: async (input, repository) => {
        markClassificationStarted();
        await classificationGate;
        return classifyFile(input, repository);
      },
    });

    const review = service.review(source, destination);
    let reviewSettled = false;
    void review.finally(() => {
      reviewSettled = true;
    });
    while (metadataClient.status().active === 0)
      await new Promise((resolve) => setImmediate(resolve));
    let closeSettled = false;
    const closing = service.close().finally(() => {
      closeSettled = true;
    });
    await classificationStarted;
    await new Promise((resolve) => setImmediate(resolve));

    expect(closeSettled).toBe(false);
    releaseClassification();
    await closing;
    expect(reviewSettled).toBe(true);
    await expect(review).resolves.toMatchObject({ counts: { new: 1 } });
    expect(metadataClient.status()).toEqual({
      queued: 0,
      active: 0,
      generations: 0,
      closed: true,
      circuitOpen: false,
    });
    expect(end).toHaveBeenCalledWith(true);
    connection.close();
  });

  it('persists and plans with session start when scanned mtime is invalid', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'CARD');
    const destination = path.join(root, 'Archive');
    await Promise.all([mkdir(source), mkdir(destination), mkdir(path.join(root, 'logs'))]);
    const photo = path.join(source, 'photo.jpg');
    await writeFile(photo, 'photo');
    const sessionStartedAt = '2022-03-04T05:06:07.000Z';
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: path.join(root, 'logs'),
      now: () => sessionStartedAt,
      scan: async function* () {
        yield {
          type: 'file' as const,
          file: {
            absolutePath: photo,
            relativePath: 'photo.jpg',
            pathSegments: ['photo.jpg'],
            canonicalPathKey: 'photo.jpg',
            extension: '.jpg',
            sizeBytes: 5,
            modifiedAt: 'invalid-mtime',
          },
        };
      },
      metadataClient: {
        extract: vi.fn(async () => {
          throw new Error('tool unavailable');
        }),
        close: vi.fn(async () => {}),
        status: () => ({
          queued: 0,
          active: 0,
          generations: 1,
          closed: false,
          circuitOpen: false,
        }),
      },
    });

    const handle = await service.start(source, destination, new AbortController().signal, () => {});
    expect(await handle.completion).toMatchObject({ status: 'completed', completedFiles: 1 });
    expect(
      connection.database
        .prepare(
          'SELECT capture_at_source AS captureAtSource, capture_day AS captureDay FROM source_files',
        )
        .get(),
    ).toEqual({ captureAtSource: 'session-start', captureDay: '2022-03-04' });
    expect((await readdir(destination, { recursive: true })).join('/')).toContain('2022-03-04');
    await service.close();
    connection.close();
  });

  it('reviews without copying, then rescans and completes a verified ingest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'CARD');
    const destination = path.join(root, 'Archive');
    for (const directory of [
      source,
      destination,
      path.join(root, 'manifests'),
      path.join(root, 'logs'),
    ]) {
      await mkdir(directory, { recursive: true });
    }
    await writeFile(path.join(source, 'clip.jpg'), Buffer.from('photo-data'));
    const connection = openDatabase(path.join(root, 'data.sqlite'));
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: path.join(root, 'manifests'),
      temporaryPath: path.join(root, 'temp'),
      logsPath: path.join(root, 'logs'),
    });

    const review = await service.review(source, destination);

    expect(review.counts).toEqual({ new: 1, known: 0, ambiguous: 0, recoverable: 0 });
    expect(review.estimatedBytes).toBe(10);
    expect(await readdir(destination)).toEqual([]);

    const handle = await service.start(source, destination, new AbortController().signal, () => {});
    const completed = await handle.completion;

    expect(
      connection.database
        .prepare(
          "SELECT error_code AS errorCode, error_message AS errorMessage FROM source_files WHERE status = 'failed'",
        )
        .all(),
    ).toEqual([]);
    expect(completed).toMatchObject({
      sessionId: handle.sessionId,
      status: 'completed',
      completedFiles: 1,
      failedFiles: 0,
    });
    expect(
      (await readdir(destination, { recursive: true })).some((entry) => entry.endsWith('clip.jpg')),
    ).toBe(true);
    connection.close();
  });

  it('rejects a destination that is not a directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'CARD');
    const destination = path.join(root, 'not-a-folder');
    await mkdir(source);
    await writeFile(path.join(source, 'clip.jpg'), Buffer.from('photo-data'));
    await writeFile(destination, Buffer.from('file'));
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: root,
    });

    await expect(service.review(source, destination)).rejects.toMatchObject({
      code: 'DESTINATION_INVALID',
    });
    connection.close();
  });

  it('creates a durable session before preparation and persists safe preparation failure', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const destination = path.join(root, 'Archive');
    await mkdir(destination);
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: root,
      id: (() => {
        let count = 0;
        return () => `id-${++count}`;
      })(),
    });

    const handle = await service.start(
      path.join(root, 'removed-source'),
      destination,
      new AbortController().signal,
      () => {},
    );
    const durableBeforePreparation = connection.database
      .prepare('SELECT status FROM ingest_sessions WHERE id = ?')
      .get(handle.sessionId) as { status: string } | undefined;
    expect(durableBeforePreparation?.status).toBe('discovering');

    const terminal = await handle.completion;
    const durableAfterFailure = connection.database
      .prepare(
        'SELECT status, error_code AS errorCode, error_message AS errorMessage FROM ingest_sessions WHERE id = ?',
      )
      .get(handle.sessionId) as {
      status: string;
      errorCode: string;
      errorMessage: string;
    };
    expect(terminal.status).toBe('failed');
    expect(durableAfterFailure).toEqual({
      status: 'failed',
      errorCode: 'SOURCE_UNAVAILABLE',
      errorMessage: 'The selected source is no longer available.',
    });
    expect(JSON.stringify(durableAfterFailure)).not.toContain(root);
    connection.close();
  });

  it('propagates cancellation into preparation and persists a cancelled prompt', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'CARD');
    const destination = path.join(root, 'Archive');
    await mkdir(source);
    await mkdir(destination);
    await writeFile(path.join(source, 'clip.jpg'), Buffer.from('photo-data'));
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: root,
    });
    const abort = new AbortController();
    abort.abort();

    const handle = await service.start(source, destination, abort.signal, () => {});
    const terminal = await handle.completion;

    expect(terminal).toMatchObject({
      status: 'cancelled',
      errors: [
        {
          code: 'INGEST_CANCELLED',
          message: 'Ingest cancelled. You can return home or choose the folders again.',
        },
      ],
    });
    expect(
      connection.database
        .prepare('SELECT status, error_code AS errorCode FROM ingest_sessions WHERE id = ?')
        .get(handle.sessionId),
    ).toEqual({ status: 'cancelled', errorCode: 'INGEST_CANCELLED' });
    connection.close();
  });

  it('does not reopen failed terminal sessions as recoverable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, 'data.sqlite');
    const destination = path.join(root, 'Archive');
    await mkdir(destination);
    const firstConnection = openDatabase(databasePath);
    migrateDatabase(firstConnection.database);
    const firstService = createComposedIngestService({
      database: firstConnection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: root,
    });
    const handle = await firstService.start(
      path.join(root, 'removed-source'),
      destination,
      new AbortController().signal,
      () => {},
    );
    await handle.completion;
    await firstService.close();
    firstConnection.close();

    const secondConnection = openDatabase(databasePath);
    migrateDatabase(secondConnection.database);
    const reconstructed = createComposedIngestService({
      database: secondConnection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: root,
    });

    expect(reconstructed.listRecoverableSessions()).toEqual([]);
    expect(reconstructed.getSession(handle.sessionId)).toMatchObject({
      status: 'failed',
      errors: [
        {
          code: 'SOURCE_UNAVAILABLE',
          message: 'The selected source is no longer available.',
        },
      ],
    });
    await reconstructed.close();
    secondConnection.close();
  });

  it('yields during classification so cancellation from another turn stops promptly', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'CARD');
    const destination = path.join(root, 'Archive');
    await mkdir(source);
    await mkdir(destination);
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        writeFile(path.join(source, `clip-${String(index).padStart(3, '0')}.jpg`), 'photo'),
      ),
    );
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const abort = new AbortController();
    let classifications = 0;
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: root,
      classificationYieldInterval: 4,
      async classify(input, repository) {
        classifications += 1;
        if (classifications === 1) setTimeout(() => abort.abort(), 0);
        return classifyFile(input, repository);
      },
    });

    const handle = await service.start(source, destination, abort.signal, () => {});
    const terminal = await handle.completion;

    expect(classifications).toBeGreaterThan(0);
    expect(classifications).toBeLessThan(40);
    expect(terminal).toMatchObject({
      status: 'cancelled',
      errors: [
        {
          code: 'INGEST_CANCELLED',
          message: 'Ingest cancelled. You can return home or choose the folders again.',
        },
      ],
    });
    expect(
      connection.database
        .prepare('SELECT status FROM ingest_sessions WHERE id = ?')
        .get(handle.sessionId),
    ).toEqual({ status: 'cancelled' });
    await service.close();
    connection.close();
  });

  it('reconfigures thumbnail dimensions after a settings update', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const sourceA = path.join(root, 'CARD-A');
    const sourceB = path.join(root, 'CARD-B');
    const destination = path.join(root, 'Archive');
    await Promise.all([
      mkdir(sourceA),
      mkdir(sourceB),
      mkdir(destination),
      mkdir(path.join(root, 'logs')),
    ]);
    await writeFile(path.join(sourceA, 'first.jpg'), Buffer.from('same-content'));
    await writeFile(path.join(sourceB, 'second.jpg'), Buffer.from('same-content'));
    const connection = openDatabase(path.join(root, 'data.sqlite'));
    migrateDatabase(connection.database);
    const thumbnailProcessor = vi.fn(async (_input: string, output: string) => {
      await writeFile(output, 'generated thumbnail');
      return { width: 64, height: 32, mimeType: 'image/webp' as const };
    });
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: path.join(root, 'logs'),
      thumbnailsPath: path.join(root, 'thumbnails'),
      thumbnailProcessor,
    });

    const first = await service.start(sourceA, destination, new AbortController().signal, () => {});
    expect((await first.completion).status).toBe('completed');

    await service.updateSettings({
      ...defaultAppSettings,
      destinationRoot: destination,
      thumbnail: { ...defaultAppSettings.thumbnail, width: 96, height: 96 },
    });

    const second = await service.start(
      sourceB,
      destination,
      new AbortController().signal,
      () => {},
    );
    expect((await second.completion).status).toBe('completed');
    await service.close();

    const cacheKeys = connection.database
      .prepare('SELECT DISTINCT cache_key AS cacheKey FROM thumbnail_artifacts')
      .all() as Array<{ cacheKey: string }>;
    expect(cacheKeys).toHaveLength(2);
    connection.close();
  });

  it('evicts bounded thumbnail cache artifacts beyond the configured limit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const sourceA = path.join(root, 'CARD-A');
    const sourceB = path.join(root, 'CARD-B');
    const destination = path.join(root, 'Archive');
    await Promise.all([
      mkdir(sourceA),
      mkdir(sourceB),
      mkdir(destination),
      mkdir(path.join(root, 'logs')),
    ]);
    await writeFile(path.join(sourceA, 'alpha.jpg'), Buffer.from('alpha-content'));
    await writeFile(path.join(sourceB, 'bravo.jpg'), Buffer.from('bravo-content'));
    const connection = openDatabase(path.join(root, 'data.sqlite'));
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: path.join(root, 'logs'),
      thumbnailsPath: path.join(root, 'thumbnails'),
      thumbnailProcessor: vi.fn(async (_input: string, output: string) => {
        await writeFile(output, 'generated thumbnail');
        return { width: 64, height: 32, mimeType: 'image/webp' as const };
      }),
    });
    await service.updateSettings({
      ...defaultAppSettings,
      destinationRoot: destination,
      thumbnail: { ...defaultAppSettings.thumbnail, cachePolicy: 'bounded', cacheLimitBytes: 25 },
    });

    for (const sourceDir of [sourceA, sourceB]) {
      const handle = await service.start(
        sourceDir,
        destination,
        new AbortController().signal,
        () => {},
      );
      expect((await handle.completion).status).toBe('completed');
    }
    await service.close();

    const artifacts = connection.database
      .prepare('SELECT cache_path AS cachePath FROM thumbnail_artifacts')
      .all() as Array<{ cachePath: string }>;
    expect(artifacts).toHaveLength(1);
    await expect(access(artifacts[0]!.cachePath, constants.F_OK)).resolves.toBeUndefined();
    connection.close();
  });

  it('rejects a reacquired recovery source whose identity does not match', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'CARD');
    const destination = path.join(root, 'Archive');
    await Promise.all([mkdir(source), mkdir(destination), mkdir(path.join(root, 'logs'))]);
    await writeFile(path.join(source, 'clip.jpg'), Buffer.from('original-card-bytes'));
    const connection = openDatabase(path.join(root, 'data.sqlite'));
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: path.join(root, 'logs'),
    });

    const { sessionId, copy } = await seedInterruptedSession(
      service,
      connection,
      source,
      destination,
    );

    const wrong = path.join(root, 'WRONG-CARD');
    await mkdir(wrong);
    await writeFile(path.join(wrong, 'unrelated.mov'), Buffer.from('a-completely-different-card'));

    await expect(
      service.recoverSession(sessionId, wrong, 'resume', new AbortController().signal, () => {}),
    ).rejects.toMatchObject({ code: 'SOURCE_MISMATCH' });

    const status = connection.database
      .prepare('SELECT status FROM copied_files WHERE id = ?')
      .get(copy.id) as { status: string };
    expect(status.status).toBe('planned');
    await expect(access(copy.destinationPath, constants.F_OK)).rejects.toThrow();
    await service.close();
    connection.close();
  });

  it('resumes when the reacquired source identity matches the persisted card', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'CARD');
    const destination = path.join(root, 'Archive');
    await Promise.all([mkdir(source), mkdir(destination), mkdir(path.join(root, 'logs'))]);
    await writeFile(path.join(source, 'clip.jpg'), Buffer.from('original-card-bytes'));
    const connection = openDatabase(path.join(root, 'data.sqlite'));
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: path.join(root, 'logs'),
    });

    const { sessionId, copy } = await seedInterruptedSession(
      service,
      connection,
      source,
      destination,
    );

    const result = await service.recoverSession(
      sessionId,
      source,
      'resume',
      new AbortController().signal,
      () => {},
    );

    expect(result?.status).toBe('completed');
    const status = connection.database
      .prepare('SELECT status FROM copied_files WHERE id = ?')
      .get(copy.id) as { status: string };
    expect(status.status).toBe('verified');
    await expect(access(copy.destinationPath, constants.F_OK)).resolves.toBeUndefined();
    await service.close();
    connection.close();
  });

  it('pauses an interrupted session as recoverable when the source is absent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'CARD');
    const destination = path.join(root, 'Archive');
    await Promise.all([mkdir(source), mkdir(destination), mkdir(path.join(root, 'logs'))]);
    await writeFile(path.join(source, 'clip.jpg'), Buffer.from('original-card-bytes'));
    const connection = openDatabase(path.join(root, 'data.sqlite'));
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: path.join(root, 'logs'),
    });

    const { sessionId, copy } = await seedInterruptedSession(
      service,
      connection,
      source,
      destination,
    );

    const result = await service.recoverSession(
      sessionId,
      undefined,
      'resume',
      new AbortController().signal,
      () => {},
    );

    expect(result?.phase).toBe('Waiting for source');
    expect(result?.errors.some((error) => error.code === 'SOURCE_UNAVAILABLE')).toBe(true);
    const status = connection.database
      .prepare('SELECT status FROM copied_files WHERE id = ?')
      .get(copy.id) as { status: string };
    expect(status.status).toBe('planned');
    await service.close();
    connection.close();
  });

  it('cleans only session-owned partials and marks the session cancelled', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-desktop-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'CARD');
    const destination = path.join(root, 'Archive');
    await Promise.all([mkdir(source), mkdir(destination), mkdir(path.join(root, 'logs'))]);
    await writeFile(path.join(source, 'clip.jpg'), Buffer.from('original-card-bytes'));
    const connection = openDatabase(path.join(root, 'data.sqlite'));
    migrateDatabase(connection.database);
    const service = createComposedIngestService({
      database: connection.database,
      manifestsPath: root,
      temporaryPath: root,
      logsPath: path.join(root, 'logs'),
    });

    const { sessionId, copy } = await seedInterruptedSession(
      service,
      connection,
      source,
      destination,
    );
    const temporaryPath = path.join(
      path.dirname(copy.destinationPath),
      `.${path.basename(copy.destinationPath)}.${sessionId}.${copy.id}.tmp`,
    );
    await writeFile(temporaryPath, Buffer.from('partial'));
    const bystander = path.join(destination, 'unrelated-user-file.jpg');
    await writeFile(bystander, Buffer.from('do-not-touch'));

    await service.recoverSession(
      sessionId,
      undefined,
      'cleanup',
      new AbortController().signal,
      () => {},
    );

    await expect(access(temporaryPath, constants.F_OK)).rejects.toThrow();
    await expect(access(bystander, constants.F_OK)).resolves.toBeUndefined();
    const session = connection.database
      .prepare('SELECT status, error_code AS errorCode FROM ingest_sessions WHERE id = ?')
      .get(sessionId) as { status: string; errorCode: string | null };
    expect(session.status).toBe('cancelled');
    await service.close();
    connection.close();
  });
});

async function seedInterruptedSession(
  service: ReturnType<typeof createComposedIngestService>,
  connection: ReturnType<typeof openDatabase>,
  source: string,
  destination: string,
): Promise<{ sessionId: string; copy: { id: string; destinationPath: string } }> {
  const handle = await service.start(source, destination, new AbortController().signal, () => {});
  expect((await handle.completion).status).toBe('completed');
  const sessionId = handle.sessionId;
  const copy = connection.database
    .prepare(
      `SELECT id, source_file_id AS sourceFileId, destination_path AS destinationPath
         FROM copied_files WHERE ingest_session_id = ? LIMIT 1`,
    )
    .get(sessionId) as { id: string; sourceFileId: string; destinationPath: string };
  connection.database
    .prepare(
      `UPDATE copied_files SET status = 'planned', checksum = NULL, copied_bytes = 0,
              started_at = NULL, last_progress_at = NULL, failed_at = NULL,
              recovery_started_at = NULL, verified_at = NULL,
              error_code = NULL, error_message = NULL WHERE id = ?`,
    )
    .run(copy.id);
  connection.database
    .prepare("UPDATE source_files SET status = 'ready' WHERE id = ?")
    .run(copy.sourceFileId);
  connection.database
    .prepare("UPDATE ingest_sessions SET status = 'copying', completed_at = NULL WHERE id = ?")
    .run(sessionId);
  await unlink(copy.destinationPath);
  return { sessionId, copy: { id: copy.id, destinationPath: copy.destinationPath } };
}

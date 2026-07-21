import { randomUUID } from 'node:crypto';
import { constants, mkdirSync } from 'node:fs';
import { access, appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type Database from 'better-sqlite3';
import {
  classifyFile,
  computeQuickFingerprint,
  compileNamingTemplate,
  copyAndVerify,
  createResumeSessionCoordinator,
  createManifestWriter,
  createSessionLogger,
  combineLogSinks,
  appendSourceEventLog,
  createCardEventLogSink,
  createFallbackSourceIdentity,
  evaluateThroughput,
  identifySource,
  hashFile,
  planDestination,
  readSourceMarker,
  runIngest,
  scanMedia,
  validateNamingTemplate,
  writeSourceMarker,
  type FileClassification,
  type PriorFile,
  type RunIngestProgressEvent,
  type IngestMetadata,
  type ResumeSessionCoordinator,
  type ScannedMediaFile,
} from '@ingestarr/ingest-core';
import {
  classifyMediaType,
  createExifToolClient,
  createThumbnailService,
  normalizeCaptureDate,
  type ExifToolClient,
  type ThumbnailServiceOptions,
} from '@ingestarr/metadata';
import {
  getManualSourceFacts,
  nodeDestinationFileSystem,
  nodeTransferFileSystem,
  nodeTraversalFileSystem,
} from '@ingestarr/platform';
import { createRepositories, fromSqliteInteger } from '@ingestarr/storage';
import {
  appSettingsSchema,
  defaultAppSettings,
  ingestMetadataSchema,
  type IngestReview,
  type AppSettings,
  type ValidateTemplateRequest,
  type SessionSnapshot,
  type ListSummaryDaysRequest,
  type ListSummaryMediaRequest,
  type KnownSourceSummary,
  type SummaryDay,
} from '@ingestarr/shared-types';

import { RollingThroughput } from './progress-throughput';

import type { DesktopIngestService } from './controller';

interface ServiceOptions {
  database: Database.Database;
  manifestsPath: string;
  temporaryPath: string;
  logsPath: string;
  thumbnailsPath?: string;
  defaultDestinationRoot?: string;
  now?: () => string;
  id?: () => string;
  classify?: typeof classifyFile;
  scan?: typeof scanMedia;
  classificationYieldInterval?: number;
  yieldToEventLoop?: () => Promise<void>;
  metadataClient?: ExifToolClient;
  metadataCacheEntries?: number;
  metadataCacheTtlMs?: number;
  thumbnailProcessor?: ThumbnailServiceOptions['processor'];
}

interface PreparedSource {
  sourcePath: string;
  destinationPath: string;
  sourceFacts: Awaited<ReturnType<typeof getManualSourceFacts>>;
  files: ScannedMediaFile[];
  recoverableErrors: number;
  sourceId: string;
  identity: ReturnType<typeof identifySource>;
  classifications: Map<string, FileClassification>;
  metadata: Map<string, IngestMetadata>;
}

interface DetectedIdentityFacts {
  platformVolumeId?: string;
  label: string;
  capacityBytes?: number;
  filesystem?: string;
}

function mediaKind(extension: string): 'video' | 'image' | 'other' {
  return [
    '.jpg',
    '.jpeg',
    '.png',
    '.heic',
    '.heif',
    '.tif',
    '.tiff',
    '.dng',
    '.raw',
    '.arw',
    '.cr2',
    '.cr3',
    '.nef',
    '.orf',
    '.pef',
    '.raf',
    '.rw2',
    '.srw',
  ].includes(extension)
    ? 'image'
    : [
          '.3gp',
          '.avi',
          '.m2ts',
          '.m4v',
          '.mkv',
          '.mov',
          '.mp4',
          '.mpeg',
          '.mpg',
          '.mts',
          '.webm',
        ].includes(extension)
      ? 'video'
      : 'other';
}

function phaseFor(status: SessionSnapshot['status']): string {
  return status[0]?.toUpperCase() + status.slice(1);
}

function nestedErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  return 'cause' in error ? nestedErrorCode(error.cause) : undefined;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException('Ingest cancelled', 'AbortError');
}

function quickFingerprintWithFallback(file: ScannedMediaFile, fallbackAt: string): string {
  return computeQuickFingerprint({
    ...file,
    modifiedAt: Number.isNaN(Date.parse(file.modifiedAt)) ? fallbackAt : file.modifiedAt,
  });
}

export function createComposedIngestService(options: ServiceOptions): DesktopIngestService {
  const repositories = createRepositories(options.database);
  let settingsAtStartup = repositories.settings.get('appSettings') ?? defaultAppSettings;
  const now = options.now ?? (() => new Date().toISOString());
  // A brand-new install has no destination configured, which previously forced picking a folder
  // before the app was usable and left no sane fallback if the picker was skipped. Provision a
  // sensible per-OS default (e.g. Documents/Ingestarr) once, up front, so the app works out of
  // the box; the user can still change it any time from Settings. This never overrides a
  // destination the user has already chosen.
  if (settingsAtStartup.destinationRoot === null && options.defaultDestinationRoot !== undefined) {
    try {
      mkdirSync(options.defaultDestinationRoot, { recursive: true });
      settingsAtStartup = { ...settingsAtStartup, destinationRoot: options.defaultDestinationRoot };
      repositories.settings.set('appSettings', settingsAtStartup, now());
    } catch {
      // Best-effort: if the default location can't be created (e.g. read-only filesystem), leave
      // destinationRoot unset so the existing "choose a destination" flow still applies.
    }
  }
  const id = options.id ?? randomUUID;
  const classify = options.classify ?? classifyFile;
  const scan = options.scan ?? scanMedia;
  const metadataClient = options.metadataClient ?? createExifToolClient();
  const metadataCacheEntries = options.metadataCacheEntries ?? 1_024;
  const metadataCacheTtlMs = options.metadataCacheTtlMs ?? 30_000;
  const classificationYieldInterval = options.classificationYieldInterval ?? 64;
  const yieldToEventLoop =
    options.yieldToEventLoop ??
    (() =>
      new Promise<void>((resolve) => {
        setImmediate(resolve);
      }));
  if (!Number.isInteger(classificationYieldInterval) || classificationYieldInterval < 1) {
    throw new RangeError('classificationYieldInterval must be a positive integer');
  }
  if (!Number.isInteger(metadataCacheEntries) || metadataCacheEntries < 1) {
    throw new RangeError('metadataCacheEntries must be a positive integer');
  }
  if (!Number.isFinite(metadataCacheTtlMs) || metadataCacheTtlMs < 1) {
    throw new RangeError('metadataCacheTtlMs must be positive');
  }
  const snapshots = new Map<string, SessionSnapshot>();
  const operations = new Set<Promise<unknown>>();

  // Records a card being added or renamed to a per-card event log on the *destination*
  // (archive) side, independent of any ingest session, so the log reflects every source the
  // user names — not just ones that have already been copied from. This is best-effort: a
  // missing/unwritable configured destination must never block naming a source, and the feature
  // stays entirely opt-in via settings. This is deliberately separate from the on-card identity
  // marker below: this log is an *ingest-history* record living with the archive (useful even
  // after the card has been reformatted), while the on-card marker is the *identity* record that
  // travels with the physical card itself.
  async function writeCardAddedEvent(
    sourceId: string,
    nickname: string | null,
    eventLabel: string,
  ): Promise<void> {
    const settings = repositories.settings.get('appSettings') ?? defaultAppSettings;
    if (!settings.perCardEventLog || settings.destinationRoot === null) return;
    const cardIdentifier = nickname ?? sourceId;
    try {
      const sink = createCardEventLogSink(
        { mkdir: (value, mkdirOptions) => mkdir(value, mkdirOptions), appendFile },
        settings.destinationRoot,
        cardIdentifier,
      );
      await sink.write(`${now()} [INFO] ${eventLabel} (id: ${sourceId})\n`);
    } catch {
      // See comment above: a log write failure must never surface as a naming failure.
    }
  }

  const sourceMarkerFileSystem = {
    mkdir: (value: string, options: { recursive: true }) => mkdir(value, options),
    writeFile: (value: string, text: string) => writeFile(value, text),
    appendFile,
    readFile: (value: string) => readFile(value, 'utf8'),
  };

  // Writes (or refreshes) the durable identity marker directly onto the SOURCE volume itself —
  // `<mountPath>/.ingestarr/card.json` — plus a human-readable line in the on-card event log
  // alongside it. This is the mechanism the user has been asking for ("a folder on the drive
  // with a log of events, and the unique identifier / custom label"): once written, this marker
  // is read back by `prepare()`/`registerDetectedSource` below and treated as the *authoritative*
  // identity for that card, bypassing the platform-volume-id/fallback-fingerprint guessing this
  // card would otherwise need every time it's reconnected.
  //
  // Best-effort by design, mirroring `writeCardAddedEvent`: a write-protected, disconnected, or
  // otherwise unwritable card must never block naming a source or starting an ingest. `createdAt`
  // is preserved across refreshes when the marker already identifies the same source, so renaming
  // a card repeatedly doesn't lose its original "first marked" timestamp.
  async function upsertSourceIdentityMarker(
    mountPath: string,
    sourceId: string,
    nickname: string | null,
    eventLabel: string,
  ): Promise<void> {
    const timestamp = now();
    try {
      const existing = await readSourceMarker(sourceMarkerFileSystem, mountPath);
      const createdAt = existing?.sourceId === sourceId ? existing.createdAt : timestamp;
      await writeSourceMarker(sourceMarkerFileSystem, mountPath, {
        sourceId,
        nickname,
        createdAt,
        updatedAt: timestamp,
      });
    } catch {
      // Best-effort: see comment above. Naming/ingest must proceed even if the card can't be
      // written to (e.g. locked/write-protected, or removed mid-write).
    }
    try {
      await appendSourceEventLog(
        sourceMarkerFileSystem,
        mountPath,
        `${timestamp} [INFO] ${eventLabel} (id: ${sourceId})\n`,
      );
    } catch {
      // The human-readable log is a convenience; its failure must not affect the marker above.
    }
  }
  // Definitively resolves a currently-mounted volume to an existing known source, so a detected
  // card and the known source it represents can be shown as ONE record instead of a confusing
  // duplicate. Resolution order mirrors the ingest path: the authoritative on-card marker first
  // (a card the app has marked before is that source, full stop), then a strong platform-id
  // match. Anything without such a signal is simply its own source — we never guess by label.
  async function resolveKnownSourceForVolume(input: {
    mountPath: string;
    platformVolumeId?: string;
  }): Promise<{ sourceId: string; nickname: string | null } | undefined> {
    try {
      const marker = await readSourceMarker(sourceMarkerFileSystem, input.mountPath);
      if (marker !== undefined) {
        const source = repositories.sources.findById(marker.sourceId);
        if (source !== undefined) return { sourceId: source.id, nickname: source.nickname };
      }
    } catch {
      // A missing/unreadable/corrupt marker simply means "no authoritative identity on the card";
      // fall through to the strong-id match below.
    }
    if (input.platformVolumeId !== undefined) {
      const [candidate] = repositories.identityObservations.findCandidates({
        strongPlatformId: input.platformVolumeId,
      });
      if (candidate !== undefined) {
        return { sourceId: candidate.id, nickname: candidate.nickname };
      }
    }
    return undefined;
  }

  // Tallies the media files physically present on a mounted volume, honoring the configured
  // allowed extensions and directory exclusions. This is a metadata-only walk (no hashing, no
  // copying), so it's safe to run just to show "what's on this card" on the Sources tab.
  async function countSourceMedia(
    mountPath: string,
    signal?: AbortSignal,
  ): Promise<{
    total: number;
    photos: number;
    videos: number;
    other: number;
    bytes: number;
    byDay: Array<{ day: string; photos: number; videos: number; other: number; bytes: number }>;
  }> {
    const settings = repositories.settings.get('appSettings') ?? defaultAppSettings;
    let total = 0;
    let photos = 0;
    let videos = 0;
    let other = 0;
    let bytes = 0;
    // Group by capture day (the file's modified date) so the UI can render a per-date bar.
    const days = new Map<
      string,
      { day: string; photos: number; videos: number; other: number; bytes: number }
    >();
    for await (const result of scan(mountPath, {
      fileSystem: nodeTraversalFileSystem,
      ...(signal === undefined ? {} : { signal }),
      extensions: settings.allowedExtensions,
      excludedDirectoryNames: settings.excludedPathPatterns,
    })) {
      if (result.type !== 'file') continue;
      total += 1;
      bytes += result.file.sizeBytes;
      const kind = classifyMediaType({ extension: result.file.extension });
      if (kind === 'photo') photos += 1;
      else if (kind === 'video') videos += 1;
      else other += 1;
      const day = result.file.modifiedAt.slice(0, 10);
      const bucket = days.get(day) ?? { day, photos: 0, videos: 0, other: 0, bytes: 0 };
      bucket.bytes += result.file.sizeBytes;
      if (kind === 'photo') bucket.photos += 1;
      else if (kind === 'video') bucket.videos += 1;
      else bucket.other += 1;
      days.set(day, bucket);
    }
    const byDay = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
    return { total, photos, videos, other, bytes, byDay };
  }

  const metadataCache = new Map<string, { expiresAt: number; value: IngestMetadata }>();
  const recoverySources = new Map<string, string>();
  const summaryListeners = new Set<() => void>();
  const invalidateSummary = (): void => {
    for (const listener of summaryListeners) {
      try {
        listener();
      } catch {
        // Summary invalidation observers cannot affect durable thumbnail state.
      }
    }
  };
  async function evictThumbnailCache(settings: AppSettings, currentCopyId: string): Promise<void> {
    const artifacts = options.database
      .prepare(
        `SELECT cache_key AS cacheKey, cache_path AS cachePath, size_bytes AS sizeBytes
           FROM thumbnail_artifacts ORDER BY updated_at, cache_key`,
      )
      .all() as Array<{ cacheKey: string; cachePath: string; sizeBytes: bigint | number }>;
    const evict: typeof artifacts = [];
    if (settings.thumbnail.cachePolicy === 'session') {
      const current = options.database
        .prepare('SELECT ingest_session_id AS sessionId FROM copied_files WHERE id = ?')
        .get(currentCopyId) as { sessionId: string } | undefined;
      if (current !== undefined) {
        for (const artifact of artifacts) {
          const belongsToCurrent = options.database
            .prepare(
              `SELECT 1
                 FROM thumbnails thumbnail
                 JOIN copied_files copy ON copy.id = thumbnail.copied_file_id
                WHERE thumbnail.artifact_cache_key = ? AND copy.ingest_session_id = ? LIMIT 1`,
            )
            .get(artifact.cacheKey, current.sessionId);
          if (belongsToCurrent === undefined) evict.push(artifact);
        }
      }
    } else {
      let total = artifacts.reduce(
        (sum, artifact) => sum + fromSqliteInteger(artifact.sizeBytes),
        0,
      );
      for (const artifact of artifacts) {
        if (total <= settings.thumbnail.cacheLimitBytes) break;
        evict.push(artifact);
        total -= fromSqliteInteger(artifact.sizeBytes);
      }
    }
    options.database.transaction(() => {
      for (const artifact of evict) {
        options.database
          .prepare('DELETE FROM thumbnails WHERE artifact_cache_key = ?')
          .run(artifact.cacheKey);
        options.database
          .prepare('DELETE FROM thumbnail_artifacts WHERE cache_key = ?')
          .run(artifact.cacheKey);
      }
    })();
    await Promise.all(evict.map((artifact) => unlink(artifact.cachePath).catch(() => undefined)));
  }

  function buildThumbnailService(settings: AppSettings) {
    return createThumbnailService({
      root: options.thumbnailsPath ?? path.join(options.temporaryPath, 'thumbnails'),
      processor: options.thumbnailProcessor,
      spec: {
        width: settings.thumbnail.width,
        height: settings.thumbnail.height,
      },
      loadRetryState: (job) => repositories.thumbnails.retryState(job.copyId, 'grid'),
      persist: async (state) => {
        if (state.status === 'ready') {
          repositories.thumbnails.recordReady({
            id: id(),
            copiedFileId: state.copyId,
            sourceFileId: state.sourceFileId,
            variant: 'grid',
            cachePath: state.cachePath,
            cacheKey: state.cacheKey,
            checksum: state.checksum,
            generatorVersion: state.generatorVersion,
            mimeType: state.mimeType,
            width: state.width,
            height: state.height,
            sizeBytes: state.sizeBytes,
            retryCount: state.retryCount,
            createdAt: state.updatedAt,
            updatedAt: state.updatedAt,
          });
          await evictThumbnailCache(
            repositories.settings.get('appSettings') ?? defaultAppSettings,
            state.copyId,
          );
        } else {
          repositories.thumbnails.recordFailure({
            id: id(),
            copiedFileId: state.copyId,
            sourceFileId: state.sourceFileId,
            variant: 'grid',
            errorCode: state.errorCode,
            safeMessage: state.safeMessage,
            retryCount: state.retryCount,
            attemptCount: state.attemptCount,
            nextRetryAt: state.nextRetryAt,
            maxAttempts: state.maxAttempts,
            updatedAt: state.updatedAt,
          });
        }
        invalidateSummary();
      },
    });
  }
  let thumbnailService = buildThumbnailService(settingsAtStartup);
  let closing: Promise<void> | undefined;

  const priorFromRecord = (
    record: ReturnType<typeof repositories.sourceFiles.findById>,
  ): PriorFile | undefined => {
    if (record === undefined) return undefined;
    const copy = repositories.copiedFiles.findVerifiedForSourceFile(record.id);
    const latestCopy = options.database
      .prepare(
        `SELECT status FROM copied_files WHERE source_file_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(record.id) as { status: PriorFile['copyStatus'] } | undefined;
    return {
      id: record.id,
      sourceId: record.sourceId,
      relativePath: record.relativePath,
      canonicalPathKey: record.relativePath.normalize('NFC'),
      sizeBytes: record.sizeBytes,
      modifiedAt: record.modifiedAt,
      quickFingerprint: record.quickChecksum ?? '',
      fullChecksum: record.fullChecksum,
      copyStatus: copy === undefined ? (latestCopy?.status ?? 'none') : 'verified',
    };
  };

  const classificationRepository = {
    async findBySourceAndPath(sourceId: string, relativePath: string): Promise<PriorFile[]> {
      return repositories.sourceFiles
        .listVersions(sourceId, relativePath)
        .map(priorFromRecord)
        .filter((value): value is PriorFile => value !== undefined);
    },
    async findBySourceAndSize(sourceId: string, sizeBytes: number): Promise<PriorFile[]> {
      const rows = options.database
        .prepare('SELECT id FROM source_files WHERE source_id = ? AND size_bytes = ? ORDER BY id')
        .all(sourceId, BigInt(sizeBytes)) as Array<{ id: string }>;
      return rows
        .map((row) => priorFromRecord(repositories.sourceFiles.findById(row.id)))
        .filter((value): value is PriorFile => value !== undefined);
    },
    async findByFullChecksum(checksum: string): Promise<PriorFile[]> {
      const rows = options.database
        .prepare('SELECT id FROM source_files WHERE full_checksum = ? ORDER BY id')
        .all(checksum) as Array<{ id: string }>;
      return rows
        .map((row) => priorFromRecord(repositories.sourceFiles.findById(row.id)))
        .filter((value): value is PriorFile => value !== undefined);
    },
  };

  function metadataCacheKey(sourcePath: string, file: ScannedMediaFile): string {
    return `${sourcePath}\0${file.relativePath}\0${file.sizeBytes}\0${file.modifiedAt}`;
  }

  function cacheMetadata(key: string, value: IngestMetadata): void {
    metadataCache.delete(key);
    metadataCache.set(key, { expiresAt: Date.now() + metadataCacheTtlMs, value });
    while (metadataCache.size > metadataCacheEntries) {
      const oldest = metadataCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      metadataCache.delete(oldest);
    }
  }

  async function readMetadata(
    sourceRoot: string,
    file: ScannedMediaFile,
    sessionStartedAt: string,
    signal?: AbortSignal,
  ): Promise<IngestMetadata> {
    const sourcePath = path.join(sourceRoot, ...file.pathSegments);
    const cacheKey = metadataCacheKey(sourceRoot, file);
    const cached = metadataCache.get(cacheKey);
    if (cached !== undefined) {
      if (cached.expiresAt > Date.now()) return cached.value;
      metadataCache.delete(cacheKey);
    }
    let value: IngestMetadata;
    try {
      const extracted = await metadataClient.extract(sourcePath, { signal });
      const capture = normalizeCaptureDate({
        candidates: extracted.dates,
        modifiedAt: file.modifiedAt,
        sessionStartedAt,
      });
      value = ingestMetadataSchema.parse({
        ...capture,
        cameraMake: extracted.cameraMake,
        cameraModel: extracted.cameraModel,
        lensModel: extracted.lensModel,
        mimeType: extracted.mimeType,
        mediaType: classifyMediaType({
          extension: file.extension,
          mimeType: extracted.mimeType,
        }),
        width: extracted.width,
        height: extracted.height,
        durationSeconds: extracted.durationSeconds,
        gpsPresent: extracted.gpsPresent,
        warnings: extracted.warnings,
      });
    } catch (error) {
      if (signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) {
        throw new DOMException('Ingest cancelled', 'AbortError');
      }
      const capture = normalizeCaptureDate({
        candidates: {},
        modifiedAt: file.modifiedAt,
        sessionStartedAt,
      });
      value = ingestMetadataSchema.parse({
        ...capture,
        cameraMake: null,
        cameraModel: null,
        lensModel: null,
        mimeType: null,
        mediaType: classifyMediaType({ extension: file.extension }),
        width: null,
        height: null,
        durationSeconds: null,
        gpsPresent: false,
        warnings: [],
        degradation: {
          message: `Using ${capture.captureAtSource}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    }
    cacheMetadata(cacheKey, value);
    return value;
  }

  async function prepare(
    sourcePath: string,
    destinationPath: string,
    signal?: AbortSignal,
    sessionStartedAt = now(),
    detected?: DetectedIdentityFacts,
    includedCaptureDays?: readonly string[],
  ): Promise<PreparedSource> {
    const settings = repositories.settings.get('appSettings') ?? defaultAppSettings;
    throwIfAborted(signal);
    const [sourceFacts, canonicalDestination] = await Promise.all([
      getManualSourceFacts(sourcePath),
      nodeDestinationFileSystem.realpath(destinationPath),
    ]);
    throwIfAborted(signal);
    const destinationFacts = await nodeDestinationFileSystem.lstat(canonicalDestination);
    if (!destinationFacts.exists || destinationFacts.kind !== 'directory') {
      const error = new Error('Destination must be a directory') as Error & { code: string };
      error.code = 'DESTINATION_INVALID';
      throw error;
    }
    try {
      await access(canonicalDestination, constants.W_OK);
    } catch (cause) {
      const error = new Error('Destination must be writable', { cause }) as Error & {
        code: string;
      };
      error.code = 'DESTINATION_INVALID';
      throw error;
    }

    const scannedFiles: ScannedMediaFile[] = [];
    let recoverableErrors = 0;
    for await (const result of scan(sourceFacts.canonicalRoot, {
      fileSystem: nodeTraversalFileSystem,
      signal,
      extensions: settings.allowedExtensions,
      excludedDirectoryNames: settings.excludedPathPatterns,
    })) {
      if (result.type === 'file') scannedFiles.push(result.file);
      else recoverableErrors += 1;
    }
    // Optional capture-day allowlist: keep only files whose modified date the user selected on
    // the review screen. Days are compared as YYYY-MM-DD, matching the Sources tab breakdown.
    const includedDays =
      includedCaptureDays !== undefined && includedCaptureDays.length > 0
        ? new Set(includedCaptureDays)
        : undefined;
    const files =
      includedDays === undefined
        ? scannedFiles
        : scannedFiles.filter((file) => includedDays.has(file.modifiedAt.slice(0, 10)));
    // The fingerprint is always computed (candidates: []) purely for recovery bookkeeping — see
    // `session_recovery_context` below — never for matching against known sources here.
    const fallback = identifySource(
      {
        label: detected?.label ?? sourceFacts.label,
        capacityBytes: detected?.capacityBytes ?? sourceFacts.capacityBytes,
        filesystem: detected?.filesystem ?? sourceFacts.filesystem,
        ...(detected?.platformVolumeId === undefined
          ? {}
          : { platformVolumeId: detected.platformVolumeId }),
        files,
      },
      [],
    ).identity.fallback;
    // If this card carries its own on-card identity marker (written the first time it was
    // named — see `upsertSourceIdentityMarker`), that marker IS the identity, full stop: it
    // bypasses the strong-platform-id lookup and the fuzzy fallback-fingerprint/label matching
    // below entirely, so a card named once never again shows up as a duplicate/"Untitled"/"may
    // already be known as" candidate. Cards that predate this feature (or have never been named
    // through this app) have no marker and fall through to the existing reconciliation path,
    // unaffected.
    const marker = await readSourceMarker(sourceMarkerFileSystem, sourceFacts.canonicalRoot);
    let identity: ReturnType<typeof identifySource>;
    let sourceId: string;
    if (marker !== undefined) {
      identity = {
        identity: {
          ...(detected?.platformVolumeId === undefined
            ? {}
            : { platformVolumeId: detected.platformVolumeId }),
          fallback,
        },
        matches: [
          {
            sourceId: marker.sourceId,
            confidence: 'exact',
            reasons: ['on-card-identity-marker'],
            requiresConfirmation: false,
          },
        ],
        reconciliation: 'candidate-found',
      };
      sourceId = marker.sourceId;
    } else {
      const candidates = repositories.identityObservations
        .findCandidates({
          ...(detected?.platformVolumeId === undefined
            ? {}
            : { strongPlatformId: detected.platformVolumeId }),
          fingerprint: fallback.fingerprint,
          algorithmVersion: fallback.algorithmVersion,
        })
        .map((source) => {
          const observations = repositories.identityObservations.listForSource(source.id);
          return {
            sourceId: source.id,
            ...(observations.find(
              (observation) =>
                detected?.platformVolumeId !== undefined &&
                observation.strongPlatformId === detected.platformVolumeId,
            )?.strongPlatformId === undefined
              ? {}
              : { platformVolumeId: detected?.platformVolumeId }),
            fallbackFingerprint: observations[0]?.fingerprint,
            fallbackFingerprintAliases: repositories.identityObservations
              .listAliases(source.id)
              .map((alias) => alias.fingerprint),
          };
        });
      identity = identifySource(
        {
          label: detected?.label ?? sourceFacts.label,
          capacityBytes: detected?.capacityBytes ?? sourceFacts.capacityBytes,
          filesystem: detected?.filesystem ?? sourceFacts.filesystem,
          ...(detected?.platformVolumeId === undefined
            ? {}
            : { platformVolumeId: detected.platformVolumeId }),
          files,
        },
        candidates,
      );
      const confirmed = identity.matches.find(
        (match) => match.confidence === 'exact' && !match.requiresConfirmation,
      );
      sourceId = confirmed?.sourceId ?? `source-${fallback.fingerprint.slice(-24)}`;
    }
    const classifications = new Map<string, FileClassification>();
    const metadata = new Map<string, IngestMetadata>();
    for (const [index, file] of files.entries()) {
      throwIfAborted(signal);
      metadata.set(
        file.relativePath,
        await readMetadata(sourceFacts.canonicalRoot, file, sessionStartedAt, signal),
      );
      throwIfAborted(signal);
      const classification = await classify(
        {
          sourceId,
          relativePath: file.relativePath,
          canonicalPathKey: file.canonicalPathKey,
          sizeBytes: file.sizeBytes,
          modifiedAt: file.modifiedAt,
          quickFingerprint: quickFingerprintWithFallback(file, sessionStartedAt),
        },
        classificationRepository,
      );
      throwIfAborted(signal);
      classifications.set(file.relativePath, classification);
      throwIfAborted(signal);
      if ((index + 1) % classificationYieldInterval === 0) {
        await yieldToEventLoop();
        throwIfAborted(signal);
      }
    }
    return {
      sourcePath: sourceFacts.canonicalRoot,
      destinationPath: canonicalDestination,
      sourceFacts,
      files,
      recoverableErrors,
      sourceId,
      identity,
      classifications,
      metadata,
    };
  }

  function reviewFromPrepared(
    prepared: PreparedSource,
  ): Omit<IngestReview, 'reviewId' | 'expiresAt'> {
    const counts = { new: 0, known: 0, ambiguous: 0, recoverable: prepared.recoverableErrors };
    let estimatedBytes = 0;
    // Aggregate the card's media by capture (modified) day so the review screen can offer a
    // per-date selection. Photo/video/other counts mirror the Sources tab breakdown.
    const dayBuckets = new Map<
      string,
      { day: string; photos: number; videos: number; other: number; bytes: number }
    >();
    for (const file of prepared.files) {
      const decision = prepared.classifications.get(file.relativePath)?.decision ?? 'New';
      const key = decision.toLowerCase() as 'new' | 'known' | 'ambiguous' | 'recoverable';
      counts[key] += 1;
      if (key !== 'known') estimatedBytes += file.sizeBytes;
      const day = file.modifiedAt.slice(0, 10);
      const bucket = dayBuckets.get(day) ?? { day, photos: 0, videos: 0, other: 0, bytes: 0 };
      const mediaType = classifyMediaType({ extension: file.extension });
      if (mediaType === 'photo') bucket.photos += 1;
      else if (mediaType === 'video') bucket.videos += 1;
      else bucket.other += 1;
      bucket.bytes += file.sizeBytes;
      dayBuckets.set(day, bucket);
    }
    const byDay = [...dayBuckets.values()].sort((a, b) => a.day.localeCompare(b.day));
    const firstFile = prepared.files[0];
    const day =
      (firstFile === undefined ? undefined : prepared.metadata.get(firstFile.relativePath))
        ?.captureDay ?? now().slice(0, 10);
    const settings = repositories.settings.get('appSettings') ?? defaultAppSettings;
    const firstFilename =
      firstFile === undefined ? 'IMG_0001.JPG' : path.basename(firstFile.relativePath);
    const relativePreview = compileNamingTemplate(settings.destinationTemplate, {
      captureDay: day,
      sourceLabelOrCamera: prepared.sourceFacts.label,
      originalFilename: firstFilename,
    });
    const candidates = prepared.identity.matches.map((match) => ({
      sourceId: match.sourceId,
      displayName: repositories.sources.findById(match.sourceId)?.displayName ?? 'Known source',
      confidence: match.confidence,
      reasons: match.reasons,
    }));
    return {
      source: {
        displayName: prepared.sourceFacts.displayName,
        identity: prepared.identity.matches.length === 0 ? 'New source' : 'Known source candidate',
        confidence:
          prepared.identity.matches[0]?.confidence === 'exact'
            ? 'high'
            : (prepared.identity.matches[0]?.confidence ?? 'medium'),
        requiresConfirmation: prepared.identity.reconciliation === 'confirmation-required',
        candidates,
      },
      counts,
      estimatedBytes,
      destinationPreview: path.join(path.basename(prepared.destinationPath), relativePreview),
      byDay,
    };
  }

  function durableSnapshot(sessionId: string): SessionSnapshot | undefined {
    const state = repositories.sessions.findById(sessionId);
    if (state === undefined) return undefined;
    const manifest = repositories.manifests.loadSession(sessionId);
    const completedFiles = manifest.files.filter((file) => file.status === 'completed').length;
    const skippedFiles = manifest.files.filter((file) => file.status === 'skipped').length;
    const failed = manifest.files.filter((file) => file.status === 'failed');
    const sessionError =
      state.errorCode === null
        ? []
        : [
            {
              code: state.errorCode,
              message: state.errorMessage ?? 'The ingest could not be completed.',
            },
          ];
    return {
      sessionId,
      sourceId: state.sourceId,
      status: state.status,
      phase: phaseFor(state.status),
      totalFiles: manifest.files.length,
      completedFiles,
      newFiles: manifest.files.filter((file) => file.status !== 'skipped').length,
      verifiedFiles: completedFiles,
      skippedFiles,
      failedFiles: failed.length,
      totalBytes: manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0),
      completedBytes: manifest.files.reduce((sum, file) => sum + file.copiedBytes, 0),
      throughputBytesPerSecond: 0,
      errors: [
        ...sessionError,
        ...failed.map((file) => ({
          code: file.errorCode ?? 'FILE_FAILED',
          message: file.errorMessage ?? 'The file could not be copied.',
          filename: path.basename(file.relativePath),
        })),
      ],
      startedAt: state.startedAt,
      updatedAt: state.completedAt ?? state.startedAt,
    };
  }

  async function computeReacquiredIdentity(sourcePath: string, signal?: AbortSignal) {
    const settings = repositories.settings.get('appSettings') ?? defaultAppSettings;
    const facts = await getManualSourceFacts(sourcePath);
    const files: ScannedMediaFile[] = [];
    for await (const result of scan(facts.canonicalRoot, {
      fileSystem: nodeTraversalFileSystem,
      signal,
      extensions: settings.allowedExtensions,
      excludedDirectoryNames: settings.excludedPathPatterns,
    })) {
      if (result.type === 'file') files.push(result.file);
    }
    const identity = identifySource(
      {
        label: facts.label,
        ...(facts.capacityBytes === undefined ? {} : { capacityBytes: facts.capacityBytes }),
        ...(facts.filesystem === undefined ? {} : { filesystem: facts.filesystem }),
        files,
      },
      [],
    ).identity;
    return {
      canonicalRoot: facts.canonicalRoot,
      strongId: identity.platformVolumeId ?? null,
      fingerprint: identity.fallback.fingerprint,
      algorithmVersion: identity.fallback.algorithmVersion,
    };
  }

  async function reconcileRecoverySource(
    sessionId: string,
    sourcePath: string,
    confirmSourceMismatch: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const persisted = options.database
      .prepare(
        `SELECT source_strong_id AS strongId, source_fingerprint AS fingerprint,
                source_algorithm_version AS algorithmVersion
           FROM session_recovery_context WHERE session_id = ?`,
      )
      .get(sessionId) as
      | { strongId: string | null; fingerprint: string | null; algorithmVersion: string | null }
      | undefined;
    const reacquired = await computeReacquiredIdentity(sourcePath, signal);
    const strongMatch =
      persisted?.strongId != null &&
      reacquired.strongId != null &&
      persisted.strongId === reacquired.strongId;
    const strongConflict =
      persisted?.strongId != null &&
      reacquired.strongId != null &&
      persisted.strongId !== reacquired.strongId;
    const fingerprintMatch =
      persisted?.fingerprint != null && persisted.fingerprint === reacquired.fingerprint;
    const verifiable = persisted?.strongId != null || persisted?.fingerprint != null;
    const matched = strongMatch || (fingerprintMatch && !strongConflict);
    const decision = matched
      ? 'confirmed-strong-or-fingerprint'
      : confirmSourceMismatch
        ? 'user-confirmed-mismatch'
        : 'rejected-mismatch';
    await appendFile(
      path.join(options.logsPath, `${sessionId}.recovery.jsonl`),
      `${JSON.stringify({
        sessionId,
        kind: 'source-reconciliation',
        decision,
        strongMatch,
        strongConflict,
        fingerprintMatch,
        verifiable,
        at: now(),
      })}\n`,
    ).catch(() => undefined);
    if (matched) {
      recoverySources.set(sessionId, reacquired.canonicalRoot);
      return;
    }
    if (confirmSourceMismatch) {
      recoverySources.set(sessionId, reacquired.canonicalRoot);
      return;
    }
    throw Object.assign(
      new Error(
        verifiable
          ? 'The selected folder does not match the interrupted card. Confirm to continue.'
          : 'The interrupted source identity is unknown. Confirm the selected folder to continue.',
      ),
      { code: 'SOURCE_MISMATCH' },
    );
  }

  let recoveryCoordinator: ResumeSessionCoordinator | undefined;
  async function loadRecoveryRoots(sessionId: string) {
    const context = options.database
      .prepare(
        `SELECT destination_root AS destinationRoot
           FROM session_recovery_context WHERE session_id = ?`,
      )
      .get(sessionId) as { destinationRoot: string } | undefined;
    const destinationRoot =
      context?.destinationRoot ??
      (repositories.settings.get('appSettings') ?? defaultAppSettings).destinationRoot;
    if (destinationRoot === null || destinationRoot === undefined) {
      throw new Error('Recovery destination context is unavailable.');
    }
    return {
      destinationRoot,
      temporaryRoot: destinationRoot,
      provisionalRoot: destinationRoot,
    };
  }

  function coordinator(): ResumeSessionCoordinator {
    recoveryCoordinator ??= createResumeSessionCoordinator({
      async loadSession(sessionId) {
        const session = repositories.sessions.findById(sessionId);
        if (session === undefined) return undefined;
        const copies = options.database
          .prepare(
            `SELECT copy.id, copy.status, copy.expected_bytes AS expectedBytes,
                    copy.checksum, copy.destination_path AS destinationPath,
                    source.relative_path AS sourceRelativePath,
                    source.full_checksum AS sourceChecksum
               FROM copied_files copy
               JOIN source_files source ON source.id = copy.source_file_id
              WHERE copy.ingest_session_id = ?
              ORDER BY copy.created_at, copy.id`,
          )
          .all(sessionId) as Array<{
          id: string;
          status: 'planned' | 'started' | 'failed' | 'verified';
          expectedBytes: bigint | number;
          checksum: string | null;
          destinationPath: string;
          sourceRelativePath: string;
          sourceChecksum: string | null;
        }>;
        return {
          id: session.id,
          status: session.status,
          copies: copies.map((copy) => {
            const expectedBytes = fromSqliteInteger(copy.expectedBytes);
            const temporaryPath = path.join(
              path.dirname(copy.destinationPath),
              `.${path.basename(copy.destinationPath)}.${sessionId}.${copy.id}.tmp`,
            );
            return {
              id: copy.id,
              status: copy.status,
              expectedBytes,
              expectedChecksum: copy.checksum ?? copy.sourceChecksum,
              checksum: copy.checksum,
              sourceRelativePath: copy.sourceRelativePath,
              destinationPath: copy.destinationPath,
              temporaryPath,
              ...(copy.status === 'verified' ? {} : { provisionalPath: copy.destinationPath }),
            };
          }),
        };
      },
      roots: loadRecoveryRoots,
      async sourceAvailable(session) {
        const sourceRoot = recoverySources.get(session.id);
        if (sourceRoot === undefined) return false;
        try {
          const facts = await nodeTransferFileSystem.lstat(sourceRoot);
          return facts.exists && facts.kind === 'directory';
        } catch {
          return false;
        }
      },
      lstat: nodeTransferFileSystem.lstat,
      realpath: nodeTransferFileSystem.realpath,
      async hash(value) {
        return (await hashFile(nodeTransferFileSystem, value)).checksum;
      },
      async remove(value, expectedFileId) {
        const current = await nodeTransferFileSystem.lstat(value);
        if (
          !current.exists ||
          current.kind !== 'file' ||
          (expectedFileId !== undefined && current.fileId !== expectedFileId)
        ) {
          throw new Error('Recovery artifact changed before cleanup.');
        }
        await nodeTransferFileSystem.remove(value);
      },
      async quarantine(value, expectedFileId) {
        const current = await nodeTransferFileSystem.lstat(value);
        if (
          !current.exists ||
          current.kind !== 'file' ||
          (expectedFileId !== undefined && current.fileId !== expectedFileId)
        ) {
          throw new Error('Recovery artifact changed before quarantine.');
        }
        const quarantinePath = `${value}.ingestarr-quarantine-${id()}`;
        const collision = await nodeTransferFileSystem.lstat(quarantinePath);
        if (collision.exists) throw new Error('Recovery quarantine path already exists.');
        await rename(value, quarantinePath);
      },
      async resetCopy(copyId) {
        const at = now();
        options.database.transaction(() => {
          const row = options.database
            .prepare('SELECT source_file_id AS sourceFileId FROM copied_files WHERE id = ?')
            .get(copyId) as { sourceFileId: string } | undefined;
          if (row === undefined) throw new Error(`Copied file ${copyId} does not exist.`);
          options.database
            .prepare(
              `UPDATE copied_files
                  SET status = 'planned', copied_bytes = 0, checksum = NULL,
                      started_at = NULL, last_progress_at = NULL, failed_at = NULL,
                      recovery_started_at = NULL, verified_at = NULL,
                      error_code = NULL, error_message = NULL, updated_at = ?
                WHERE id = ?`,
            )
            .run(at, copyId);
          options.database
            .prepare(
              `UPDATE source_files
                  SET status = 'ready', error_code = NULL, error_message = NULL, updated_at = ?
                WHERE id = ?`,
            )
            .run(at, row.sourceFileId);
        })();
      },
      async markVerified(copyId, checksum, bytes) {
        const at = now();
        options.database.transaction(() => {
          const row = options.database
            .prepare(
              `SELECT source_file_id AS sourceFileId, expected_bytes AS expectedBytes
                 FROM copied_files WHERE id = ?`,
            )
            .get(copyId) as { sourceFileId: string; expectedBytes: bigint | number } | undefined;
          if (row === undefined || fromSqliteInteger(row.expectedBytes) !== bytes) {
            throw new Error('Recovered copy size does not match its durable plan.');
          }
          options.database
            .prepare(
              `UPDATE copied_files
                  SET status = 'verified', copied_bytes = expected_bytes, checksum = ?,
                      started_at = COALESCE(started_at, ?), failed_at = NULL,
                      verified_at = ?, error_code = NULL, error_message = NULL, updated_at = ?
                WHERE id = ?`,
            )
            .run(checksum, at, at, at, copyId);
          options.database
            .prepare(
              `UPDATE source_files
                  SET status = 'completed', full_checksum = COALESCE(full_checksum, ?),
                      error_code = NULL, error_message = NULL, updated_at = ?
                WHERE id = ?`,
            )
            .run(checksum, at, row.sourceFileId);
        })();
      },
      async scheduleCopy(copy, signal) {
        const sessionRow = options.database
          .prepare('SELECT ingest_session_id AS sessionId FROM copied_files WHERE id = ?')
          .get(copy.id) as { sessionId: string } | undefined;
        const sessionId = sessionRow?.sessionId;
        const root = sessionId === undefined ? undefined : recoverySources.get(sessionId);
        if (sessionId === undefined || root === undefined) {
          throw Object.assign(new Error('Recovery source is unavailable.'), {
            code: 'SOURCE_UNAVAILABLE',
          });
        }
        const sourcePath = path.resolve(root, ...copy.sourceRelativePath.split('/'));
        const relative = path.relative(root, sourcePath);
        if (
          relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          throw new Error('Recovered source path escaped the selected source root.');
        }
        const sourceFacts = await nodeTransferFileSystem.stat(sourcePath);
        const result = await copyAndVerify(
          {
            id: copy.id,
            sessionId,
            sourcePath,
            destinationRoot: (await loadRecoveryRoots(sessionId)).destinationRoot,
            destinationPath: copy.destinationPath,
            expectedBytes: copy.expectedBytes,
            ...(copy.expectedChecksum === null ? {} : { expectedChecksum: copy.expectedChecksum }),
            expectedSource: sourceFacts,
          },
          {
            fileSystem: nodeTransferFileSystem,
            signal,
            lifecycle: {
              plan: async () => undefined,
              markStarted: async (value, at) => repositories.copiedFiles.markStarted(value, at),
              updateProgress: async (value, bytes, at) =>
                repositories.copiedFiles.updateProgress(value, bytes, at),
              markVerified: async (value, bytes, checksum, at) =>
                repositories.copiedFiles.markVerified(value, bytes, checksum, at),
              markFailed: async (value, code, message, at) =>
                repositories.copiedFiles.markFailed(value, code, message, at),
            },
          },
        );
        if (result.status === 'collision') {
          throw Object.assign(new Error('Recovery destination collision.'), {
            code: 'DESTINATION_COLLISION',
          });
        }
      },
      async markSession(sessionId, status) {
        const at = now();
        options.database
          .prepare(
            `UPDATE ingest_sessions
                SET status = ?, completed_at = ?,
                    error_code = CASE
                      WHEN ? = 'cancelled' THEN 'RECOVERY_CLEANED'
                      WHEN ? = 'failed' THEN 'RECOVERY_FAILED'
                      ELSE NULL END,
                    error_message = CASE
                      WHEN ? = 'cancelled' THEN 'Interrupted ingest cleaned safely.'
                      WHEN ? = 'failed' THEN 'Recovery failed. The session remains visible.'
                      ELSE NULL END,
                    updated_at = ?
              WHERE id = ?`,
          )
          .run(status, at, status, status, status, status, at, sessionId);
      },
      async regenerateManifest(sessionId) {
        const writer = createManifestWriter({
          manifestPath: path.join(options.manifestsPath, `${sessionId}.json`),
          sessionId,
          repository: { loadManifest: async (value) => repositories.manifests.loadSession(value) },
          fileSystem: nodeTransferFileSystem,
        });
        await writer.snapshot();
      },
      async audit(event) {
        await appendFile(
          path.join(options.logsPath, `${event.sessionId}.recovery.jsonl`),
          `${JSON.stringify({ ...event, at: now() })}\n`,
        );
      },
    });
    return recoveryCoordinator;
  }

  return {
    review(sourcePath, destinationPath, detected) {
      const operation = prepare(sourcePath, destinationPath, undefined, now(), detected).then(
        reviewFromPrepared,
      );
      const tracked = operation.finally(() => operations.delete(tracked));
      operations.add(tracked);
      return tracked;
    },

    getSettings(): AppSettings {
      return repositories.settings.get('appSettings') ?? defaultAppSettings;
    },

    listKnownSources(onlinePlatformIds: readonly string[] = []): KnownSourceSummary[] {
      const rows = options.database
        .prepare(
          `SELECT source.id, source.display_name AS displayName, source.nickname, source.kind,
                  source.first_seen_at AS firstSeenAt, source.last_seen_at AS lastSeenAt,
                  (SELECT COUNT(*) FROM ingest_sessions session
                    WHERE session.source_id = source.id) AS sessionCount,
                  (SELECT session.status FROM ingest_sessions session
                    WHERE session.source_id = source.id
                    ORDER BY session.started_at DESC, session.id DESC LIMIT 1) AS lastSessionStatus,
                  (SELECT COUNT(*) FROM copied_files copy
                    WHERE copy.source_id = source.id AND copy.status = 'verified')
                    AS verifiedMediaCount,
                  (SELECT COALESCE(SUM(copy.expected_bytes), 0) FROM copied_files copy
                    WHERE copy.source_id = source.id AND copy.status = 'verified')
                    AS verifiedBytes,
                  (SELECT observation.confidence FROM source_identity_observations observation
                    WHERE observation.source_id = source.id
                    ORDER BY observation.observed_at DESC, observation.id DESC LIMIT 1)
                    AS identityConfidence,
                  (SELECT observation.fingerprint FROM source_identity_observations observation
                    WHERE observation.source_id = source.id
                    ORDER BY observation.observed_at DESC, observation.id DESC LIMIT 1)
                    AS fingerprint,
                  (SELECT observation.algorithm_version FROM source_identity_observations observation
                    WHERE observation.source_id = source.id
                    ORDER BY observation.observed_at DESC, observation.id DESC LIMIT 1)
                    AS algorithmVersion,
                  (SELECT observation.strong_platform_id
                     FROM source_identity_observations observation
                    WHERE observation.source_id = source.id
                      AND observation.strong_platform_id IS NOT NULL
                    ORDER BY observation.observed_at DESC, observation.id DESC LIMIT 1)
                    AS strongPlatformId
             FROM sources source
            WHERE source.display_name <> 'Pending source'
            ORDER BY source.last_seen_at DESC, source.id`,
        )
        .all() as Array<{
        id: string;
        displayName: string;
        nickname: string | null;
        kind: KnownSourceSummary['kind'];
        firstSeenAt: string;
        lastSeenAt: string;
        sessionCount: bigint | number;
        lastSessionStatus: KnownSourceSummary['lastSessionStatus'];
        verifiedMediaCount: bigint | number;
        verifiedBytes: bigint | number;
        identityConfidence: KnownSourceSummary['identityConfidence'] | null;
        fingerprint: string | null;
        algorithmVersion: bigint | number | null;
        strongPlatformId: string | null;
      }>;
      const online = new Set(onlinePlatformIds);
      return rows.map((row) => {
        const throughputStats = repositories.throughputStats.findForSource(row.id);
        const throughput =
          throughputStats === undefined
            ? undefined
            : {
                averageBytesPerSecond: throughputStats.averageBytesPerSecond,
                lastBytesPerSecond: throughputStats.lastBytesPerSecond,
                sampleCount: throughputStats.sampleCount,
                isSlow: evaluateThroughput({
                  currentBytesPerSecond: throughputStats.lastBytesPerSecond,
                  historicalAverageBytesPerSecond: throughputStats.averageBytesPerSecond,
                  sampleCount: throughputStats.sampleCount,
                }).isSlow,
              };
        return {
          id: row.id,
          displayName: row.displayName,
          nickname: row.nickname,
          kind: row.kind,
          online: row.strongPlatformId !== null && online.has(row.strongPlatformId),
          firstSeenAt: row.firstSeenAt,
          lastSeenAt: row.lastSeenAt,
          sessionCount: fromSqliteInteger(row.sessionCount),
          lastSessionStatus: row.lastSessionStatus,
          verifiedMediaCount: fromSqliteInteger(row.verifiedMediaCount),
          verifiedBytes: fromSqliteInteger(row.verifiedBytes),
          identityConfidence: row.identityConfidence ?? 'none',
          ...(row.fingerprint === null ? {} : { fingerprint: row.fingerprint }),
          ...(row.algorithmVersion === null
            ? {}
            : { algorithmVersion: fromSqliteInteger(row.algorithmVersion) }),
          ...(throughput === undefined ? {} : { throughput }),
        };
      });
    },

    resolveKnownSourceForVolume,

    countSourceMedia,

    async setSourceNickname(
      sourceId: string,
      nickname: string | null,
    ): Promise<{ nickname: string | null }> {
      const updated = repositories.sources.setNickname(sourceId, nickname, now());
      await writeCardAddedEvent(
        sourceId,
        updated.nickname,
        `source-renamed Nickname set to "${updated.nickname ?? '(cleared)'}"`,
      );
      return { nickname: updated.nickname };
    },

    // Lets a card be nicknamed as soon as it's detected, without requiring a full ingest first.
    //
    // The on-card identity marker (see `upsertSourceIdentityMarker`) is checked FIRST, when a
    // mount path is available: if this card was already named through this app before, the
    // marker read straight off the card is authoritative, full stop — it bypasses the strong
    // platform-id lookup and the fuzzy fallback-fingerprint/label matching below entirely, so a
    // once-named card never again shows up as a duplicate/"Untitled"/"may already be known as"
    // candidate, even if the OS-reported volume id changed or was never available.
    //
    // Absent a marker, a currently-mounted removable volume's platform volume id (when
    // available) is used to reconcile against any source already known from a prior ingest, so
    // naming doesn't create a duplicate row; otherwise a fresh source is created and seeded with
    // an identity observation (and an on-card marker) so any later detection recognizes it.
    //
    // Naming is intentionally a single, unambiguous action: the user is telling us "this card is
    // this". We never interrupt with a "is this the same card?" prompt — authoritative signals
    // (on-card marker, strong platform id) reconcile automatically, and anything else is simply
    // recorded as its own source. The marker written here makes the card self-identifying from
    // then on, so re-inserting it later resolves directly without any guesswork.
    async registerDetectedSource(
      detected: {
        platformVolumeId?: string;
        label: string;
        kind: 'removable-volume' | 'folder';
        mountPath?: string;
      },
      nickname: string | null,
    ): Promise<{ sourceId: string; nickname: string | null }> {
      const timestamp = now();

      const markVolumeAsIdentified = async (
        resolvedSourceId: string,
        resolvedNickname: string | null,
        eventLabel: string,
      ): Promise<{ sourceId: string; nickname: string | null }> => {
        if (detected.mountPath !== undefined) {
          await upsertSourceIdentityMarker(
            detected.mountPath,
            resolvedSourceId,
            resolvedNickname,
            eventLabel,
          );
        }
        return { sourceId: resolvedSourceId, nickname: resolvedNickname };
      };

      const marker =
        detected.mountPath === undefined
          ? undefined
          : await readSourceMarker(sourceMarkerFileSystem, detected.mountPath);
      if (marker !== undefined) {
        if (repositories.sources.findById(marker.sourceId) === undefined) {
          repositories.sources.create({
            id: marker.sourceId,
            kind: detected.kind,
            displayName: detected.label,
            firstSeenAt: marker.createdAt,
            lastSeenAt: timestamp,
            createdAt: marker.createdAt,
            updatedAt: timestamp,
            nickname: marker.nickname,
          });
        } else {
          repositories.sources.updateLastSeen(marker.sourceId, timestamp);
        }
        const updated = repositories.sources.setNickname(marker.sourceId, nickname, timestamp);
        await writeCardAddedEvent(
          marker.sourceId,
          updated.nickname,
          `source-renamed Nickname set to "${updated.nickname ?? '(cleared)'}" (resolved via on-card identity marker)`,
        );
        return markVolumeAsIdentified(
          marker.sourceId,
          updated.nickname,
          `source-renamed Nickname set to "${updated.nickname ?? '(cleared)'}"`,
        );
      }

      const existing =
        detected.platformVolumeId === undefined
          ? []
          : repositories.identityObservations.findCandidates({
              strongPlatformId: detected.platformVolumeId,
            });
      const sourceId = existing[0]?.id;
      if (sourceId !== undefined) {
        repositories.sources.updateLastSeen(sourceId, timestamp);
        const updated = repositories.sources.setNickname(sourceId, nickname, timestamp);
        await writeCardAddedEvent(
          sourceId,
          updated.nickname,
          `source-renamed Nickname set to "${updated.nickname ?? '(cleared)'}"`,
        );
        return markVolumeAsIdentified(
          sourceId,
          updated.nickname,
          `source-renamed Nickname set to "${updated.nickname ?? '(cleared)'}"`,
        );
      }

      const newSourceId = id();
      repositories.sources.create({
        id: newSourceId,
        kind: detected.kind,
        displayName: detected.label,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
        nickname,
      });
      // Always seed a fallback identity observation, even without a strong platform id: without
      // one on record, this source could never be found again by `findLikelyKnownSourceMatches`
      // (or by fingerprint during a later ingest's review step), which is exactly the gap that
      // let the same fallback-only card look unrelated to a later strong-id detection.
      const fallback = createFallbackSourceIdentity({
        label: detected.label,
        ...(detected.platformVolumeId === undefined
          ? {}
          : { platformVolumeId: detected.platformVolumeId }),
        files: [],
      });
      repositories.identityObservations.create({
        id: id(),
        sourceId: newSourceId,
        observedAt: timestamp,
        algorithmVersion: fallback.algorithmVersion,
        fingerprint: fallback.fingerprint,
        rawFacts: fallback.normalizedFacts,
        confidence: 'medium',
        strongPlatformId: detected.platformVolumeId ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await writeCardAddedEvent(
        newSourceId,
        nickname,
        `source-added "${detected.label}" registered as a known source with nickname "${nickname ?? '(none)'}"`,
      );
      return markVolumeAsIdentified(
        newSourceId,
        nickname,
        `source-added "${detected.label}" registered as a known source with nickname "${nickname ?? '(none)'}"`,
      );
    },

    async updateSettings(settings: AppSettings): Promise<AppSettings> {
      const validated = appSettingsSchema.parse(settings);
      const template = validateNamingTemplate(validated.destinationTemplate);
      if (!template.valid) throw new Error(template.errors.join(' '));
      if (validated.destinationRoot !== null) {
        const canonical = await nodeDestinationFileSystem.realpath(validated.destinationRoot);
        const facts = await nodeDestinationFileSystem.lstat(canonical);
        if (!facts.exists || facts.kind !== 'directory') {
          const error = new Error('Destination must be a directory') as Error & { code: string };
          error.code = 'DESTINATION_INVALID';
          throw error;
        }
        try {
          await access(canonical, constants.W_OK);
        } catch (cause) {
          const error = new Error('Destination must be writable', { cause }) as Error & {
            code: string;
          };
          error.code = 'DESTINATION_INVALID';
          throw error;
        }
        validated.destinationRoot = canonical;
      }
      repositories.settings.set('appSettings', validated, now());
      await thumbnailService.close();
      thumbnailService = buildThumbnailService(validated);
      return validated;
    },

    validateTemplate(request: ValidateTemplateRequest) {
      const validation = validateNamingTemplate(request.template);
      if (!validation.valid) return validation;
      try {
        return {
          valid: true,
          errors: [],
          preview: compileNamingTemplate(
            request.template,
            request.sample ?? {
              captureDay: now().slice(0, 10),
              sourceLabelOrCamera: 'CARD',
              originalFilename: 'IMG_0001.JPG',
            },
          ),
        };
      } catch (error) {
        return {
          valid: false,
          errors: [error instanceof Error ? error.message : String(error)],
        };
      }
    },

    async start(
      sourcePath,
      destinationPath,
      signal,
      emit,
      detected,
      sourceDecision,
      includedCaptureDays,
    ) {
      const sessionId = id();
      const startedAt = now();
      const pendingSourceId = `pending-${sessionId}`;
      repositories.sources.create({
        id: pendingSourceId,
        kind: 'folder',
        displayName: 'Pending source',
        firstSeenAt: startedAt,
        lastSeenAt: startedAt,
        createdAt: startedAt,
        updatedAt: startedAt,
      });
      repositories.sessions.create({
        id: sessionId,
        sourceId: pendingSourceId,
        status: 'discovering',
        startedAt,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
        createdAt: startedAt,
        updatedAt: startedAt,
      });
      const writer = createManifestWriter({
        manifestPath: path.join(options.manifestsPath, `${sessionId}.json`),
        sessionId,
        repository: { loadManifest: async (value) => repositories.manifests.loadSession(value) },
        fileSystem: nodeTransferFileSystem,
      });
      const baseTextSink = {
        write: (line: string) => appendFile(path.join(options.logsPath, `${sessionId}.log`), line),
      };
      let activeTextSink = baseTextSink;
      const logger = createSessionLogger({
        sessionId,
        redactPaths: true,
        structuredSink: {
          write: (line) => appendFile(path.join(options.logsPath, `${sessionId}.jsonl`), line),
        },
        textSink: {
          write: (line) => activeTextSink.write(line),
        },
      });
      let snapshot: SessionSnapshot = {
        sessionId,
        sourceId: pendingSourceId,
        status: 'discovering',
        phase: 'Discovering',
        totalFiles: 0,
        completedFiles: 0,
        newFiles: 0,
        verifiedFiles: 0,
        skippedFiles: 0,
        failedFiles: 0,
        totalBytes: 0,
        completedBytes: 0,
        throughputBytesPerSecond: 0,
        errors: [],
        startedAt,
        updatedAt: startedAt,
      };
      const publish = (updates: Partial<SessionSnapshot>): void => {
        snapshot = { ...snapshot, ...updates, updatedAt: now() };
        snapshots.set(sessionId, snapshot);
        emit(snapshot);
      };
      snapshots.set(sessionId, snapshot);
      emit(snapshot);

      const completion = (async (): Promise<SessionSnapshot> => {
        const rollingThroughput = new RollingThroughput();
        rollingThroughput.record(Date.parse(startedAt), 0);
        const prepared = await prepare(
          sourcePath,
          destinationPath,
          signal,
          startedAt,
          detected,
          includedCaptureDays,
        );
        if (sourceDecision?.action === 'existing') {
          if (
            !prepared.identity.matches.some((match) => match.sourceId === sourceDecision.sourceId)
          ) {
            throw new Error('Selected source identity is not a current reconciliation candidate.');
          }
          prepared.sourceId = sourceDecision.sourceId;
        } else if (sourceDecision?.action === 'new') {
          prepared.sourceId = id();
        }
        publish({ sourceId: prepared.sourceId });
        // Best-effort: guarantee an on-card identity marker exists by the time an ingest starts,
        // even for a card that was ingested directly without ever going through the "name it as
        // soon as it's detected" flow (`registerDetectedSource`) — e.g. a first-time card, or one
        // named before this feature existed. Refreshing here also keeps the marker's nickname in
        // sync if it was changed via `setSourceNickname` since the marker was last written.
        const cardNickname = repositories.sources.findById(prepared.sourceId)?.nickname ?? null;
        await upsertSourceIdentityMarker(
          prepared.sourcePath,
          prepared.sourceId,
          cardNickname,
          `ingest-started sessionId=${sessionId}`,
        );
        const ingestSettings = repositories.settings.get('appSettings') ?? defaultAppSettings;
        if (ingestSettings.perCardEventLog) {
          const cardIdentifier =
            repositories.sources.findById(prepared.sourceId)?.nickname ?? prepared.sourceId;
          activeTextSink = combineLogSinks(
            baseTextSink,
            createCardEventLogSink(
              { mkdir: (value, opts) => mkdir(value, opts), appendFile },
              prepared.destinationPath,
              cardIdentifier,
            ),
          );
        }
        options.database
          .prepare(
            `INSERT INTO session_recovery_context
              (session_id, destination_root, source_strong_id, source_fingerprint,
               source_algorithm_version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
               destination_root = excluded.destination_root,
               source_strong_id = excluded.source_strong_id,
               source_fingerprint = excluded.source_fingerprint,
               source_algorithm_version = excluded.source_algorithm_version,
               updated_at = excluded.updated_at`,
          )
          .run(
            sessionId,
            prepared.destinationPath,
            prepared.identity.identity.platformVolumeId ?? null,
            prepared.identity.identity.fallback.fingerprint,
            String(prepared.identity.identity.fallback.algorithmVersion),
            startedAt,
            now(),
          );
        publish({
          status: 'analyzing',
          phase: 'Analyzing',
          totalFiles: prepared.files.length,
          newFiles: [...prepared.classifications.values()].filter(
            (classification) => classification.decision === 'New',
          ).length,
          totalBytes: prepared.files.reduce((sum, file) => sum + file.sizeBytes, 0),
        });
        const richFiles = new Map(prepared.files.map((file) => [file.relativePath, file]));
        const quickByPath = new Map(
          prepared.files.map((file) => [
            file.relativePath,
            quickFingerprintWithFallback(file, startedAt),
          ]),
        );
        const fileNameById = new Map<string, string>();
        const onProgress = (event: RunIngestProgressEvent): void => {
          const update: Partial<SessionSnapshot> = {};
          if (event.type === 'session-status') {
            update.status = event.status;
            update.phase = phaseFor(event.status);
          } else if (event.type === 'file-status') {
            if (event.status === 'copying') update.currentFile = fileNameById.get(event.fileId);
            if (event.status === 'skipped') update.skippedFiles = snapshot.skippedFiles + 1;
            if (event.status === 'failed') update.failedFiles = snapshot.failedFiles + 1;
          } else if (event.type === 'file-completed') {
            update.completedFiles = snapshot.completedFiles + 1;
            update.verifiedFiles = (snapshot.verifiedFiles ?? snapshot.completedFiles) + 1;
            update.completedBytes = snapshot.completedBytes + event.bytes;
            rollingThroughput.record(Date.parse(event.occurredAt), update.completedBytes);
            update.throughputBytesPerSecond = rollingThroughput.bytesPerSecond();
          } else {
            update.failedFiles = snapshot.failedFiles + 1;
            update.errors = [
              ...snapshot.errors,
              {
                code: 'DESTINATION_COLLISION',
                message: 'A destination file appeared during ingest.',
                filename: fileNameById.get(event.fileId),
              },
            ];
          }
          publish(update);
        };

        const result = await runIngest(
          {
            sourceRoot: prepared.sourcePath,
            destinationRoot: prepared.destinationPath,
            sourceLabel: prepared.sourceFacts.label,
            precreatedSessionId: sessionId,
          },
          {
            signal,
            copyConcurrency: (repositories.settings.get('appSettings') ?? defaultAppSettings)
              .copyConcurrency,
            ids: {
              source: () => prepared.sourceId,
              session: () => sessionId,
              file: (file) => {
                const fileId = id();
                fileNameById.set(fileId, path.basename(file.relativePath));
                return fileId;
              },
            },
            identifySource: async () => ({
              kind:
                sourceDecision?.action === 'new' || prepared.identity.matches.length === 0
                  ? 'new'
                  : 'existing',
              sourceId: prepared.sourceId,
            }),
            upsertSource: async (source) => {
              const existing = repositories.sources.findById(source.id);
              if (existing === undefined) {
                repositories.sources.create({
                  id: source.id,
                  kind:
                    prepared.identity.identity.platformVolumeId === undefined
                      ? 'folder'
                      : 'removable-volume',
                  displayName: source.displayName,
                  firstSeenAt: source.seenAt,
                  lastSeenAt: source.seenAt,
                  createdAt: source.seenAt,
                  updatedAt: source.seenAt,
                });
              } else {
                repositories.sources.updateLastSeen(source.id, source.seenAt);
              }
              const match = prepared.identity.matches.find(
                (candidate) => candidate.sourceId === source.id,
              );
              repositories.identityObservations.confirm({
                observation: {
                  id: id(),
                  sourceId: source.id,
                  observedAt: source.seenAt,
                  algorithmVersion: prepared.identity.identity.fallback.algorithmVersion,
                  fingerprint: prepared.identity.identity.fallback.fingerprint,
                  rawFacts: prepared.identity.identity.fallback.normalizedFacts,
                  confidence: match?.confidence ?? 'medium',
                  strongPlatformId: prepared.identity.identity.platformVolumeId ?? null,
                  createdAt: source.seenAt,
                  updatedAt: source.seenAt,
                },
                decision: {
                  id: id(),
                  detectedKey:
                    prepared.identity.identity.platformVolumeId ??
                    prepared.identity.identity.fallback.fingerprint,
                  kind:
                    sourceDecision?.action === 'existing'
                      ? 'confirmed-existing'
                      : sourceDecision?.action === 'new'
                        ? 'created-new'
                        : match?.confidence === 'exact'
                          ? 'auto-strong'
                          : 'created-new',
                  reasons:
                    sourceDecision?.action === 'new'
                      ? ['new-source-confirmed']
                      : (match?.reasons ?? ['new-source-confirmed']),
                  decidedAt: source.seenAt,
                },
              });
            },
            createSession: async (session) => {
              repositories.sessions.create({
                ...session,
                completedAt: null,
                errorCode: null,
                errorMessage: null,
                createdAt: session.startedAt,
                updatedAt: session.startedAt,
              });
            },
            adoptSessionSource: async (value, sourceId, at) => {
              repositories.sessions.adoptSource(value, sourceId, at);
            },
            updateSession: async (value, status, at, failure) => {
              repositories.sessions.updateStatus(value, {
                status,
                completedAt: ['completed', 'cancelled', 'failed'].includes(status) ? at : null,
                errorCode: failure?.code ?? null,
                errorMessage: failure?.message ?? null,
                updatedAt: at,
              });
            },
            async *scan() {
              for (const file of prepared.files) {
                if (signal.aborted) throw new DOMException('Ingest cancelled', 'AbortError');
                yield {
                  relativePath: file.relativePath,
                  pathSegments: file.pathSegments,
                  sizeBytes: file.sizeBytes,
                  modifiedAt: file.modifiedAt,
                };
              }
            },
            classify: async (file) => {
              const classification = prepared.classifications.get(file.relativePath);
              if (classification === undefined) throw new Error('Missing classification');
              return {
                decision: classification.decision.toLowerCase() as
                  'new' | 'known' | 'ambiguous' | 'recoverable',
                verifiedCopy: classification.decision === 'Known',
              };
            },
            metadata: async (file) => {
              const metadata = prepared.metadata.get(file.relativePath);
              if (metadata === undefined) throw new Error('Missing normalized metadata');
              return metadata;
            },
            persistSourceFile: async (file, classification) => {
              const rich = richFiles.get(file.relativePath);
              if (rich === undefined) throw new Error('Missing scanned file');
              repositories.sourceFiles.recordVersion({
                id: file.id,
                sourceId: file.sourceId,
                ingestSessionId: file.sessionId,
                versionKey: `${quickByPath.get(file.relativePath) ?? file.id}:${file.sessionId}`,
                relativePath: file.relativePath,
                name: path.basename(file.relativePath),
                extension: rich.extension,
                sizeBytes: file.sizeBytes,
                modifiedAt: file.modifiedAt,
                kind:
                  file.mediaType === 'photo'
                    ? 'image'
                    : file.mediaType === 'video'
                      ? 'video'
                      : mediaKind(rich.extension),
                status: classification.decision === 'known' ? 'skipped' : 'ready',
                quickChecksum: quickByPath.get(file.relativePath) ?? null,
                fullChecksum: null,
                captureAt: file.captureAt,
                captureAtSource: file.captureAtSource,
                captureAtRaw: file.captureAtRaw,
                captureTimezoneKind: file.captureTimezoneKind,
                captureOffsetMinutes: file.captureOffsetMinutes,
                captureOffsetSource: file.captureOffsetSource,
                captureOffsetRaw: file.captureOffsetRaw,
                captureDay: file.captureDay,
                cameraMake: file.cameraMake,
                cameraModel: file.cameraModel,
                lensModel: file.lensModel,
                mimeType: file.mimeType,
                mediaType: file.mediaType,
                width: file.width,
                height: file.height,
                durationSeconds: file.durationSeconds,
                gpsPresent: file.gpsPresent,
                lastSeenAt: now(),
                createdAt: now(),
                updatedAt: now(),
              });
              return { id: file.id };
            },
            plan: async (file) => {
              const planSettings = repositories.settings.get('appSettings') ?? defaultAppSettings;
              const nickname = planSettings.groupByNicknameInDestination
                ? (repositories.sources.findById(prepared.sourceId)?.nickname ?? undefined)
                : undefined;
              const planned = await planDestination(
                {
                  root: prepared.destinationPath,
                  captureDate: file.captureAt,
                  captureDay: file.captureDay,
                  sourceLabelOrCamera: prepared.sourceFacts.label,
                  originalFilename: path.basename(file.relativePath),
                  checksum: quickByPath.get(file.relativePath) ?? file.id,
                  template: planSettings.destinationTemplate,
                  ...(nickname === undefined ? {} : { nickname }),
                },
                {
                  inspect: async (destination) => {
                    const existing = repositories.copiedFiles.findByDestination(destination);
                    return existing === undefined
                      ? { exists: false }
                      : {
                          exists: true,
                          ...(existing.status === 'verified' && existing.checksum !== null
                            ? { verifiedChecksum: existing.checksum }
                            : {}),
                        };
                  },
                },
                nodeDestinationFileSystem,
              );
              return { destinationPath: planned.destinationPath };
            },
            copy: async (file) => {
              const rich = richFiles.get(file.relativePath);
              if (rich === undefined) throw new Error('Missing scanned file');
              const copyId = id();
              const currentSourceFacts = await nodeTransferFileSystem.stat(file.sourcePath);
              const result = await copyAndVerify(
                {
                  id: copyId,
                  sessionId,
                  sourcePath: file.sourcePath,
                  destinationRoot: prepared.destinationPath,
                  destinationPath: file.destinationPath,
                  expectedBytes: file.sizeBytes,
                  expectedSource: {
                    sizeBytes: currentSourceFacts.sizeBytes,
                    modifiedAtMs: currentSourceFacts.modifiedAtMs,
                    ...(currentSourceFacts.fileId === undefined
                      ? {}
                      : { fileId: currentSourceFacts.fileId }),
                  },
                },
                {
                  fileSystem: nodeTransferFileSystem,
                  lifecycle: {
                    plan: async (job, at) => {
                      repositories.copiedFiles.plan({
                        id: job.id,
                        sourceFileId: file.id,
                        ingestSessionId: sessionId,
                        destinationPath: job.destinationPath,
                        status: 'planned',
                        expectedBytes: job.expectedBytes,
                        copiedBytes: 0,
                        checksum: null,
                        startedAt: null,
                        verifiedAt: null,
                        errorCode: null,
                        errorMessage: null,
                        createdAt: at,
                        updatedAt: at,
                      });
                    },
                    markStarted: async (value, at) =>
                      repositories.copiedFiles.markStarted(value, at),
                    updateProgress: async (value, bytes, at) =>
                      repositories.copiedFiles.updateProgress(value, bytes, at),
                    markVerified: async (value, bytes, checksum, at) => {
                      repositories.copiedFiles.markVerified(value, bytes, checksum, at);
                      const thumbnail = thumbnailService
                        .enqueue({
                          copyId: value,
                          sourceFileId: file.id,
                          destinationPath: file.destinationPath,
                          destinationChecksum: checksum,
                          copyStatus: 'verified',
                          mediaType: file.mediaType,
                          extension: rich.extension,
                          durationSeconds: file.durationSeconds,
                          signal,
                        })
                        .catch(() => undefined);
                      const trackedThumbnail = thumbnail.finally(() =>
                        operations.delete(trackedThumbnail),
                      );
                      operations.add(trackedThumbnail);
                    },
                    markFailed: async (value, code, message, at) =>
                      repositories.copiedFiles.markFailed(value, code, message, at),
                  },
                  signal,
                },
              );
              return result.status === 'collision'
                ? { status: 'collision', destinationPath: result.destinationPath }
                : {
                    status: 'completed',
                    bytesCopied: result.bytesCopied,
                    checksum: result.checksum,
                  };
            },
            markFileFailed: async (fileId, code, message, at) =>
              repositories.sourceFiles.updateStatus(fileId, 'failed', at, code, message),
            snapshotManifest: async () => writer.snapshot(),
            emit: onProgress,
            log: async (event) =>
              logger.log({
                level:
                  event.errorCode === undefined
                    ? 'info'
                    : event.errorCode === 'METADATA_WARNING'
                      ? 'warn'
                      : 'error',
                ...event,
              }),
            joinSourcePath: (root, segments) => path.join(root, ...segments),
          },
        );
        if (result.completedFiles > 0) {
          const bytesPerSecond = rollingThroughput.bytesPerSecond();
          if (bytesPerSecond > 0) {
            repositories.throughputStats.recordSample(prepared.sourceId, bytesPerSecond, now());
          }
        }
        publish({
          status: result.status,
          phase: phaseFor(result.status),
          completedFiles: result.completedFiles,
          skippedFiles: result.skippedFiles,
          failedFiles: result.failedFiles + result.collisions,
          currentFile: undefined,
        });
        return snapshot;
      })().catch(async (error: unknown) => {
        const cancelled =
          signal.aborted ||
          (error instanceof DOMException && error.name === 'AbortError') ||
          (error instanceof Error && error.name === 'AbortError');
        const nativeCode = nestedErrorCode(error);
        const code = cancelled
          ? 'INGEST_CANCELLED'
          : nativeCode === 'ENOENT' || nativeCode === 'ENODEV'
            ? 'SOURCE_UNAVAILABLE'
            : nativeCode === 'DESTINATION_INVALID' || nativeCode === 'EACCES'
              ? 'DESTINATION_INVALID'
              : 'INGEST_FAILED';
        const message = cancelled
          ? 'Ingest cancelled. You can return home or choose the folders again.'
          : code === 'SOURCE_UNAVAILABLE'
            ? 'The selected source is no longer available.'
            : code === 'DESTINATION_INVALID'
              ? 'The selected destination is not writable.'
              : 'The ingest could not be completed.';
        try {
          repositories.sessions.updateStatus(sessionId, {
            status: cancelled ? 'cancelled' : 'failed',
            completedAt: now(),
            errorCode: code,
            errorMessage: message,
            updatedAt: now(),
          });
        } catch {
          // runIngest may already have persisted a terminal state.
        }
        publish({
          status: cancelled ? 'cancelled' : 'failed',
          phase: cancelled ? 'Cancelled' : 'Failed',
          errors: [...snapshot.errors, { code, message }],
        });
        await logger.log({
          level: cancelled ? 'info' : 'error',
          phase: 'preparation',
          message,
          errorCode: code,
        });
        await writer.snapshot();
        return snapshot;
      });
      const tracked = completion.finally(() => operations.delete(tracked));
      operations.add(tracked);
      return { sessionId, completion: tracked };
    },

    getSession(sessionId) {
      return snapshots.get(sessionId) ?? durableSnapshot(sessionId);
    },

    listRecoverableSessions() {
      const rows = options.database
        .prepare(
          `SELECT id FROM ingest_sessions
            WHERE status IN ('discovering', 'analyzing', 'ready', 'copying', 'verifying')
            ORDER BY started_at DESC, id`,
        )
        .all() as Array<{ id: string }>;
      return rows
        .map((row) => durableSnapshot(row.id))
        .filter((session): session is SessionSnapshot => session !== undefined);
    },

    async recoverSession(sessionId, sourcePath, action, signal, emit, confirmSourceMismatch) {
      const durable = repositories.sessions.findById(sessionId);
      if (
        durable === undefined ||
        !['discovering', 'analyzing', 'ready', 'copying', 'verifying'].includes(durable.status)
      ) {
        throw Object.assign(new Error('Session is not in a recoverable state.'), {
          code: durable === undefined ? 'SESSION_NOT_FOUND' : 'INVALID_REQUEST',
        });
      }
      if (sourcePath !== undefined) {
        await reconcileRecoverySource(
          sessionId,
          sourcePath,
          confirmSourceMismatch ?? false,
          signal,
        );
      }
      try {
        if (action === 'cleanup') {
          await coordinator().cleanup(sessionId, signal);
          return undefined;
        }
        const startedAt = now();
        options.database
          .prepare(
            `UPDATE ingest_sessions
                SET status = 'copying', completed_at = NULL,
                    error_code = NULL, error_message = NULL, updated_at = ?
              WHERE id = ?`,
          )
          .run(startedAt, sessionId);
        const before = durableSnapshot(sessionId);
        if (before !== undefined) emit(before);
        const result = await coordinator().resume(sessionId, signal);
        const snapshot = durableSnapshot(sessionId);
        if (snapshot === undefined) return undefined;
        const projected =
          result.status === 'paused'
            ? {
                ...snapshot,
                phase: 'Waiting for source',
                errors: [
                  ...snapshot.errors,
                  {
                    code: 'SOURCE_UNAVAILABLE',
                    message: 'Reconnect the source or choose its folder to continue.',
                  },
                ],
              }
            : snapshot;
        snapshots.set(sessionId, projected);
        emit(projected);
        return projected;
      } finally {
        recoverySources.delete(sessionId);
      }
    },

    listSummaryDays(request: ListSummaryDaysRequest): SummaryDay[] {
      return repositories.summaries.listDays(request);
    },

    subscribeSummary(listener: () => void): () => void {
      summaryListeners.add(listener);
      return () => summaryListeners.delete(listener);
    },

    listSummaryMedia(request: ListSummaryMediaRequest) {
      const result = repositories.summaries.listMediaByDay(request);
      for (const item of result.items
        .filter(
          (candidate) =>
            candidate.thumbnail.state === 'missing' ||
            (candidate.thumbnail.state === 'failed' &&
              candidate.thumbnail.attemptCount < candidate.thumbnail.maxAttempts &&
              (candidate.thumbnail.nextRetryAt === null ||
                candidate.thumbnail.nextRetryAt <= now())),
        )
        .slice(0, 8)) {
        const copy = repositories.copiedFiles.findById(item.copyId);
        const source = repositories.sourceFiles.findById(item.id);
        if (copy?.checksum === null || copy === undefined || source === undefined) continue;
        const operation = thumbnailService
          .enqueue({
            copyId: copy.id,
            sourceFileId: source.id,
            destinationPath: copy.destinationPath,
            destinationChecksum: copy.checksum,
            copyStatus: 'verified',
            mediaType: source.mediaType ?? 'unknown',
            extension: source.extension,
            durationSeconds: source.durationSeconds,
          })
          .catch(() => undefined);
        const tracked = operation.finally(() => operations.delete(tracked));
        operations.add(tracked);
      }
      return {
        nextCursor: result.nextCursor,
        items: result.items.map((item) => ({
          ...item,
          thumbnail:
            item.thumbnail.state !== 'ready'
              ? item.thumbnail
              : item.thumbnail.mimeType === 'image/webp' || item.thumbnail.mimeType === 'image/jpeg'
                ? {
                    state: 'ready' as const,
                    reference: item.thumbnail.reference,
                    mimeType: item.thumbnail.mimeType,
                    width: item.thumbnail.width,
                    height: item.thumbnail.height,
                  }
                : { state: 'missing' as const },
        })),
      };
    },

    retryThumbnail(copyId: string, variant: 'grid'): boolean {
      const copy = repositories.copiedFiles.findById(copyId);
      const source =
        copy === undefined ? undefined : repositories.sourceFiles.findById(copy.sourceFileId);
      const retry = repositories.thumbnails.retryState(copyId, variant);
      if (
        copy?.status !== 'verified' ||
        copy.checksum === null ||
        source === undefined ||
        retry === undefined ||
        retry.attemptCount >= retry.maxAttempts
      ) {
        return false;
      }
      const operation = thumbnailService
        .enqueue({
          copyId: copy.id,
          sourceFileId: source.id,
          destinationPath: copy.destinationPath,
          destinationChecksum: copy.checksum,
          copyStatus: 'verified',
          mediaType: source.mediaType ?? 'unknown',
          extension: source.extension,
          durationSeconds: source.durationSeconds,
          retryOverride: true,
        })
        .catch(() => undefined);
      const tracked = operation.finally(() => operations.delete(tracked));
      operations.add(tracked);
      return true;
    },

    async readThumbnail(reference: string): Promise<{ mimeType: string; bytes: Uint8Array }> {
      const thumbnail = repositories.thumbnails.findById(reference);
      if (thumbnail === undefined || thumbnail.sizeBytes > 5 * 1024 * 1024) {
        throw new Error('Thumbnail unavailable');
      }
      const bytes = await readFile(thumbnail.cachePath);
      if (bytes.length !== thumbnail.sizeBytes) throw new Error('Thumbnail cache is stale');
      return { mimeType: thumbnail.mimeType, bytes };
    },

    close() {
      closing ??= (async () => {
        await metadataClient.close();
        await Promise.allSettled([...operations]);
        await thumbnailService.close();
        metadataCache.clear();
        summaryListeners.clear();
      })();
      return closing;
    },
  };
}

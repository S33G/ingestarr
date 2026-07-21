import type Database from 'better-sqlite3';
import { appSettingsSchema, parseStoredAppSettings } from '@ingestarr/shared-types';
import type { AppSettings } from '@ingestarr/shared-types';

import { fromSqliteInteger, toSqliteInteger } from './integers.js';
import type {
  CopiedFileRecord,
  IdentityObservationRecord,
  IngestSessionRecord,
  NewCopiedFileRecord,
  NewSourceFileRecord,
  SessionStatusUpdate,
  SourceFileMatch,
  SourceFileRecord,
  SourceRecord,
  SourceThroughputStatsRecord,
  SummaryDayRecord,
  SummaryMediaRecord,
  ThumbnailFailureRecord,
  ThumbnailRecord,
} from './models.js';

type Integer = bigint | number;
type SourceFileRow = Omit<
  SourceFileRecord,
  'sizeBytes' | 'captureOffsetMinutes' | 'width' | 'height' | 'gpsPresent'
> & {
  sizeBytes: Integer;
  captureOffsetMinutes: Integer | null;
  width: Integer | null;
  height: Integer | null;
  gpsPresent: Integer;
};
interface SettingValues {
  appSettings: AppSettings;
}
export interface SummaryFilters {
  sourceId?: string;
  sessionId?: string;
  mediaType?: 'photo' | 'video' | 'unknown';
}
type SettingKey = keyof SettingValues;

function assertRelativeSourcePath(path: string): void {
  if (/^(?:[\\/]|[A-Za-z]:[\\/])/.test(path)) {
    throw new Error(`Expected a relative path, received absolute source path: ${path}`);
  }
}

const sourceColumns = `
  id, kind, display_name AS displayName, nickname, first_seen_at AS firstSeenAt,
  last_seen_at AS lastSeenAt, created_at AS createdAt, updated_at AS updatedAt
`;
const throughputStatsColumns = `
  source_id AS sourceId, sample_count AS sampleCount,
  average_bytes_per_second AS averageBytesPerSecond,
  last_bytes_per_second AS lastBytesPerSecond, updated_at AS updatedAt
`;
export type NewSourceRecord = Omit<SourceRecord, 'nickname'> & { nickname?: string | null };
const sessionColumns = `
  id, source_id AS sourceId, status, started_at AS startedAt, completed_at AS completedAt,
  error_code AS errorCode, error_message AS errorMessage,
  created_at AS createdAt, updated_at AS updatedAt
`;
const sourceFileColumns = `
  id, source_id AS sourceId, ingest_session_id AS ingestSessionId, version_key AS versionKey,
  relative_path AS relativePath, name, extension, size_bytes AS sizeBytes,
  modified_at AS modifiedAt, kind, status, quick_checksum AS quickChecksum,
  full_checksum AS fullChecksum, capture_at AS captureAt,
  capture_at_source AS captureAtSource, capture_at_raw AS captureAtRaw,
  capture_timezone_kind AS captureTimezoneKind,
  capture_offset_minutes AS captureOffsetMinutes,
  capture_offset_source AS captureOffsetSource, capture_offset_raw AS captureOffsetRaw,
  capture_day AS captureDay,
  camera_make AS cameraMake, camera_model AS cameraModel, lens_model AS lensModel,
  mime_type AS mimeType, media_type AS mediaType, width, height,
  duration_seconds AS durationSeconds, gps_present AS gpsPresent,
  last_seen_at AS lastSeenAt,
  error_code AS errorCode, error_message AS errorMessage,
  created_at AS createdAt, updated_at AS updatedAt
`;
const copiedFileColumns = `
  id, source_id AS sourceId, source_file_id AS sourceFileId,
  ingest_session_id AS ingestSessionId,
  destination_path AS destinationPath, status, expected_bytes AS expectedBytes,
  copied_bytes AS copiedBytes, checksum, started_at AS startedAt,
  last_progress_at AS lastProgressAt, failed_at AS failedAt,
  recovery_started_at AS recoveryStartedAt, verified_at AS verifiedAt,
  error_code AS errorCode, error_message AS errorMessage,
  created_at AS createdAt, updated_at AS updatedAt
`;
const sessionTransitions: Record<
  IngestSessionRecord['status'],
  readonly IngestSessionRecord['status'][]
> = {
  discovering: ['analyzing', 'cancelled', 'failed'],
  analyzing: ['ready', 'cancelled', 'failed'],
  ready: ['copying', 'cancelled', 'failed'],
  copying: ['verifying', 'cancelled', 'failed'],
  verifying: ['completed', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
};
const thumbnailColumns = `
  association.id, association.source_file_id AS sourceFileId, association.variant,
  artifact.cache_path AS cachePath, artifact.mime_type AS mimeType,
  artifact.width, artifact.height, artifact.size_bytes AS sizeBytes,
  association.created_at AS createdAt, association.updated_at AS updatedAt
`;

function sourceFileFromRow(row: SourceFileRow | undefined): SourceFileRecord | undefined {
  return row === undefined
    ? undefined
    : {
        ...row,
        sizeBytes: fromSqliteInteger(row.sizeBytes),
        captureOffsetMinutes:
          row.captureOffsetMinutes === null ? null : Number(row.captureOffsetMinutes),
        width: row.width === null ? null : fromSqliteInteger(row.width),
        height: row.height === null ? null : fromSqliteInteger(row.height),
        gpsPresent: row.gpsPresent === 1n || row.gpsPresent === 1,
      };
}

function copiedFileFromRow(
  row:
    | (Omit<CopiedFileRecord, 'expectedBytes' | 'copiedBytes'> & {
        expectedBytes: Integer;
        copiedBytes: Integer;
      })
    | undefined,
): CopiedFileRecord | undefined {
  return row === undefined
    ? undefined
    : {
        ...row,
        expectedBytes: fromSqliteInteger(row.expectedBytes),
        copiedBytes: fromSqliteInteger(row.copiedBytes),
      };
}

function thumbnailFromRow(
  row:
    | (Omit<ThumbnailRecord, 'width' | 'height' | 'sizeBytes'> & {
        width: Integer;
        height: Integer;
        sizeBytes: Integer;
      })
    | undefined,
): ThumbnailRecord | undefined {
  return row === undefined
    ? undefined
    : {
        ...row,
        width: fromSqliteInteger(row.width),
        height: fromSqliteInteger(row.height),
        sizeBytes: fromSqliteInteger(row.sizeBytes),
      };
}

export function createRepositories(database: Database.Database) {
  const sources = {
    create(source: NewSourceRecord): SourceRecord {
      const nickname = source.nickname ?? null;
      database
        .prepare(
          `INSERT INTO sources
            (id, kind, display_name, nickname, first_seen_at, last_seen_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          source.id,
          source.kind,
          source.displayName,
          nickname,
          source.firstSeenAt,
          source.lastSeenAt,
          source.createdAt,
          source.updatedAt,
        );
      return { ...source, nickname };
    },

    findById(id: string): SourceRecord | undefined {
      return database.prepare(`SELECT ${sourceColumns} FROM sources WHERE id = ?`).get(id) as
        SourceRecord | undefined;
    },

    updateLastSeen(id: string, lastSeenAt: string): void {
      database
        .prepare('UPDATE sources SET last_seen_at = ?, updated_at = ? WHERE id = ?')
        .run(lastSeenAt, lastSeenAt, id);
    },

    /**
     * Sets or clears (nickname = null) the user-assigned kebab-case nickname.
     * Kebab-case shape is validated by the caller's Zod schema; the CHECK
     * constraint on the column is a defense-in-depth backstop only.
     */
    setNickname(id: string, nickname: string | null, updatedAt: string): SourceRecord {
      const result = database
        .prepare('UPDATE sources SET nickname = ?, updated_at = ? WHERE id = ?')
        .run(nickname, updatedAt, id);
      if (result.changes === 0) throw new Error(`Source ${id} does not exist`);
      return sources.findById(id) as SourceRecord;
    },

    /**
     * Known sources that have at least one identity observation but have never had a strong
     * platform volume id confirmed for them (i.e. sources only ever identified via the fallback
     * fingerprint heuristic). These are the sources a newly detected volume with no matching
     * strong id could plausibly already be — useful for surfacing "this might already be known
     * as …" hints before blindly registering a duplicate row.
     */
    listWithoutStrongPlatformId(): SourceRecord[] {
      return database
        .prepare(
          `SELECT ${sourceColumns} FROM sources source
            WHERE source.display_name <> 'Pending source'
              AND EXISTS (
                SELECT 1 FROM source_identity_observations observation
                 WHERE observation.source_id = source.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM source_identity_observations observation
                 WHERE observation.source_id = source.id
                   AND observation.strong_platform_id IS NOT NULL
              )
            ORDER BY source.id`,
        )
        .all() as SourceRecord[];
    },
  };

  const throughputStats = {
    /**
     * Records one completed-session throughput sample and returns the
     * updated running statistics. See `evaluateThroughput` in
     * `@ingestarr/ingest-core` for how these feed the "slow card" heuristic.
     */
    recordSample(
      sourceId: string,
      bytesPerSecond: number,
      updatedAt: string,
    ): SourceThroughputStatsRecord {
      return database.transaction(() => {
        const existing = database
          .prepare(
            `SELECT ${throughputStatsColumns} FROM source_throughput_stats WHERE source_id = ?`,
          )
          .get(sourceId) as
          (Omit<SourceThroughputStatsRecord, 'sampleCount'> & { sampleCount: Integer }) | undefined;
        const priorCount = existing === undefined ? 0 : fromSqliteInteger(existing.sampleCount);
        const priorAverage = existing?.averageBytesPerSecond ?? 0;
        const sampleCount = priorCount + 1;
        const averageBytesPerSecond = priorAverage + (bytesPerSecond - priorAverage) / sampleCount;
        database
          .prepare(
            `INSERT INTO source_throughput_stats
              (source_id, sample_count, average_bytes_per_second, last_bytes_per_second, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(source_id) DO UPDATE SET
               sample_count = excluded.sample_count,
               average_bytes_per_second = excluded.average_bytes_per_second,
               last_bytes_per_second = excluded.last_bytes_per_second,
               updated_at = excluded.updated_at`,
          )
          .run(
            sourceId,
            toSqliteInteger(sampleCount),
            averageBytesPerSecond,
            bytesPerSecond,
            updatedAt,
          );
        return {
          sourceId,
          sampleCount,
          averageBytesPerSecond,
          lastBytesPerSecond: bytesPerSecond,
          updatedAt,
        };
      })();
    },

    findForSource(sourceId: string): SourceThroughputStatsRecord | undefined {
      const row = database
        .prepare(
          `SELECT ${throughputStatsColumns} FROM source_throughput_stats WHERE source_id = ?`,
        )
        .get(sourceId) as
        (Omit<SourceThroughputStatsRecord, 'sampleCount'> & { sampleCount: Integer }) | undefined;
      return row === undefined
        ? undefined
        : { ...row, sampleCount: fromSqliteInteger(row.sampleCount) };
    },
  };

  const insertIdentityObservation = (
    observation: IdentityObservationRecord,
  ): IdentityObservationRecord => {
    database
      .prepare(
        `INSERT INTO source_identity_observations
            (id, source_id, observed_at, algorithm_version, fingerprint, raw_facts_json,
             confidence, strong_platform_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        observation.id,
        observation.sourceId,
        observation.observedAt,
        toSqliteInteger(observation.algorithmVersion),
        observation.fingerprint,
        JSON.stringify(observation.rawFacts),
        observation.confidence,
        observation.strongPlatformId,
        observation.createdAt,
        observation.updatedAt,
      );
    return observation;
  };

  const identityObservations = {
    create(observation: IdentityObservationRecord): IdentityObservationRecord {
      return insertIdentityObservation(observation);
    },

    confirm(input: {
      observation: IdentityObservationRecord;
      decision: {
        id: string;
        detectedKey: string;
        kind: 'auto-strong' | 'confirmed-existing' | 'created-new';
        reasons: string[];
        decidedAt: string;
      };
    }): IdentityObservationRecord {
      return database.transaction(() => {
        const observation = insertIdentityObservation(input.observation);
        database
          .prepare(
            `INSERT INTO source_identity_aliases
              (source_id, algorithm_version, fingerprint, first_observed_at, last_observed_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(source_id, algorithm_version, fingerprint) DO UPDATE SET
               last_observed_at = excluded.last_observed_at`,
          )
          .run(
            observation.sourceId,
            toSqliteInteger(observation.algorithmVersion),
            observation.fingerprint,
            observation.observedAt,
            observation.observedAt,
          );
        database
          .prepare(
            `INSERT INTO source_reconciliation_audit
              (id, source_id, detected_key, decision_kind, reasons_json, decided_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.decision.id,
            observation.sourceId,
            input.decision.detectedKey,
            input.decision.kind,
            JSON.stringify(input.decision.reasons),
            input.decision.decidedAt,
          );
        sources.updateLastSeen(observation.sourceId, observation.observedAt);
        return observation;
      })();
    },

    listAliases(sourceId: string): Array<{
      algorithmVersion: number;
      fingerprint: string;
      firstObservedAt: string;
      lastObservedAt: string;
    }> {
      const rows = database
        .prepare(
          `SELECT algorithm_version AS algorithmVersion, fingerprint,
                  first_observed_at AS firstObservedAt, last_observed_at AS lastObservedAt
             FROM source_identity_aliases
            WHERE source_id = ?
            ORDER BY algorithm_version, fingerprint`,
        )
        .all(sourceId) as Array<{
        algorithmVersion: Integer;
        fingerprint: string;
        firstObservedAt: string;
        lastObservedAt: string;
      }>;
      return rows.map((row) => ({
        ...row,
        algorithmVersion: fromSqliteInteger(row.algorithmVersion),
      }));
    },

    listAudit(sourceId: string): Array<{
      id: string;
      detectedKey: string;
      kind: 'auto-strong' | 'confirmed-existing' | 'created-new';
      reasons: string[];
      decidedAt: string;
    }> {
      const rows = database
        .prepare(
          `SELECT id, detected_key AS detectedKey, decision_kind AS kind,
                  reasons_json AS reasonsJson, decided_at AS decidedAt
             FROM source_reconciliation_audit
            WHERE source_id = ?
            ORDER BY decided_at, id`,
        )
        .all(sourceId) as Array<{
        id: string;
        detectedKey: string;
        kind: 'auto-strong' | 'confirmed-existing' | 'created-new';
        reasonsJson: string;
        decidedAt: string;
      }>;
      return rows.map(({ reasonsJson, ...row }) => ({
        ...row,
        reasons: JSON.parse(reasonsJson) as string[],
      }));
    },

    listForSource(sourceId: string): IdentityObservationRecord[] {
      const rows = database
        .prepare(
          `SELECT id, source_id AS sourceId, observed_at AS observedAt,
                  algorithm_version AS algorithmVersion, fingerprint,
                  raw_facts_json AS rawFactsJson, confidence,
                  strong_platform_id AS strongPlatformId,
                  created_at AS createdAt, updated_at AS updatedAt
             FROM source_identity_observations
            WHERE source_id = ?
            ORDER BY observed_at DESC, id`,
        )
        .all(sourceId) as Array<
        Omit<IdentityObservationRecord, 'algorithmVersion' | 'rawFacts'> & {
          algorithmVersion: Integer;
          rawFactsJson: string;
        }
      >;
      return rows.map(({ algorithmVersion, rawFactsJson, ...row }) => ({
        ...row,
        algorithmVersion: fromSqliteInteger(algorithmVersion),
        rawFacts: JSON.parse(rawFactsJson) as unknown,
      }));
    },

    findCandidates(criteria: {
      strongPlatformId?: string;
      fingerprint?: string;
      algorithmVersion?: number;
    }): SourceRecord[] {
      const predicates: string[] = [];
      const parameters: Array<string | bigint> = [];
      if (criteria.strongPlatformId !== undefined) {
        predicates.push('observation.strong_platform_id = ?');
        parameters.push(criteria.strongPlatformId);
      }
      if (criteria.fingerprint !== undefined) {
        predicates.push('(observation.fingerprint = ? AND observation.algorithm_version = ?)');
        parameters.push(criteria.fingerprint, toSqliteInteger(criteria.algorithmVersion ?? 1));
      }
      if (predicates.length === 0) {
        return [];
      }
      return database
        .prepare(
          `SELECT DISTINCT ${sourceColumns
            .split(',')
            .map((column) => `source.${column.trim()}`)
            .join(', ')}
             FROM sources source
             JOIN source_identity_observations observation ON observation.source_id = source.id
            WHERE ${predicates.join(' OR ')}
            ORDER BY source.id`,
        )
        .all(...parameters) as SourceRecord[];
    },
  };

  const sessions = {
    create(session: IngestSessionRecord): IngestSessionRecord {
      database
        .prepare(
          `INSERT INTO ingest_sessions
            (id, source_id, status, started_at, completed_at, error_code, error_message,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.id,
          session.sourceId,
          session.status,
          session.startedAt,
          session.completedAt,
          session.errorCode,
          session.errorMessage,
          session.createdAt,
          session.updatedAt,
        );
      return session;
    },

    findById(id: string): IngestSessionRecord | undefined {
      return database
        .prepare(`SELECT ${sessionColumns} FROM ingest_sessions WHERE id = ?`)
        .get(id) as IngestSessionRecord | undefined;
    },

    listForSource(sourceId: string): IngestSessionRecord[] {
      return database
        .prepare(
          `SELECT ${sessionColumns} FROM ingest_sessions
            WHERE source_id = ? ORDER BY started_at DESC`,
        )
        .all(sourceId) as IngestSessionRecord[];
    },

    findIncomplete(): IngestSessionRecord[] {
      return database
        .prepare(
          `SELECT ${sessionColumns} FROM ingest_sessions
            WHERE status NOT IN ('completed', 'cancelled', 'failed')
            ORDER BY started_at`,
        )
        .all() as IngestSessionRecord[];
    },

    updateStatus(id: string, update: SessionStatusUpdate): void {
      database.transaction(() => {
        const current = database
          .prepare('SELECT status FROM ingest_sessions WHERE id = ?')
          .get(id) as { status: IngestSessionRecord['status'] } | undefined;
        if (current === undefined) throw new Error(`Ingest session ${id} does not exist`);
        if (!sessionTransitions[current.status].includes(update.status)) {
          throw new Error(
            `Invalid ingest-session transition from ${current.status} to ${update.status}`,
          );
        }
        const terminal = ['completed', 'cancelled', 'failed'].includes(update.status);
        if (terminal !== (update.completedAt !== null)) {
          throw new Error('completedAt must be set exactly for terminal ingest-session statuses');
        }
        if (
          ['cancelled', 'failed'].includes(update.status) &&
          (update.errorCode === null ||
            update.errorCode.length === 0 ||
            update.errorMessage === null ||
            update.errorMessage.length === 0)
        ) {
          throw new Error('Failed or cancelled sessions require a stable error code and message');
        }
        if (
          !['cancelled', 'failed'].includes(update.status) &&
          (update.errorCode !== null || update.errorMessage !== null)
        ) {
          throw new Error('Only failed or cancelled sessions may contain error details');
        }
        database
          .prepare(
            `UPDATE ingest_sessions
                SET status = ?, completed_at = ?, error_code = ?, error_message = ?, updated_at = ?
              WHERE id = ?`,
          )
          .run(
            update.status,
            update.completedAt,
            update.errorCode,
            update.errorMessage,
            update.updatedAt,
            id,
          );
      })();
    },

    adoptSource(id: string, sourceId: string, updatedAt: string): void {
      database.transaction(() => {
        const session = database
          .prepare('SELECT source_id AS sourceId, status FROM ingest_sessions WHERE id = ?')
          .get(id) as { sourceId: string; status: IngestSessionRecord['status'] } | undefined;
        if (session === undefined) throw new Error(`Ingest session ${id} does not exist`);
        if (session.status !== 'discovering') {
          throw new Error('Only a discovering ingest session may adopt a source');
        }
        const source = sources.findById(sourceId);
        if (source === undefined) throw new Error(`Source ${sourceId} does not exist`);
        const files = database
          .prepare('SELECT COUNT(*) FROM source_files WHERE ingest_session_id = ?')
          .pluck()
          .get(id) as bigint;
        if (files !== 0n) throw new Error('A session cannot adopt a source after file discovery');
        database
          .prepare('UPDATE ingest_sessions SET source_id = ?, updated_at = ? WHERE id = ?')
          .run(sourceId, updatedAt, id);
        database
          .prepare(
            `DELETE FROM sources
              WHERE id = ?
                AND NOT EXISTS (SELECT 1 FROM ingest_sessions WHERE source_id = sources.id)
                AND NOT EXISTS (
                  SELECT 1 FROM source_identity_observations WHERE source_id = sources.id
                )`,
          )
          .run(session.sourceId);
      })();
    },
  };

  const sourceFiles = {
    recordVersion(file: NewSourceFileRecord): SourceFileRecord {
      assertRelativeSourcePath(file.relativePath);
      const metadata = {
        captureAtSource: file.captureAtSource ?? null,
        captureAtRaw: file.captureAtRaw ?? null,
        captureTimezoneKind: file.captureTimezoneKind ?? null,
        captureOffsetMinutes: file.captureOffsetMinutes ?? null,
        captureOffsetSource: file.captureOffsetSource ?? null,
        captureOffsetRaw: file.captureOffsetRaw ?? null,
        captureDay: file.captureDay ?? null,
        cameraMake: file.cameraMake ?? null,
        cameraModel: file.cameraModel ?? null,
        lensModel: file.lensModel ?? null,
        mimeType: file.mimeType ?? null,
        mediaType: file.mediaType ?? null,
        width: file.width ?? null,
        height: file.height ?? null,
        durationSeconds: file.durationSeconds ?? null,
        gpsPresent: file.gpsPresent ?? false,
      };
      if (typeof metadata.gpsPresent !== 'boolean') {
        throw new Error('gpsPresent must be a boolean');
      }
      if (
        metadata.captureOffsetMinutes !== null &&
        (!Number.isInteger(metadata.captureOffsetMinutes) ||
          metadata.captureOffsetMinutes < -840 ||
          metadata.captureOffsetMinutes > 840)
      ) {
        throw new Error('captureOffsetMinutes must be an integer from -840 through 840');
      }
      if (
        metadata.captureTimezoneKind !== null &&
        !['utc', 'offset', 'floating', 'fallback'].includes(metadata.captureTimezoneKind)
      ) {
        throw new Error('Invalid capture timezone kind');
      }
      if (
        metadata.captureOffsetSource !== null &&
        ![
          'inline',
          'OffsetTimeOriginal',
          'OffsetTimeDigitized',
          'TimeZone',
          'ExifDateTime',
        ].includes(metadata.captureOffsetSource)
      ) {
        throw new Error('Invalid capture offset source');
      }
      if (
        metadata.mediaType !== null &&
        !['photo', 'video', 'unknown'].includes(metadata.mediaType)
      ) {
        throw new Error('Invalid media type');
      }
      database.transaction(() => {
        if (file.ingestSessionId !== null) {
          const session = database
            .prepare('SELECT source_id AS sourceId FROM ingest_sessions WHERE id = ?')
            .get(file.ingestSessionId) as { sourceId: string } | undefined;
          if (session === undefined) {
            throw new Error(`Ingest session ${file.ingestSessionId} does not exist`);
          }
          if (session.sourceId !== file.sourceId) {
            throw new Error('Source file and ingest session must belong to the same source');
          }
        }

        database
          .prepare(
            `INSERT INTO source_files
              (id, source_id, ingest_session_id, version_key, relative_path, name, extension,
               size_bytes, modified_at, kind, status, quick_checksum, full_checksum, capture_at,
               capture_at_source, capture_at_raw, capture_timezone_kind, capture_offset_minutes,
               capture_offset_source, capture_offset_raw, capture_day,
               camera_make, camera_model, lens_model, mime_type, media_type,
               width, height, duration_seconds, gps_present,
               last_seen_at, error_code, error_message, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            file.id,
            file.sourceId,
            file.ingestSessionId,
            file.versionKey,
            file.relativePath,
            file.name,
            file.extension,
            toSqliteInteger(file.sizeBytes),
            file.modifiedAt,
            file.kind,
            file.status,
            file.quickChecksum,
            file.fullChecksum,
            file.captureAt,
            metadata.captureAtSource,
            metadata.captureAtRaw,
            metadata.captureTimezoneKind,
            metadata.captureOffsetMinutes === null ? null : BigInt(metadata.captureOffsetMinutes),
            metadata.captureOffsetSource,
            metadata.captureOffsetRaw,
            metadata.captureDay,
            metadata.cameraMake,
            metadata.cameraModel,
            metadata.lensModel,
            metadata.mimeType,
            metadata.mediaType,
            metadata.width === null ? null : toSqliteInteger(metadata.width),
            metadata.height === null ? null : toSqliteInteger(metadata.height),
            metadata.durationSeconds,
            metadata.gpsPresent ? 1n : 0n,
            file.lastSeenAt,
            file.errorCode ?? null,
            file.errorMessage ?? null,
            file.createdAt,
            file.updatedAt,
          );
      })();
      return {
        ...file,
        ...metadata,
        errorCode: file.errorCode ?? null,
        errorMessage: file.errorMessage ?? null,
      };
    },

    findById(id: string): SourceFileRecord | undefined {
      return sourceFileFromRow(
        database.prepare(`SELECT ${sourceFileColumns} FROM source_files WHERE id = ?`).get(id) as
          SourceFileRow | undefined,
      );
    },

    listVersions(sourceId: string, relativePath: string): SourceFileRecord[] {
      const rows = database
        .prepare(
          `SELECT ${sourceFileColumns} FROM source_files
            WHERE source_id = ? AND relative_path = ?
            ORDER BY created_at, id`,
        )
        .all(sourceId, relativePath) as SourceFileRow[];
      return rows.map((row) => sourceFileFromRow(row) as SourceFileRecord);
    },

    findMatching(match: SourceFileMatch): SourceFileRecord | undefined {
      const checksumPredicate =
        match.fullChecksum !== undefined
          ? ' AND full_checksum IS ?'
          : match.quickChecksum !== undefined
            ? ' AND quick_checksum IS ?'
            : '';
      const parameters: Array<string | bigint | null> = [
        match.sourceId,
        match.relativePath,
        toSqliteInteger(match.sizeBytes),
        match.modifiedAt,
      ];
      if (match.fullChecksum !== undefined) {
        parameters.push(match.fullChecksum);
      } else if (match.quickChecksum !== undefined) {
        parameters.push(match.quickChecksum);
      }
      return sourceFileFromRow(
        database
          .prepare(
            `SELECT ${sourceFileColumns} FROM source_files
              WHERE source_id = ? AND relative_path = ? AND size_bytes = ? AND modified_at = ?
                    ${checksumPredicate}
              ORDER BY created_at DESC LIMIT 1`,
          )
          .get(...parameters) as SourceFileRow | undefined,
      );
    },

    recordObservation(
      id: string,
      observation: {
        quickChecksum: string | null;
        fullChecksum: string | null;
        lastSeenAt: string;
        updatedAt: string;
      },
    ): void {
      database
        .prepare(
          `UPDATE source_files
              SET quick_checksum = ?, full_checksum = ?, last_seen_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          observation.quickChecksum,
          observation.fullChecksum,
          observation.lastSeenAt,
          observation.updatedAt,
          id,
        );
    },

    updateStatus(
      id: string,
      status: SourceFileRecord['status'],
      updatedAt: string,
      errorCode: string | null = null,
      errorMessage: string | null = null,
    ): void {
      database
        .prepare(
          `UPDATE source_files
              SET status = ?, error_code = ?, error_message = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(status, errorCode, errorMessage, updatedAt, id);
    },
  };

  type CopyStateRow = {
    sourceFileId: string;
    status: CopiedFileRecord['status'];
    sourceSize: Integer;
    expectedBytes: Integer;
  };
  const copyState = database.prepare(
    `SELECT copy.source_file_id AS sourceFileId, copy.status,
            source_file.size_bytes AS sourceSize, copy.expected_bytes AS expectedBytes
       FROM copied_files copy
       JOIN source_files source_file ON source_file.id = copy.source_file_id
      WHERE copy.id = ?`,
  );

  function requireCopyState(
    id: string,
    allowedStatuses: CopiedFileRecord['status'][],
  ): CopyStateRow {
    const row = copyState.get(id) as CopyStateRow | undefined;
    if (row === undefined) {
      throw new Error(`Copied file ${id} does not exist`);
    }
    if (!allowedStatuses.includes(row.status)) {
      throw new Error(
        `Invalid copied-file transition from ${row.status}; expected ${allowedStatuses.join(' or ')}`,
      );
    }
    return row;
  }

  const copiedFiles = {
    plan(copy: NewCopiedFileRecord): CopiedFileRecord {
      if (
        copy.status !== 'planned' ||
        copy.copiedBytes !== 0 ||
        copy.checksum !== null ||
        copy.startedAt !== null ||
        copy.verifiedAt !== null ||
        copy.errorCode !== null ||
        copy.errorMessage !== null
      ) {
        throw new Error('A copied file must begin in a clean planned state');
      }

      const sourceId = database.transaction(() => {
        const sourceFile = database
          .prepare(
            'SELECT source_id AS sourceId, size_bytes AS sizeBytes FROM source_files WHERE id = ?',
          )
          .get(copy.sourceFileId) as { sourceId: string; sizeBytes: Integer } | undefined;
        const session = database
          .prepare('SELECT source_id AS sourceId FROM ingest_sessions WHERE id = ?')
          .get(copy.ingestSessionId) as { sourceId: string } | undefined;
        if (sourceFile === undefined || session === undefined) {
          throw new Error('Copied file source file and session must exist');
        }
        if (sourceFile.sourceId !== session.sourceId) {
          throw new Error('Copied file session and source file must belong to the same source');
        }
        if (fromSqliteInteger(sourceFile.sizeBytes) !== copy.expectedBytes) {
          throw new Error('Copied file expected bytes must equal the source size');
        }

        database
          .prepare(
            `INSERT INTO copied_files
              (id, source_id, source_file_id, ingest_session_id, destination_path, status,
               expected_bytes, copied_bytes, checksum, started_at, last_progress_at,
               failed_at, recovery_started_at, verified_at, error_code, error_message,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'planned', ?, 0, NULL, NULL, NULL, NULL, NULL, NULL,
                     NULL, NULL, ?, ?)`,
          )
          .run(
            copy.id,
            sourceFile.sourceId,
            copy.sourceFileId,
            copy.ingestSessionId,
            copy.destinationPath,
            toSqliteInteger(copy.expectedBytes),
            copy.createdAt,
            copy.updatedAt,
          );
        return sourceFile.sourceId;
      })();

      return {
        ...copy,
        sourceId,
        lastProgressAt: null,
        failedAt: null,
        recoveryStartedAt: null,
      };
    },

    findByDestination(destinationPath: string): CopiedFileRecord | undefined {
      return copiedFileFromRow(
        database
          .prepare(`SELECT ${copiedFileColumns} FROM copied_files WHERE destination_path = ?`)
          .get(destinationPath) as
          | (Omit<CopiedFileRecord, 'expectedBytes' | 'copiedBytes'> & {
              expectedBytes: Integer;
              copiedBytes: Integer;
            })
          | undefined,
      );
    },

    findById(id: string): CopiedFileRecord | undefined {
      return copiedFileFromRow(
        database.prepare(`SELECT ${copiedFileColumns} FROM copied_files WHERE id = ?`).get(id) as
          | (Omit<CopiedFileRecord, 'expectedBytes' | 'copiedBytes'> & {
              expectedBytes: Integer;
              copiedBytes: Integer;
            })
          | undefined,
      );
    },

    findVerifiedForSourceFile(sourceFileId: string): CopiedFileRecord | undefined {
      return copiedFileFromRow(
        database
          .prepare(
            `SELECT ${copiedFileColumns} FROM copied_files
              WHERE source_file_id = ? AND status = 'verified'
              ORDER BY verified_at DESC LIMIT 1`,
          )
          .get(sourceFileId) as
          | (Omit<CopiedFileRecord, 'expectedBytes' | 'copiedBytes'> & {
              expectedBytes: Integer;
              copiedBytes: Integer;
            })
          | undefined,
      );
    },

    findIncomplete(): CopiedFileRecord[] {
      const rows = database
        .prepare(
          `SELECT ${copiedFileColumns} FROM copied_files
            WHERE status IN ('planned', 'started') ORDER BY created_at`,
        )
        .all() as Array<
        Omit<CopiedFileRecord, 'expectedBytes' | 'copiedBytes'> & {
          expectedBytes: Integer;
          copiedBytes: Integer;
        }
      >;
      return rows.map((row) => copiedFileFromRow(row) as CopiedFileRecord);
    },

    markStarted(id: string, startedAt: string): void {
      database.transaction(() => {
        const row = requireCopyState(id, ['planned', 'failed']);
        const recovering = row.status === 'failed';
        database
          .prepare(
            `UPDATE copied_files
                SET status = 'started',
                    started_at = CASE WHEN started_at IS NULL THEN ? ELSE started_at END,
                    copied_bytes = 0, checksum = NULL, last_progress_at = NULL,
                    failed_at = NULL, recovery_started_at = ?, verified_at = NULL,
                    error_code = NULL, error_message = NULL, updated_at = ?
              WHERE id = ?`,
          )
          .run(startedAt, recovering ? startedAt : null, startedAt, id);
        database
          .prepare(
            `UPDATE source_files
                SET status = 'copying', error_code = NULL, error_message = NULL, updated_at = ?
              WHERE id = ?`,
          )
          .run(startedAt, row.sourceFileId);
      })();
    },

    updateProgress(id: string, copiedBytes: number, updatedAt: string): void {
      database.transaction(() => {
        requireCopyState(id, ['started']);
        database
          .prepare(
            `UPDATE copied_files
                SET copied_bytes = ?, last_progress_at = ?, updated_at = ?
              WHERE id = ?`,
          )
          .run(toSqliteInteger(copiedBytes), updatedAt, updatedAt, id);
      })();
    },

    markFailed(id: string, errorCode: string, errorMessage: string, updatedAt: string): void {
      if (errorCode.length === 0 || errorMessage.length === 0) {
        throw new Error('Failed copies require a stable error code and message');
      }
      database.transaction(() => {
        const row = requireCopyState(id, ['started']);
        database
          .prepare(
            `UPDATE copied_files
                SET status = 'failed', failed_at = ?, checksum = NULL, verified_at = NULL,
                    error_code = ?, error_message = ?, updated_at = ?
              WHERE id = ?`,
          )
          .run(updatedAt, errorCode, errorMessage, updatedAt, id);
        database
          .prepare(
            `UPDATE source_files
                SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
              WHERE id = ?`,
          )
          .run(errorCode, errorMessage, updatedAt, row.sourceFileId);
      })();
    },

    markVerified(id: string, copiedBytes: number, checksum: string, verifiedAt: string): void {
      if (checksum.length === 0) {
        throw new Error('Verified copies require a destination checksum');
      }
      database.transaction(() => {
        const row = requireCopyState(id, ['started']);
        const sourceSize = fromSqliteInteger(row.sourceSize);
        if (copiedBytes !== sourceSize || copiedBytes !== fromSqliteInteger(row.expectedBytes)) {
          throw new Error('Verified copy bytes must equal the source size');
        }
        database
          .prepare(
            `UPDATE copied_files
                SET status = 'verified', copied_bytes = ?, checksum = ?, verified_at = ?,
                    failed_at = NULL, error_code = NULL, error_message = NULL, updated_at = ?
              WHERE id = ?`,
          )
          .run(toSqliteInteger(copiedBytes), checksum, verifiedAt, verifiedAt, id);
        database
          .prepare(
            `UPDATE source_files
                SET status = 'completed', error_code = NULL, error_message = NULL, updated_at = ?
              WHERE id = ?`,
          )
          .run(verifiedAt, row.sourceFileId);
      })();
    },
  };

  const thumbnails = {
    upsert(thumbnail: ThumbnailRecord): ThumbnailRecord {
      const verifiedCopy = copiedFiles.findVerifiedForSourceFile(thumbnail.sourceFileId);
      if (verifiedCopy === undefined) {
        throw new Error('Thumbnail success requires a verified copied file');
      }
      return this.recordReady({
        ...thumbnail,
        copiedFileId: verifiedCopy.id,
        cacheKey: `legacy:${thumbnail.id}`,
        checksum: `legacy:${thumbnail.id}`,
        generatorVersion: 'legacy-v1',
        retryCount: 0,
      });
    },

    recordReady(
      thumbnail: ThumbnailRecord & {
        copiedFileId: string;
        cacheKey: string;
        checksum: string;
        generatorVersion: string;
        retryCount: number;
      },
    ): ThumbnailRecord {
      return database.transaction(() => {
        const copy = database
          .prepare('SELECT status, source_file_id AS sourceFileId FROM copied_files WHERE id = ?')
          .get(thumbnail.copiedFileId) as
          { status: CopiedFileRecord['status']; sourceFileId: string } | undefined;
        if (copy?.status !== 'verified' || copy.sourceFileId !== thumbnail.sourceFileId) {
          throw new Error('Thumbnail success requires a matching verified copied file');
        }
        database
          .prepare(
            `INSERT INTO thumbnail_artifacts
              (cache_key, generator_version, cache_path, checksum, mime_type,
               width, height, size_bytes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(cache_key) DO NOTHING`,
          )
          .run(
            thumbnail.cacheKey,
            thumbnail.generatorVersion,
            thumbnail.cachePath,
            thumbnail.checksum,
            thumbnail.mimeType,
            toSqliteInteger(thumbnail.width),
            toSqliteInteger(thumbnail.height),
            toSqliteInteger(thumbnail.sizeBytes),
            thumbnail.createdAt,
            thumbnail.updatedAt,
          );
        const storedArtifact = database
          .prepare(
            `SELECT generator_version AS generatorVersion, cache_path AS cachePath,
                    checksum, mime_type AS mimeType, width, height, size_bytes AS sizeBytes
               FROM thumbnail_artifacts WHERE cache_key = ?`,
          )
          .get(thumbnail.cacheKey) as
          | {
              generatorVersion: string;
              cachePath: string;
              checksum: string;
              mimeType: string;
              width: Integer;
              height: Integer;
              sizeBytes: Integer;
            }
          | undefined;
        if (
          storedArtifact === undefined ||
          storedArtifact.generatorVersion !== thumbnail.generatorVersion ||
          storedArtifact.cachePath !== thumbnail.cachePath ||
          storedArtifact.checksum !== thumbnail.checksum ||
          storedArtifact.mimeType !== thumbnail.mimeType ||
          fromSqliteInteger(storedArtifact.width) !== thumbnail.width ||
          fromSqliteInteger(storedArtifact.height) !== thumbnail.height ||
          fromSqliteInteger(storedArtifact.sizeBytes) !== thumbnail.sizeBytes
        ) {
          throw new Error('Thumbnail cache key conflicts with a different artifact');
        }
        database
          .prepare(
            `INSERT INTO thumbnails
              (id, copied_file_id, source_file_id, variant, state, artifact_cache_key,
               error_code, safe_message, attempt_count, next_retry_at, max_attempts,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, 'ready', ?, NULL, NULL, ?, NULL, 3, ?, ?)
             ON CONFLICT(copied_file_id, variant) DO UPDATE SET
               state = 'ready',
               artifact_cache_key = excluded.artifact_cache_key,
               error_code = NULL,
               safe_message = NULL,
               attempt_count = excluded.attempt_count,
               next_retry_at = NULL,
               updated_at = excluded.updated_at`,
          )
          .run(
            thumbnail.id,
            thumbnail.copiedFileId,
            thumbnail.sourceFileId,
            thumbnail.variant,
            thumbnail.cacheKey,
            toSqliteInteger(thumbnail.retryCount),
            thumbnail.createdAt,
            thumbnail.updatedAt,
          );
        return this.findForCopy(thumbnail.copiedFileId, thumbnail.variant) as ThumbnailRecord;
      })();
    },

    listForSourceFile(sourceFileId: string): ThumbnailRecord[] {
      const rows = database
        .prepare(
          `SELECT ${thumbnailColumns}
             FROM thumbnails association
             JOIN thumbnail_artifacts artifact
               ON artifact.cache_key = association.artifact_cache_key
            WHERE association.source_file_id = ? AND association.state = 'ready'
            ORDER BY association.variant`,
        )
        .all(sourceFileId) as Array<
        Omit<ThumbnailRecord, 'width' | 'height' | 'sizeBytes'> & {
          width: Integer;
          height: Integer;
          sizeBytes: Integer;
        }
      >;
      return rows.map((row) => thumbnailFromRow(row) as ThumbnailRecord);
    },

    findByCachePath(cachePath: string): ThumbnailRecord | undefined {
      return thumbnailFromRow(
        database
          .prepare(
            `SELECT ${thumbnailColumns}
               FROM thumbnails association
               JOIN thumbnail_artifacts artifact
                 ON artifact.cache_key = association.artifact_cache_key
              WHERE association.state = 'ready' AND artifact.cache_path = ?
              ORDER BY association.updated_at DESC LIMIT 1`,
          )
          .get(cachePath) as
          | (Omit<ThumbnailRecord, 'width' | 'height' | 'sizeBytes'> & {
              width: Integer;
              height: Integer;
              sizeBytes: Integer;
            })
          | undefined,
      );
    },

    findById(id: string): ThumbnailRecord | undefined {
      return thumbnailFromRow(
        database
          .prepare(
            `SELECT ${thumbnailColumns}
               FROM thumbnails association
               JOIN thumbnail_artifacts artifact
                 ON artifact.cache_key = association.artifact_cache_key
              WHERE association.id = ? AND association.state = 'ready'`,
          )
          .get(id) as
          | (Omit<ThumbnailRecord, 'width' | 'height' | 'sizeBytes'> & {
              width: Integer;
              height: Integer;
              sizeBytes: Integer;
            })
          | undefined,
      );
    },

    findForCopy(copiedFileId: string, variant: string): ThumbnailRecord | undefined {
      return thumbnailFromRow(
        database
          .prepare(
            `SELECT ${thumbnailColumns}
               FROM thumbnails association
               JOIN thumbnail_artifacts artifact
                 ON artifact.cache_key = association.artifact_cache_key
              WHERE association.copied_file_id = ? AND association.variant = ?
                AND association.state = 'ready'`,
          )
          .get(copiedFileId, variant) as
          | (Omit<ThumbnailRecord, 'width' | 'height' | 'sizeBytes'> & {
              width: Integer;
              height: Integer;
              sizeBytes: Integer;
            })
          | undefined,
      );
    },

    recordFailure(failure: ThumbnailFailureRecord): ThumbnailFailureRecord {
      return database.transaction(() => {
        const copy = database
          .prepare(
            `SELECT status, source_file_id AS sourceFileId
               FROM copied_files WHERE id = ?`,
          )
          .get(failure.copiedFileId) as
          { status: CopiedFileRecord['status']; sourceFileId: string } | undefined;
        if (copy?.status !== 'verified' || copy.sourceFileId !== failure.sourceFileId) {
          throw new Error('Thumbnail failures require a matching verified copied file');
        }
        const attemptCount = failure.attemptCount ?? failure.retryCount;
        const maxAttempts = failure.maxAttempts ?? 3;
        database
          .prepare(
            `INSERT INTO thumbnails
              (id, copied_file_id, source_file_id, variant, state, artifact_cache_key,
               error_code, safe_message, attempt_count, next_retry_at, max_attempts,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, 'failed', NULL, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(copied_file_id, variant) DO UPDATE SET
               state = 'failed',
               artifact_cache_key = NULL,
               error_code = excluded.error_code,
               safe_message = excluded.safe_message,
               attempt_count = excluded.attempt_count,
               next_retry_at = excluded.next_retry_at,
               max_attempts = excluded.max_attempts,
               updated_at = excluded.updated_at`,
          )
          .run(
            failure.id,
            failure.copiedFileId,
            failure.sourceFileId,
            failure.variant,
            failure.errorCode,
            failure.safeMessage,
            toSqliteInteger(attemptCount),
            failure.nextRetryAt ?? null,
            toSqliteInteger(maxAttempts),
            failure.updatedAt,
            failure.updatedAt,
          );
        return { ...failure, attemptCount, maxAttempts };
      })();
    },

    retryState(copiedFileId: string, variant: string) {
      const row = database
        .prepare(
          `SELECT attempt_count AS attemptCount, next_retry_at AS nextRetryAt,
                  max_attempts AS maxAttempts
             FROM thumbnails
            WHERE copied_file_id = ? AND variant = ? AND state = 'failed'`,
        )
        .get(copiedFileId, variant) as
        { attemptCount: Integer; nextRetryAt: string | null; maxAttempts: Integer } | undefined;
      return row === undefined
        ? undefined
        : {
            attemptCount: fromSqliteInteger(row.attemptCount),
            nextRetryAt: row.nextRetryAt,
            maxAttempts: fromSqliteInteger(row.maxAttempts),
          };
    },
  };

  function summaryPredicates(filters: SummaryFilters): {
    sql: string;
    parameters: string[];
  } {
    const predicates = [`copy.status = 'verified'`];
    const parameters: string[] = [];
    if (filters.sourceId !== undefined) {
      predicates.push('source_file.source_id = ?');
      parameters.push(filters.sourceId);
    }
    if (filters.sessionId !== undefined) {
      predicates.push('copy.ingest_session_id = ?');
      parameters.push(filters.sessionId);
    }
    if (filters.mediaType !== undefined) {
      predicates.push(`COALESCE(source_file.media_type, 'unknown') = ?`);
      parameters.push(filters.mediaType);
    }
    return { sql: predicates.join(' AND '), parameters };
  }

  const captureDayExpression =
    `COALESCE(source_file.capture_day, substr(source_file.capture_at, 1, 10), ` +
    `substr(source_file.modified_at, 1, 10), substr(copy.verified_at, 1, 10))`;

  const summaries = {
    listDays(filters: SummaryFilters): SummaryDayRecord[] {
      const where = summaryPredicates(filters);
      const rows = database
        .prepare(
          `SELECT ${captureDayExpression} AS captureDay,
                  SUM(CASE WHEN COALESCE(source_file.media_type, 'unknown') = 'photo'
                           THEN 1 ELSE 0 END) AS photoCount,
                  SUM(CASE WHEN COALESCE(source_file.media_type, 'unknown') = 'video'
                           THEN 1 ELSE 0 END) AS videoCount,
                  SUM(CASE WHEN COALESCE(source_file.media_type, 'unknown') = 'unknown'
                           THEN 1 ELSE 0 END) AS unknownCount,
                  SUM(source_file.size_bytes) AS totalSizeBytes
             FROM copied_files copy
             JOIN source_files source_file ON source_file.id = copy.source_file_id
            WHERE ${where.sql}
            GROUP BY captureDay
            ORDER BY captureDay DESC`,
        )
        .all(...where.parameters) as Array<{
        captureDay: string;
        photoCount: Integer;
        videoCount: Integer;
        unknownCount: Integer;
        totalSizeBytes: Integer;
      }>;
      return rows.map((row) => ({
        captureDay: row.captureDay,
        photoCount: fromSqliteInteger(row.photoCount),
        videoCount: fromSqliteInteger(row.videoCount),
        unknownCount: fromSqliteInteger(row.unknownCount),
        totalSizeBytes: fromSqliteInteger(row.totalSizeBytes),
      }));
    },

    listMediaByDay(
      input: SummaryFilters & { captureDay: string; limit: number; cursor?: string },
    ): { items: SummaryMediaRecord[]; nextCursor: string | null } {
      const where = summaryPredicates(input);
      const parameters: Array<string | bigint> = [...where.parameters, input.captureDay];
      let cursorSql = '';
      if (input.cursor !== undefined) {
        let cursor: { path: string; id: string };
        try {
          cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as {
            path: string;
            id: string;
          };
        } catch {
          throw new Error('Invalid summary cursor');
        }
        if (typeof cursor.path !== 'string' || typeof cursor.id !== 'string') {
          throw new Error('Invalid summary cursor');
        }
        cursorSql =
          ' AND (source_file.relative_path > ? OR ' +
          '(source_file.relative_path = ? AND source_file.id > ?))';
        parameters.push(cursor.path, cursor.path, cursor.id);
      }
      parameters.push(toSqliteInteger(input.limit + 1));
      const rows = database
        .prepare(
          `SELECT source_file.id, copy.id AS copyId, copy.checksum,
                  ${captureDayExpression} AS captureDay,
                  source_file.capture_at AS capturedAt,
                  source_file.name AS originalFilename,
                  COALESCE(source_file.media_type, 'unknown') AS mediaType,
                  source_file.size_bytes AS sizeBytes,
                  source_file.camera_make AS cameraMake,
                  source_file.camera_model AS cameraModel,
                  source_file.width, source_file.height,
                  source_file.duration_seconds AS durationSeconds,
                  source_file.relative_path AS relativePath,
                  thumbnail.id AS thumbnailId, thumbnail.state AS thumbnailState,
                  artifact.mime_type AS thumbnailMimeType,
                  artifact.width AS thumbnailWidth, artifact.height AS thumbnailHeight,
                  thumbnail.error_code AS thumbnailErrorCode,
                  thumbnail.safe_message AS thumbnailSafeMessage,
                  thumbnail.attempt_count AS thumbnailAttemptCount,
                  thumbnail.next_retry_at AS thumbnailNextRetryAt,
                  thumbnail.max_attempts AS thumbnailMaxAttempts
             FROM copied_files copy
             JOIN source_files source_file ON source_file.id = copy.source_file_id
             LEFT JOIN thumbnails thumbnail ON thumbnail.id = (
               SELECT candidate.id FROM thumbnails candidate
                WHERE candidate.copied_file_id = copy.id
                  AND candidate.variant = 'grid'
                ORDER BY candidate.updated_at DESC, candidate.id DESC LIMIT 1
             )
             LEFT JOIN thumbnail_artifacts artifact
               ON artifact.cache_key = thumbnail.artifact_cache_key
            WHERE ${where.sql}
              AND ${captureDayExpression} = ?
              ${cursorSql}
            ORDER BY source_file.relative_path, source_file.id
            LIMIT ?`,
        )
        .all(...parameters) as Array<{
        id: string;
        copyId: string;
        checksum: string;
        captureDay: string;
        capturedAt: string | null;
        originalFilename: string;
        mediaType: 'photo' | 'video' | 'unknown';
        sizeBytes: Integer;
        cameraMake: string | null;
        cameraModel: string | null;
        width: Integer | null;
        height: Integer | null;
        durationSeconds: number | null;
        relativePath: string;
        thumbnailId: string | null;
        thumbnailState: 'ready' | 'failed' | null;
        thumbnailMimeType: string | null;
        thumbnailWidth: Integer | null;
        thumbnailHeight: Integer | null;
        thumbnailErrorCode: string | null;
        thumbnailSafeMessage: string | null;
        thumbnailAttemptCount: Integer | null;
        thumbnailNextRetryAt: string | null;
        thumbnailMaxAttempts: Integer | null;
      }>;
      const hasMore = rows.length > input.limit;
      const page = rows.slice(0, input.limit);
      const items = page.map((row): SummaryMediaRecord => ({
        id: row.id,
        copyId: row.copyId,
        checksum: row.checksum,
        captureDay: row.captureDay,
        capturedAt: row.capturedAt,
        originalFilename: row.originalFilename,
        mediaType: row.mediaType,
        sizeBytes: fromSqliteInteger(row.sizeBytes),
        cameraMake: row.cameraMake,
        cameraModel: row.cameraModel,
        width: row.width === null ? null : fromSqliteInteger(row.width),
        height: row.height === null ? null : fromSqliteInteger(row.height),
        durationSeconds: row.durationSeconds,
        thumbnail:
          row.thumbnailState === 'failed' && row.thumbnailErrorCode !== null
            ? {
                state: 'failed',
                errorCode: row.thumbnailErrorCode,
                safeMessage: row.thumbnailSafeMessage ?? 'Thumbnail unavailable.',
                retryCount:
                  row.thumbnailAttemptCount === null
                    ? 0
                    : fromSqliteInteger(row.thumbnailAttemptCount),
                attemptCount:
                  row.thumbnailAttemptCount === null
                    ? 0
                    : fromSqliteInteger(row.thumbnailAttemptCount),
                nextRetryAt: row.thumbnailNextRetryAt,
                maxAttempts:
                  row.thumbnailMaxAttempts === null
                    ? 3
                    : fromSqliteInteger(row.thumbnailMaxAttempts),
              }
            : row.thumbnailState === 'ready' &&
                row.thumbnailId !== null &&
                row.thumbnailMimeType !== null &&
                row.thumbnailWidth !== null &&
                row.thumbnailHeight !== null
              ? {
                  state: 'ready',
                  reference: row.thumbnailId,
                  mimeType: row.thumbnailMimeType,
                  width: fromSqliteInteger(row.thumbnailWidth),
                  height: fromSqliteInteger(row.thumbnailHeight),
                }
              : { state: 'missing' },
      }));
      const last = page.at(-1);
      return {
        items,
        nextCursor:
          hasMore && last !== undefined
            ? Buffer.from(
                JSON.stringify({
                  path: rows[input.limit - 1]?.relativePath,
                  id: last.id,
                }),
              ).toString('base64url')
            : null,
      };
    },
  };

  const settings = {
    set<Key extends SettingKey>(key: Key, value: SettingValues[Key], updatedAt: string): void {
      if (key !== 'appSettings') {
        throw new Error(`Unknown setting key: ${String(key)}`);
      }
      const validated = appSettingsSchema.parse(value);
      database
        .prepare(
          `INSERT INTO settings (key, value_json, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value_json = excluded.value_json,
             updated_at = excluded.updated_at`,
        )
        .run(key, JSON.stringify(validated), updatedAt, updatedAt);
    },

    get<Key extends SettingKey>(key: Key): SettingValues[Key] | undefined {
      if (key !== 'appSettings') {
        throw new Error(`Unknown setting key: ${String(key)}`);
      }
      const row = database
        .prepare('SELECT value_json AS valueJson FROM settings WHERE key = ?')
        .get(key) as { valueJson: string } | undefined;
      return row === undefined
        ? undefined
        : (parseStoredAppSettings(JSON.parse(row.valueJson)) as SettingValues[Key]);
    },

    delete(key: SettingKey): void {
      database.prepare('DELETE FROM settings WHERE key = ?').run(key);
    },
  };

  const manifests = {
    loadSession(sessionId: string) {
      return database.transaction(() => {
        const session = sessions.findById(sessionId);
        if (session === undefined) throw new Error(`Ingest session ${sessionId} does not exist`);
        const source = sources.findById(session.sourceId);
        if (source === undefined) throw new Error(`Source ${session.sourceId} does not exist`);
        const rows = database
          .prepare(
            `SELECT source_file.id, source_file.relative_path AS relativePath,
                    source_file.size_bytes AS sizeBytes,
                    source_file.modified_at AS modifiedAt, source_file.status,
                    copy.checksum, copy.destination_path AS destinationPath,
                    COALESCE(copy.copied_bytes, 0) AS copiedBytes,
                    COALESCE(copy.error_code, source_file.error_code) AS errorCode,
                    COALESCE(copy.error_message, source_file.error_message) AS errorMessage
               FROM source_files source_file
               LEFT JOIN copied_files copy
                 ON copy.id = (
                   SELECT candidate.id FROM copied_files candidate
                    WHERE candidate.source_file_id = source_file.id
                      AND candidate.ingest_session_id = source_file.ingest_session_id
                    ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1
                 )
              WHERE source_file.ingest_session_id = ?
              ORDER BY source_file.relative_path, source_file.id`,
          )
          .all(sessionId) as Array<{
          id: string;
          relativePath: string;
          sizeBytes: Integer;
          modifiedAt: string;
          status: SourceFileRecord['status'];
          checksum: string | null;
          destinationPath: string | null;
          copiedBytes: Integer;
          errorCode: string | null;
          errorMessage: string | null;
        }>;
        return {
          session: {
            id: session.id,
            sourceId: session.sourceId,
            status: session.status,
            startedAt: session.startedAt,
            completedAt: session.completedAt,
            errorCode: session.errorCode,
            errorMessage: session.errorMessage,
          },
          source: { id: source.id, kind: source.kind, displayName: source.displayName },
          files: rows.map((row) => ({
            ...row,
            sizeBytes: fromSqliteInteger(row.sizeBytes),
            copiedBytes: fromSqliteInteger(row.copiedBytes),
          })),
        };
      })();
    },
  };

  return {
    sources,
    throughputStats,
    identityObservations,
    sessions,
    sourceFiles,
    copiedFiles,
    thumbnails,
    summaries,
    settings,
    manifests,
  };
}

export type Repositories = ReturnType<typeof createRepositories>;

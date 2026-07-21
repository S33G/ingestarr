import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export interface MigrationResult {
  applied: number[];
  currentVersion: number;
}

const initialSchema = `
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('removable-volume', 'folder')),
  display_name TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE source_identity_observations (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL,
  algorithm_version INTEGER NOT NULL CHECK (algorithm_version >= 1),
  fingerprint TEXT NOT NULL,
  raw_facts_json TEXT NOT NULL CHECK (json_valid(raw_facts_json)),
  confidence TEXT NOT NULL CHECK (confidence IN ('exact', 'high', 'medium', 'low', 'none')),
  strong_platform_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_identity_strong_platform_id
  ON source_identity_observations(strong_platform_id)
  WHERE strong_platform_id IS NOT NULL;
CREATE INDEX idx_identity_fingerprint
  ON source_identity_observations(algorithm_version, fingerprint);
CREATE INDEX idx_identity_source_observed
  ON source_identity_observations(source_id, observed_at DESC);

CREATE TABLE ingest_sessions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (
    status IN ('discovering', 'analyzing', 'ready', 'copying', 'verifying',
               'completed', 'cancelled', 'failed')
  ),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, source_id)
);

CREATE INDEX idx_sessions_source_status ON ingest_sessions(source_id, status);
CREATE INDEX idx_sessions_status_updated ON ingest_sessions(status, updated_at);

CREATE TABLE source_files (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  ingest_session_id TEXT,
  version_key TEXT NOT NULL,
  relative_path TEXT NOT NULL CHECK (
    relative_path <> '' AND
    substr(relative_path, 1, 1) NOT IN ('/', char(92)) AND
    NOT (
      length(relative_path) >= 3 AND
      substr(relative_path, 2, 1) = ':' AND
      substr(relative_path, 3, 1) IN ('/', char(92)) AND
      lower(substr(relative_path, 1, 1)) BETWEEN 'a' AND 'z'
    )
  ),
  name TEXT NOT NULL,
  extension TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  modified_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('video', 'audio', 'image', 'sidecar', 'other')),
  status TEXT NOT NULL CHECK (
    status IN ('discovered', 'analyzing', 'ready', 'blocked', 'queued', 'copying',
               'verifying', 'completed', 'skipped', 'cancelled', 'failed')
  ),
  quick_checksum TEXT,
  full_checksum TEXT,
  capture_at TEXT,
  last_seen_at TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_id, relative_path, version_key),
  UNIQUE (id, source_id, size_bytes),
  FOREIGN KEY (ingest_session_id, source_id)
    REFERENCES ingest_sessions(id, source_id) ON DELETE NO ACTION
);

CREATE TRIGGER clear_source_file_session_before_delete
BEFORE DELETE ON ingest_sessions
FOR EACH ROW
BEGIN
  UPDATE source_files
     SET ingest_session_id = NULL
   WHERE ingest_session_id = OLD.id AND source_id = OLD.source_id;
END;

CREATE INDEX idx_source_files_source_session_status
  ON source_files(source_id, ingest_session_id, status);
CREATE INDEX idx_source_files_path_versions
  ON source_files(source_id, relative_path, modified_at DESC);
CREATE INDEX idx_source_files_quick_checksum
  ON source_files(quick_checksum) WHERE quick_checksum IS NOT NULL;
CREATE INDEX idx_source_files_full_checksum
  ON source_files(full_checksum) WHERE full_checksum IS NOT NULL;
CREATE INDEX idx_source_files_capture_at
  ON source_files(capture_at) WHERE capture_at IS NOT NULL;

CREATE TABLE copied_files (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_file_id TEXT NOT NULL,
  ingest_session_id TEXT NOT NULL,
  destination_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('planned', 'started', 'failed', 'verified')),
  expected_bytes INTEGER NOT NULL CHECK (expected_bytes >= 0),
  copied_bytes INTEGER NOT NULL CHECK (copied_bytes >= 0 AND copied_bytes <= expected_bytes),
  checksum TEXT,
  started_at TEXT,
  last_progress_at TEXT,
  failed_at TEXT,
  recovery_started_at TEXT,
  verified_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_file_id, source_id, expected_bytes)
    REFERENCES source_files(id, source_id, size_bytes) ON DELETE RESTRICT,
  FOREIGN KEY (ingest_session_id, source_id)
    REFERENCES ingest_sessions(id, source_id) ON DELETE RESTRICT,
  CHECK (
    (
      status = 'planned' AND copied_bytes = 0 AND checksum IS NULL AND
      started_at IS NULL AND last_progress_at IS NULL AND failed_at IS NULL AND
      recovery_started_at IS NULL AND verified_at IS NULL AND
      error_code IS NULL AND error_message IS NULL
    ) OR (
      status = 'started' AND started_at IS NOT NULL AND checksum IS NULL AND
      failed_at IS NULL AND verified_at IS NULL AND
      error_code IS NULL AND error_message IS NULL
    ) OR (
      status = 'failed' AND started_at IS NOT NULL AND failed_at IS NOT NULL AND
      checksum IS NULL AND verified_at IS NULL AND
      error_code IS NOT NULL AND error_code <> '' AND
      error_message IS NOT NULL AND error_message <> ''
    ) OR (
      status = 'verified' AND started_at IS NOT NULL AND
      copied_bytes = expected_bytes AND checksum IS NOT NULL AND checksum <> '' AND
      verified_at IS NOT NULL AND failed_at IS NULL AND
      error_code IS NULL AND error_message IS NULL
    )
  )
);

CREATE INDEX idx_copied_files_source_status ON copied_files(source_file_id, status);
CREATE INDEX idx_copied_files_session_status ON copied_files(ingest_session_id, status);

CREATE TABLE thumbnails (
  id TEXT PRIMARY KEY,
  source_file_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  variant TEXT NOT NULL,
  cache_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_file_id, variant)
);

CREATE INDEX idx_thumbnails_source_file ON thumbnails(source_file_id, variant);

CREATE TABLE settings (
  key TEXT PRIMARY KEY CHECK (key IN ('appSettings')),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const sourceFileMetadata = `
ALTER TABLE source_files ADD COLUMN capture_at_source TEXT CHECK (
  capture_at_source IS NULL OR capture_at_source IN (
    'DateTimeOriginal', 'CreateDate', 'QuickTimeCreateDate', 'CreationDate',
    'ContentCreateDate', 'TrackCreateDate', 'MediaCreateDate',
    'filesystem-modifiedAt', 'session-start'
  )
);
ALTER TABLE source_files ADD COLUMN capture_at_raw TEXT;
ALTER TABLE source_files ADD COLUMN capture_timezone_kind TEXT CHECK (
  capture_timezone_kind IS NULL OR
  capture_timezone_kind IN ('utc', 'offset', 'floating', 'fallback')
);
ALTER TABLE source_files ADD COLUMN capture_offset_minutes INTEGER CHECK (
  capture_offset_minutes IS NULL OR
  capture_offset_minutes BETWEEN -840 AND 840
);
ALTER TABLE source_files ADD COLUMN capture_offset_source TEXT CHECK (
  capture_offset_source IS NULL OR capture_offset_source IN (
    'inline', 'OffsetTimeOriginal', 'OffsetTimeDigitized', 'TimeZone', 'ExifDateTime'
  )
);
ALTER TABLE source_files ADD COLUMN capture_offset_raw TEXT;
ALTER TABLE source_files ADD COLUMN capture_day TEXT CHECK (
  capture_day IS NULL OR (
    length(capture_day) = 10 AND
    substr(capture_day, 5, 1) = '-' AND
    substr(capture_day, 8, 1) = '-'
  )
);
ALTER TABLE source_files ADD COLUMN camera_make TEXT;
ALTER TABLE source_files ADD COLUMN camera_model TEXT;
ALTER TABLE source_files ADD COLUMN lens_model TEXT;
ALTER TABLE source_files ADD COLUMN mime_type TEXT;
ALTER TABLE source_files ADD COLUMN media_type TEXT CHECK (
  media_type IS NULL OR media_type IN ('photo', 'video', 'unknown')
);
ALTER TABLE source_files ADD COLUMN width INTEGER CHECK (width IS NULL OR width > 0);
ALTER TABLE source_files ADD COLUMN height INTEGER CHECK (height IS NULL OR height > 0);
ALTER TABLE source_files ADD COLUMN duration_seconds REAL CHECK (
  duration_seconds IS NULL OR duration_seconds >= 0
);
ALTER TABLE source_files ADD COLUMN gps_present INTEGER NOT NULL DEFAULT 0 CHECK (
  gps_present IN (0, 1)
);

CREATE INDEX idx_source_files_capture_day
  ON source_files(capture_day) WHERE capture_day IS NOT NULL;
CREATE INDEX idx_source_files_media_type
  ON source_files(media_type) WHERE media_type IS NOT NULL;
`;

const thumbnailResults = `
ALTER TABLE thumbnails ADD COLUMN copied_file_id TEXT REFERENCES copied_files(id) ON DELETE CASCADE;
ALTER TABLE thumbnails ADD COLUMN cache_key TEXT;
ALTER TABLE thumbnails ADD COLUMN checksum TEXT;
ALTER TABLE thumbnails ADD COLUMN generator_version TEXT;
ALTER TABLE thumbnails ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0);

CREATE UNIQUE INDEX idx_thumbnails_copy_variant
  ON thumbnails(copied_file_id, variant) WHERE copied_file_id IS NOT NULL;
CREATE INDEX idx_thumbnails_cache_key
  ON thumbnails(cache_key) WHERE cache_key IS NOT NULL;

CREATE TABLE thumbnail_failures (
  id TEXT PRIMARY KEY,
  copied_file_id TEXT NOT NULL REFERENCES copied_files(id) ON DELETE CASCADE,
  source_file_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  variant TEXT NOT NULL,
  error_code TEXT NOT NULL CHECK (error_code <> ''),
  safe_message TEXT NOT NULL CHECK (safe_message <> ''),
  retry_count INTEGER NOT NULL CHECK (retry_count >= 0),
  updated_at TEXT NOT NULL,
  UNIQUE (copied_file_id, variant)
);

CREATE INDEX idx_thumbnail_failures_source_file
  ON thumbnail_failures(source_file_id, variant);
`;

const thumbnailArtifactsAndRetry = `
ALTER TABLE thumbnails RENAME TO thumbnails_legacy;
ALTER TABLE thumbnail_failures RENAME TO thumbnail_failures_legacy;

CREATE TABLE thumbnail_artifacts (
  cache_key TEXT PRIMARY KEY CHECK (cache_key <> ''),
  generator_version TEXT NOT NULL CHECK (generator_version <> ''),
  cache_path TEXT NOT NULL UNIQUE CHECK (cache_path <> ''),
  checksum TEXT NOT NULL CHECK (checksum <> ''),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/webp', 'image/jpeg')),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO thumbnail_artifacts
  (cache_key, generator_version, cache_path, checksum, mime_type, width, height,
   size_bytes, created_at, updated_at)
SELECT COALESCE(cache_key, 'legacy:' || id),
       COALESCE(generator_version, 'legacy-v1'), cache_path,
       COALESCE(checksum, 'legacy:' || id), mime_type, width, height,
       size_bytes, created_at, updated_at
  FROM thumbnails_legacy
 WHERE copied_file_id IS NOT NULL;

CREATE UNIQUE INDEX idx_copied_files_id_source_file
  ON copied_files(id, source_file_id);

CREATE TABLE thumbnails (
  id TEXT PRIMARY KEY,
  copied_file_id TEXT NOT NULL,
  source_file_id TEXT NOT NULL,
  variant TEXT NOT NULL CHECK (variant <> ''),
  state TEXT NOT NULL CHECK (state IN ('ready', 'failed')),
  artifact_cache_key TEXT REFERENCES thumbnail_artifacts(cache_key) ON DELETE RESTRICT,
  error_code TEXT,
  safe_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at TEXT,
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (copied_file_id, source_file_id)
    REFERENCES copied_files(id, source_file_id) ON DELETE CASCADE,
  UNIQUE (copied_file_id, variant),
  CHECK (
    (state = 'ready' AND artifact_cache_key IS NOT NULL AND
     error_code IS NULL AND safe_message IS NULL AND next_retry_at IS NULL) OR
    (state = 'failed' AND artifact_cache_key IS NULL AND
     error_code IS NOT NULL AND error_code <> '' AND
     safe_message IS NOT NULL AND safe_message <> '')
  )
);

INSERT INTO thumbnails
  (id, copied_file_id, source_file_id, variant, state, artifact_cache_key,
   error_code, safe_message, attempt_count, next_retry_at, max_attempts,
   created_at, updated_at)
SELECT id, copied_file_id, source_file_id, variant, 'ready',
       COALESCE(cache_key, 'legacy:' || id), NULL, NULL, retry_count, NULL, 3,
       created_at, updated_at
  FROM thumbnails_legacy
 WHERE copied_file_id IS NOT NULL;

INSERT OR REPLACE INTO thumbnails
  (id, copied_file_id, source_file_id, variant, state, artifact_cache_key,
   error_code, safe_message, attempt_count, next_retry_at, max_attempts,
   created_at, updated_at)
SELECT id, copied_file_id, source_file_id, variant, 'failed', NULL,
       error_code, safe_message, retry_count, updated_at, 3, updated_at, updated_at
  FROM thumbnail_failures_legacy;

DROP TABLE thumbnail_failures_legacy;
DROP TABLE thumbnails_legacy;

CREATE INDEX idx_thumbnails_source_file ON thumbnails(source_file_id, variant);
CREATE INDEX idx_thumbnails_retry
  ON thumbnails(state, next_retry_at, attempt_count, max_attempts);
CREATE INDEX idx_thumbnail_artifacts_cache_path ON thumbnail_artifacts(cache_path);

CREATE TRIGGER thumbnail_verified_owner_insert
BEFORE INSERT ON thumbnails
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM copied_files copy
   WHERE copy.id = NEW.copied_file_id
     AND copy.source_file_id = NEW.source_file_id
     AND copy.status = 'verified'
)
BEGIN
  SELECT RAISE(ABORT, 'thumbnail association requires matching verified copy');
END;

CREATE TRIGGER thumbnail_verified_owner_update
BEFORE UPDATE ON thumbnails
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM copied_files copy
   WHERE copy.id = NEW.copied_file_id
     AND copy.source_file_id = NEW.source_file_id
     AND copy.status = 'verified'
)
BEGIN
  SELECT RAISE(ABORT, 'thumbnail association requires matching verified copy');
END;
`;

const sourceReconciliation = `
CREATE TABLE source_identity_aliases (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  algorithm_version INTEGER NOT NULL CHECK (algorithm_version >= 1),
  fingerprint TEXT NOT NULL CHECK (fingerprint <> ''),
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  PRIMARY KEY (source_id, algorithm_version, fingerprint)
);

CREATE INDEX idx_source_identity_alias_lookup
  ON source_identity_aliases(algorithm_version, fingerprint);

CREATE TABLE source_reconciliation_audit (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  detected_key TEXT NOT NULL CHECK (detected_key <> ''),
  decision_kind TEXT NOT NULL CHECK (
    decision_kind IN ('auto-strong', 'confirmed-existing', 'created-new')
  ),
  reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json)),
  decided_at TEXT NOT NULL
);

CREATE INDEX idx_source_reconciliation_audit_source
  ON source_reconciliation_audit(source_id, decided_at DESC);

INSERT OR IGNORE INTO source_identity_aliases
  (source_id, algorithm_version, fingerprint, first_observed_at, last_observed_at)
SELECT source_id, algorithm_version, fingerprint, MIN(observed_at), MAX(observed_at)
  FROM source_identity_observations
 GROUP BY source_id, algorithm_version, fingerprint;
`;

const sessionRecoveryContext = `
CREATE TABLE session_recovery_context (
  session_id TEXT PRIMARY KEY REFERENCES ingest_sessions(id) ON DELETE CASCADE,
  destination_root TEXT NOT NULL CHECK (destination_root <> ''),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const sessionRecoveryIdentity = `
ALTER TABLE session_recovery_context ADD COLUMN source_strong_id TEXT;
ALTER TABLE session_recovery_context ADD COLUMN source_fingerprint TEXT;
ALTER TABLE session_recovery_context ADD COLUMN source_algorithm_version TEXT;
`;

const sourceNickname = `
ALTER TABLE sources ADD COLUMN nickname TEXT CHECK (
  nickname IS NULL OR (
    length(nickname) BETWEEN 1 AND 63 AND
    nickname NOT GLOB '*[^a-z0-9-]*' AND
    nickname NOT GLOB '-*' AND
    nickname NOT GLOB '*-' AND
    nickname NOT GLOB '*--*'
  )
);

CREATE INDEX idx_sources_nickname ON sources(nickname) WHERE nickname IS NOT NULL;
`;

const sourceThroughputStats = `
CREATE TABLE source_throughput_stats (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
  average_bytes_per_second REAL NOT NULL CHECK (average_bytes_per_second >= 0),
  last_bytes_per_second REAL NOT NULL CHECK (last_bytes_per_second >= 0),
  updated_at TEXT NOT NULL
);
`;

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-storage-schema',
    sql: initialSchema,
  },
  {
    version: 2,
    name: 'source-file-normalized-metadata',
    sql: sourceFileMetadata,
  },
  {
    version: 3,
    name: 'thumbnail-results-and-failures',
    sql: thumbnailResults,
  },
  {
    version: 4,
    name: 'thumbnail-artifacts-associations-and-retry',
    sql: thumbnailArtifactsAndRetry,
  },
  {
    version: 5,
    name: 'source-reconciliation-aliases-and-audit',
    sql: sourceReconciliation,
  },
  {
    version: 6,
    name: 'session-recovery-context',
    sql: sessionRecoveryContext,
  },
  {
    version: 7,
    name: 'session-recovery-source-identity',
    sql: sessionRecoveryIdentity,
  },
  {
    version: 8,
    name: 'source-nickname',
    sql: sourceNickname,
  },
  {
    version: 9,
    name: 'source-throughput-stats',
    sql: sourceThroughputStats,
  },
];

function checksum(migration: Migration): string {
  return createHash('sha256')
    .update(`${migration.version}\0${migration.name}\0${migration.sql}`)
    .digest('hex');
}

function validateMigrationOrder(orderedMigrations: readonly Migration[]): void {
  for (const [index, migration] of orderedMigrations.entries()) {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new Error(
        `Migration order is invalid: expected version ${expectedVersion}, received ${migration.version}`,
      );
    }
  }
}

export function migrateDatabase(
  database: Database.Database,
  orderedMigrations: readonly Migration[] = migrations,
): MigrationResult {
  validateMigrationOrder(orderedMigrations);
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const appliedRows = database
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: bigint; name: string; checksum: string }>;

  for (const [index, row] of appliedRows.entries()) {
    const version = Number(row.version);
    const migration = orderedMigrations[index];
    if (migration === undefined || migration.version !== version) {
      throw new Error(`Unknown or out-of-order applied migration version ${version}`);
    }
    if (row.name !== migration.name || row.checksum !== checksum(migration)) {
      throw new Error(`Migration ${version} checksum or name does not match recorded history`);
    }
  }

  const applied: number[] = [];
  const insertHistory = database.prepare(
    `INSERT INTO schema_migrations (version, name, checksum, applied_at)
     VALUES (?, ?, ?, ?)`,
  );

  for (const migration of orderedMigrations.slice(appliedRows.length)) {
    database.transaction(() => {
      database.exec(migration.sql);
      insertHistory.run(
        BigInt(migration.version),
        migration.name,
        checksum(migration),
        new Date().toISOString(),
      );
    })();
    applied.push(migration.version);
  }

  return {
    applied,
    currentVersion: appliedRows.length + applied.length,
  };
}

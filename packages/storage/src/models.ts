export type SourceKind = 'removable-volume' | 'folder';
export type IdentityConfidence = 'exact' | 'high' | 'medium' | 'low' | 'none';
export type SessionStatus =
  | 'discovering'
  | 'analyzing'
  | 'ready'
  | 'copying'
  | 'verifying'
  | 'completed'
  | 'cancelled'
  | 'failed';
export type SourceFileKind = 'video' | 'audio' | 'image' | 'sidecar' | 'other';
export type SourceFileStatus =
  | 'discovered'
  | 'analyzing'
  | 'ready'
  | 'blocked'
  | 'queued'
  | 'copying'
  | 'verifying'
  | 'completed'
  | 'skipped'
  | 'cancelled'
  | 'failed';
export type CopiedFileStatus = 'planned' | 'started' | 'failed' | 'verified';
export type CaptureAtSource =
  | 'DateTimeOriginal'
  | 'CreateDate'
  | 'QuickTimeCreateDate'
  | 'CreationDate'
  | 'ContentCreateDate'
  | 'TrackCreateDate'
  | 'MediaCreateDate'
  | 'filesystem-modifiedAt'
  | 'session-start';
export type CaptureTimezoneKind = 'utc' | 'offset' | 'floating' | 'fallback';
export type CaptureOffsetSource =
  'inline' | 'OffsetTimeOriginal' | 'OffsetTimeDigitized' | 'TimeZone' | 'ExifDateTime';
export type MediaType = 'photo' | 'video' | 'unknown';

export interface SourceRecord {
  id: string;
  kind: SourceKind;
  displayName: string;
  /** Optional user-assigned kebab-case identifier, used for destination grouping. */
  nickname: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SourceThroughputStatsRecord {
  sourceId: string;
  sampleCount: number;
  averageBytesPerSecond: number;
  lastBytesPerSecond: number;
  updatedAt: string;
}

export interface IdentityObservationRecord {
  id: string;
  sourceId: string;
  observedAt: string;
  algorithmVersion: number;
  fingerprint: string;
  rawFacts: unknown;
  confidence: IdentityConfidence;
  strongPlatformId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IngestSessionRecord {
  id: string;
  sourceId: string;
  status: SessionStatus;
  startedAt: string;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceFileRecord {
  id: string;
  sourceId: string;
  ingestSessionId: string | null;
  versionKey: string;
  relativePath: string;
  name: string;
  extension: string;
  sizeBytes: number;
  modifiedAt: string;
  kind: SourceFileKind;
  status: SourceFileStatus;
  quickChecksum: string | null;
  fullChecksum: string | null;
  captureAt: string | null;
  captureAtSource: CaptureAtSource | null;
  captureAtRaw: string | null;
  captureTimezoneKind: CaptureTimezoneKind | null;
  captureOffsetMinutes: number | null;
  captureOffsetSource: CaptureOffsetSource | null;
  captureOffsetRaw: string | null;
  captureDay: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
  mimeType: string | null;
  mediaType: MediaType | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  gpsPresent: boolean;
  lastSeenAt: string;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NewSourceFileRecord = Omit<
  SourceFileRecord,
  | 'errorCode'
  | 'errorMessage'
  | 'captureAtSource'
  | 'captureAtRaw'
  | 'captureTimezoneKind'
  | 'captureOffsetMinutes'
  | 'captureOffsetSource'
  | 'captureOffsetRaw'
  | 'captureDay'
  | 'cameraMake'
  | 'cameraModel'
  | 'lensModel'
  | 'mimeType'
  | 'mediaType'
  | 'width'
  | 'height'
  | 'durationSeconds'
  | 'gpsPresent'
> &
  Partial<
    Pick<
      SourceFileRecord,
      | 'errorCode'
      | 'errorMessage'
      | 'captureAtSource'
      | 'captureAtRaw'
      | 'captureTimezoneKind'
      | 'captureOffsetMinutes'
      | 'captureOffsetSource'
      | 'captureOffsetRaw'
      | 'captureDay'
      | 'cameraMake'
      | 'cameraModel'
      | 'lensModel'
      | 'mimeType'
      | 'mediaType'
      | 'width'
      | 'height'
      | 'durationSeconds'
      | 'gpsPresent'
    >
  >;

export interface CopiedFileRecord {
  id: string;
  sourceId: string;
  sourceFileId: string;
  ingestSessionId: string;
  destinationPath: string;
  status: CopiedFileStatus;
  expectedBytes: number;
  copiedBytes: number;
  checksum: string | null;
  startedAt: string | null;
  lastProgressAt: string | null;
  failedAt: string | null;
  recoveryStartedAt: string | null;
  verifiedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NewCopiedFileRecord = Omit<
  CopiedFileRecord,
  'sourceId' | 'lastProgressAt' | 'failedAt' | 'recoveryStartedAt'
>;

export interface ThumbnailRecord {
  id: string;
  sourceFileId: string;
  variant: string;
  cachePath: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface ThumbnailArtifactRecord {
  cacheKey: string;
  generatorVersion: string;
  cachePath: string;
  checksum: string;
  mimeType: 'image/webp' | 'image/jpeg';
  width: number;
  height: number;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface ThumbnailAssociationRecord {
  id: string;
  copiedFileId: string;
  sourceFileId: string;
  variant: string;
  state: 'ready' | 'failed';
  artifactCacheKey: string | null;
  errorCode: string | null;
  safeMessage: string | null;
  attemptCount: number;
  nextRetryAt: string | null;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface ThumbnailFailureRecord {
  id: string;
  copiedFileId: string;
  sourceFileId: string;
  variant: string;
  errorCode: string;
  safeMessage: string;
  retryCount: number;
  attemptCount?: number;
  nextRetryAt?: string | null;
  maxAttempts?: number;
  updatedAt: string;
}

export interface ThumbnailRetryState {
  attemptCount: number;
  nextRetryAt: string | null;
  maxAttempts: number;
}

export interface SummaryDayRecord {
  captureDay: string;
  photoCount: number;
  videoCount: number;
  unknownCount: number;
  totalSizeBytes: number;
}

export type SummaryThumbnail =
  | { state: 'missing' }
  | { state: 'ready'; reference: string; mimeType: string; width: number; height: number }
  | {
      state: 'failed';
      errorCode: string;
      safeMessage: string;
      retryCount: number;
      attemptCount: number;
      nextRetryAt: string | null;
      maxAttempts: number;
    };

export interface SummaryMediaRecord {
  id: string;
  copyId: string;
  checksum: string;
  captureDay: string;
  capturedAt: string | null;
  originalFilename: string;
  mediaType: MediaType;
  sizeBytes: number;
  cameraMake: string | null;
  cameraModel: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  thumbnail: SummaryThumbnail;
}

export interface SourceFileMatch {
  sourceId: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
  quickChecksum?: string | null;
  fullChecksum?: string | null;
}

export interface SessionStatusUpdate {
  status: SessionStatus;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

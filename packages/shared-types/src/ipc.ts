import { z } from 'zod';

import { captureAtSchema } from './metadata.js';
import { sourceNicknameSchema } from './source-nickname.js';

export const ipcChannels = {
  health: 'health',
  healthValidated: 'health:validated',
  chooseSourceFolder: 'source:choose-folder',
  chooseDestinationFolder: 'destination:choose-folder',
  listDetectedSources: 'source:list-detected',
  listKnownSources: 'source:list-known',
  setSourceNickname: 'source:set-nickname',
  registerSource: 'source:register',
  countSourceMedia: 'source:count-media',
  detectedSourcesChanged: 'source:detected-changed',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  resetDestinationToDefault: 'settings:reset-destination-default',
  validateTemplate: 'settings:validate-template',
  reviewIngest: 'ingest:review',
  startIngest: 'ingest:start',
  cancelIngest: 'ingest:cancel',
  listRecoverableSessions: 'ingest:list-recoverable-sessions',
  claimSession: 'ingest:claim-session',
  recoverSession: 'ingest:recover-session',
  getSession: 'ingest:get-session',
  sessionProgress: 'ingest:session-progress',
  listSummaryDays: 'summary:listDays',
  listSummaryMediaByDay: 'summary:listMediaByDay',
  getThumbnail: 'summary:getThumbnail',
  retryThumbnail: 'summary:retryThumbnail',
  summaryInvalidated: 'summary:invalidated',
  copyText: 'system:copyText',
} as const;

export type IpcChannel = (typeof ipcChannels)[keyof typeof ipcChannels];

export const copyTextRequestSchema = z.strictObject({
  text: z.string().min(1).max(8_192),
});
export type CopyTextRequest = z.infer<typeof copyTextRequestSchema>;
export const copyTextResponseSchema = z.strictObject({ ok: z.literal(true) });
export type CopyTextResponse = z.infer<typeof copyTextResponseSchema>;

export const healthRequestSchema = z.strictObject({});
export type HealthRequest = z.infer<typeof healthRequestSchema>;

export const healthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  version: z.string().min(1),
  checkedAt: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const healthValidatedRequestSchema = z.strictObject({
  checkedAt: z.iso.datetime(),
});
export type HealthValidatedRequest = z.infer<typeof healthValidatedRequestSchema>;
export const healthValidatedResponseSchema = z.strictObject({ ok: z.literal(true) });
export type HealthValidatedResponse = z.infer<typeof healthValidatedResponseSchema>;

export const chooseFolderRequestSchema = z.strictObject({});
export type ChooseFolderRequest = z.infer<typeof chooseFolderRequestSchema>;

export const chooseFolderResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('cancelled') }),
  z.strictObject({
    status: z.literal('selected'),
    capabilityId: z.string().min(1),
    label: z.string().min(1),
    displayPath: z.string().min(1),
    expiresAt: z.iso.datetime(),
  }),
]);
export type ChooseFolderResponse = z.infer<typeof chooseFolderResponseSchema>;

export const detectedSourceSchema = z.strictObject({
  id: z.string().min(1).max(256),
  strongPlatformId: z.string().min(1).max(512).optional(),
  capabilityId: z.string().min(1).max(512),
  label: z.string().min(1).max(256),
  kind: z.enum(['removable-volume', 'folder']),
  online: z.boolean(),
  identityConfidence: z.enum(['exact', 'high', 'medium', 'low', 'none']),
  reasons: z.array(z.string().min(1).max(128)).max(16),
  requiresConfirmation: z.boolean(),
  expiresAt: z.iso.datetime(),
  /** Genuinely observed from the OS where available; absent rather than fabricated. */
  deviceVendor: z.string().min(1).max(256).optional(),
  deviceModel: z.string().min(1).max(256).optional(),
  fsType: z.string().min(1).max(64).optional(),
  capacityBytes: z.number().int().nonnegative().optional(),
  /** Set when this detected volume was definitively resolved to an existing known source —
   * authoritatively via its on-card identity marker, or via a strong platform-id match. When
   * present, the UI treats the detected volume and that known source as the SAME card (a single
   * unified row), rather than showing them as two separate entries. */
  knownSourceId: z.string().min(1).max(256).optional(),
  knownNickname: sourceNicknameSchema.nullable().optional(),
});
export type DetectedSource = z.infer<typeof detectedSourceSchema>;
export const detectedSourceListRequestSchema = z.strictObject({});
export const detectedSourceListResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), sources: z.array(detectedSourceSchema).max(128) }),
  z.strictObject({ ok: z.literal(false), error: z.lazy(() => ipcErrorSchema) }),
]);
export type DetectedSourceListResponse = z.infer<typeof detectedSourceListResponseSchema>;
export const detectedSourcesChangedEventSchema = z.strictObject({
  windowId: z.number().int().positive(),
});

// Counts the media files physically present on a currently-detected (online) volume, so the
// Sources tab can show "how much is on this card" before any ingest. Keyed by detected source id
// (the volume must be online to be scanned).
export const countSourceMediaRequestSchema = z.strictObject({
  detectedSourceId: z.string().min(1).max(256),
});
export type CountSourceMediaRequest = z.infer<typeof countSourceMediaRequestSchema>;
// A single capture-day's worth of media on the card, so the Sources tab can draw a
// Disk-Utility-style capacity bar segmented (and coloured) by date.
export const sourceMediaDaySchema = z.strictObject({
  day: z.iso.date(),
  photos: z.number().int().nonnegative(),
  videos: z.number().int().nonnegative(),
  other: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type SourceMediaDay = z.infer<typeof sourceMediaDaySchema>;
export const countSourceMediaResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    total: z.number().int().nonnegative(),
    photos: z.number().int().nonnegative(),
    videos: z.number().int().nonnegative(),
    other: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    byDay: z.array(sourceMediaDaySchema).max(1_024).optional(),
  }),
  z.strictObject({ ok: z.literal(false), error: z.lazy(() => ipcErrorSchema) }),
]);
export type CountSourceMediaResponse = z.infer<typeof countSourceMediaResponseSchema>;
export const sourceThroughputSchema = z.strictObject({
  averageBytesPerSecond: z.number().nonnegative(),
  lastBytesPerSecond: z.number().nonnegative(),
  sampleCount: z.number().int().nonnegative(),
  isSlow: z.boolean(),
});
export type SourceThroughput = z.infer<typeof sourceThroughputSchema>;

export const knownSourceSummarySchema = z.strictObject({
  id: z.string().min(1).max(256),
  fingerprint: z.string().min(1).max(512).optional(),
  algorithmVersion: z.number().int().positive().optional(),
  displayName: z.string().min(1).max(256),
  nickname: sourceNicknameSchema.nullable(),
  kind: z.enum(['removable-volume', 'folder']),
  online: z.boolean(),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  sessionCount: z.number().int().nonnegative(),
  lastSessionStatus: z
    .enum([
      'discovering',
      'analyzing',
      'ready',
      'copying',
      'verifying',
      'completed',
      'cancelled',
      'failed',
    ])
    .nullable(),
  verifiedMediaCount: z.number().int().nonnegative(),
  verifiedBytes: z.number().int().nonnegative(),
  identityConfidence: z.enum(['exact', 'high', 'medium', 'low', 'none']),
  throughput: sourceThroughputSchema.optional(),
});
export type KnownSourceSummary = z.infer<typeof knownSourceSummarySchema>;
export const listKnownSourcesRequestSchema = z.strictObject({});
export const listKnownSourcesResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), sources: z.array(knownSourceSummarySchema).max(10_000) }),
  z.strictObject({ ok: z.literal(false), error: z.lazy(() => ipcErrorSchema) }),
]);
export type ListKnownSourcesResponse = z.infer<typeof listKnownSourcesResponseSchema>;

export const setSourceNicknameRequestSchema = z.strictObject({
  sourceId: z.string().min(1).max(256),
  nickname: sourceNicknameSchema.nullable(),
});
export type SetSourceNicknameRequest = z.infer<typeof setSourceNicknameRequestSchema>;
export const setSourceNicknameResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), nickname: sourceNicknameSchema.nullable() }),
  z.strictObject({ ok: z.literal(false), error: z.lazy(() => ipcErrorSchema) }),
]);
export type SetSourceNicknameResponse = z.infer<typeof setSourceNicknameResponseSchema>;

// Promotes a currently-detected (but never-ingested) source into the known-source registry so it
// can be nicknamed before the user ever starts an ingest. Uses the ephemeral detected-source id
// (from `source:list-detected`) rather than a durable source id, since one doesn't exist yet.
//
// Naming is a single unambiguous action — "this card is this" — so there is no confirmation
// handshake. Authoritative signals (on-card marker, strong platform id) reconcile the card to an
// existing source automatically; otherwise it becomes its own source. Either way the result is a
// resolved source id, and an on-card marker is written so the card self-identifies from then on.
export const registerSourceRequestSchema = z.strictObject({
  detectedSourceId: z.string().min(1).max(256),
  nickname: sourceNicknameSchema.nullable(),
});
export type RegisterSourceRequest = z.infer<typeof registerSourceRequestSchema>;
export const registerSourceResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    sourceId: z.string().min(1).max(256),
    nickname: sourceNicknameSchema.nullable(),
  }),
  z.strictObject({ ok: z.literal(false), error: z.lazy(() => ipcErrorSchema) }),
]);
export type RegisterSourceResponse = z.infer<typeof registerSourceResponseSchema>;

export const rendererSettingsSchema = z.strictObject({
  destination: z.strictObject({
    configured: z.boolean(),
    label: z.string().min(1).max(256).optional(),
    path: z.string().min(1).max(1_024).optional(),
    defaultPath: z.string().min(1).max(1_024).optional(),
  }),
  allowedExtensions: z
    .array(z.string().regex(/^\.[a-z0-9]+$/))
    .min(1)
    .max(128),
  excludedPathPatterns: z.array(z.string().min(1).max(512)).max(128),
  destinationTemplate: z.string().min(1).max(1_024),
  copyConcurrency: z.number().int().min(1).max(4),
  groupByNicknameInDestination: z.boolean().default(false),
  perCardEventLog: z.boolean().default(false),
  autoIngest: z.boolean().default(false),
  thumbnail: z.strictObject({
    width: z.number().int().min(64).max(2_048),
    height: z.number().int().min(64).max(2_048),
    cachePolicy: z.enum(['bounded', 'session']),
    cacheLimitBytes: z.number().int().min(1).max(100_000_000_000),
  }),
  verifyCopies: z.literal(true),
});
export type RendererSettings = z.infer<typeof rendererSettingsSchema>;
export const getSettingsRequestSchema = z.strictObject({});
export const getSettingsResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), settings: rendererSettingsSchema }),
  z.strictObject({ ok: z.literal(false), error: z.lazy(() => ipcErrorSchema) }),
]);
export type GetSettingsResponse = z.infer<typeof getSettingsResponseSchema>;
export const updateSettingsRequestSchema = rendererSettingsSchema
  .omit({ destination: true, verifyCopies: true })
  .extend({ destinationCapabilityId: z.string().min(1).max(512).optional() })
  .strict();
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;
export const updateSettingsResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), settings: rendererSettingsSchema }),
  z.strictObject({ ok: z.literal(false), error: z.lazy(() => ipcErrorSchema) }),
]);
export type UpdateSettingsResponse = z.infer<typeof updateSettingsResponseSchema>;
export const resetDestinationToDefaultRequestSchema = z.strictObject({});
export type ResetDestinationToDefaultRequest = z.infer<
  typeof resetDestinationToDefaultRequestSchema
>;
export const resetDestinationToDefaultResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), settings: rendererSettingsSchema }),
  z.strictObject({ ok: z.literal(false), error: z.lazy(() => ipcErrorSchema) }),
]);
export type ResetDestinationToDefaultResponse = z.infer<
  typeof resetDestinationToDefaultResponseSchema
>;
export const validateTemplateRequestSchema = z.strictObject({
  template: z.string().min(1).max(1_024),
  sample: z
    .strictObject({
      captureDay: z.iso.date(),
      sourceLabelOrCamera: z.string().min(1).max(256),
      originalFilename: z.string().min(1).max(512),
    })
    .optional(),
});
export type ValidateTemplateRequest = z.infer<typeof validateTemplateRequestSchema>;
export const validateTemplateResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), preview: z.string().min(1).max(1_024) }),
  z.strictObject({
    ok: z.literal(false),
    errors: z.array(z.string().min(1).max(512)).min(1).max(32),
  }),
]);
export type ValidateTemplateResponse = z.infer<typeof validateTemplateResponseSchema>;

export const ipcErrorSchema = z.strictObject({
  code: z.enum([
    'UNAUTHORIZED',
    'INVALID_REQUEST',
    'CAPABILITY_EXPIRED',
    'CAPABILITY_INVALID',
    'REVIEW_EXPIRED',
    'SOURCE_UNAVAILABLE',
    'DESTINATION_INVALID',
    'INGEST_ACTIVE',
    'SESSION_NOT_FOUND',
    'INTERNAL_ERROR',
  ]),
  message: z.string().min(1),
  retryable: z.boolean(),
});
export type IpcError = z.infer<typeof ipcErrorSchema>;

export const reviewIngestRequestSchema = z.strictObject({
  sourceCapabilityId: z.string().min(1),
  // Optional: when omitted, the ingest destination configured in Settings is used. Supplied only
  // when the user manually overrides the destination via the folder picker.
  destinationCapabilityId: z.string().min(1).optional(),
});
export type ReviewIngestRequest = z.infer<typeof reviewIngestRequestSchema>;

export const ingestReviewSchema = z.strictObject({
  reviewId: z.string().min(1),
  expiresAt: z.iso.datetime(),
  source: z.strictObject({
    displayName: z.string().min(1),
    identity: z.string().min(1),
    confidence: z.enum(['high', 'medium', 'low']),
    requiresConfirmation: z.boolean().optional(),
    candidates: z
      .array(
        z.strictObject({
          sourceId: z.string().min(1).max(256),
          displayName: z.string().min(1).max(256),
          confidence: z.enum(['exact', 'medium']),
          reasons: z.array(z.string().min(1).max(128)).max(16),
        }),
      )
      .max(32)
      .optional(),
  }),
  counts: z.strictObject({
    new: z.number().int().nonnegative(),
    known: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
    recoverable: z.number().int().nonnegative(),
  }),
  estimatedBytes: z.number().int().nonnegative(),
  destinationPreview: z.string().min(1),
  // Per capture-day breakdown of the media on the card, so the review screen can let the user
  // pick which dates to ingest (defaulting to all). Empty when no media was found.
  byDay: z.array(sourceMediaDaySchema).max(1_024).default([]),
});
export type IngestReview = z.infer<typeof ingestReviewSchema>;

export const reviewIngestResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), value: ingestReviewSchema }),
  z.strictObject({ ok: z.literal(false), error: ipcErrorSchema }),
]);
export type ReviewIngestResponse = z.infer<typeof reviewIngestResponseSchema>;

export const startIngestRequestSchema = z.strictObject({
  reviewId: z.string().min(1),
  sourceDecision: z
    .discriminatedUnion('action', [
      z.strictObject({ action: z.literal('new') }),
      z.strictObject({
        action: z.literal('existing'),
        sourceId: z.string().min(1).max(256),
      }),
    ])
    .optional(),
  // Optional capture-day allowlist (YYYY-MM-DD). When present, only media whose modified date is
  // in this set is copied. Omitted (or empty) means ingest everything on the card.
  includedCaptureDays: z.array(z.iso.date()).max(1_024).optional(),
});
export type StartIngestRequest = z.infer<typeof startIngestRequestSchema>;

export const startIngestResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), sessionId: z.string().min(1) }),
  z.strictObject({ ok: z.literal(false), error: ipcErrorSchema }),
]);
export type StartIngestResponse = z.infer<typeof startIngestResponseSchema>;

export const cancelIngestRequestSchema = z.strictObject({ sessionId: z.string().min(1) });
export type CancelIngestRequest = z.infer<typeof cancelIngestRequestSchema>;
export const cancelIngestResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), error: ipcErrorSchema }),
]);
export type CancelIngestResponse = z.infer<typeof cancelIngestResponseSchema>;

export const getSessionRequestSchema = z.strictObject({ sessionId: z.string().min(1) });
export type GetSessionRequest = z.infer<typeof getSessionRequestSchema>;

export const sessionErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  filename: z.string().min(1).optional(),
});

export const sessionSnapshotSchema = z.strictObject({
  sessionId: z.string().min(1),
  sourceId: z.string().min(1).max(256).optional(),
  status: z.enum([
    'discovering',
    'analyzing',
    'ready',
    'copying',
    'verifying',
    'completed',
    'cancelled',
    'failed',
  ]),
  phase: z.string().min(1),
  totalFiles: z.number().int().nonnegative(),
  newFiles: z.number().int().nonnegative().optional(),
  completedFiles: z.number().int().nonnegative(),
  verifiedFiles: z.number().int().nonnegative().optional(),
  skippedFiles: z.number().int().nonnegative(),
  failedFiles: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  completedBytes: z.number().int().nonnegative(),
  currentFile: z.string().min(1).optional(),
  throughputBytesPerSecond: z.number().nonnegative(),
  errors: z.array(sessionErrorSchema),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;

export const getSessionResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), session: sessionSnapshotSchema }),
  z.strictObject({ ok: z.literal(false), error: ipcErrorSchema }),
]);
export type GetSessionResponse = z.infer<typeof getSessionResponseSchema>;

export const listRecoverableSessionsRequestSchema = z.strictObject({});
export type ListRecoverableSessionsRequest = z.infer<typeof listRecoverableSessionsRequestSchema>;

export const recoverableSessionSummarySchema = z.strictObject({
  claimCapabilityId: z.string().min(1),
  expiresAt: z.iso.datetime(),
  status: z.enum([
    'discovering',
    'analyzing',
    'ready',
    'copying',
    'verifying',
    'cancelled',
    'failed',
  ]),
  phase: z.string().min(1),
  totalFiles: z.number().int().nonnegative(),
  completedFiles: z.number().int().nonnegative(),
  skippedFiles: z.number().int().nonnegative(),
  failedFiles: z.number().int().nonnegative(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  error: sessionErrorSchema.omit({ filename: true }).optional(),
});
export type RecoverableSessionSummary = z.infer<typeof recoverableSessionSummarySchema>;

export const listRecoverableSessionsResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), sessions: z.array(recoverableSessionSummarySchema) }),
  z.strictObject({ ok: z.literal(false), error: ipcErrorSchema }),
]);
export type ListRecoverableSessionsResponse = z.infer<typeof listRecoverableSessionsResponseSchema>;

export const claimSessionRequestSchema = z.strictObject({
  claimCapabilityId: z.string().min(1),
});
export type ClaimSessionRequest = z.infer<typeof claimSessionRequestSchema>;

export const claimSessionResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), session: sessionSnapshotSchema }),
  z.strictObject({ ok: z.literal(false), error: ipcErrorSchema }),
]);
export type ClaimSessionResponse = z.infer<typeof claimSessionResponseSchema>;

export const recoverSessionRequestSchema = z.strictObject({
  claimCapabilityId: z.string().min(1).max(512),
  action: z.enum(['resume', 'cleanup']),
  sourceCapabilityId: z.string().min(1).max(512).optional(),
  confirmSourceMismatch: z.boolean().optional(),
});
export type RecoverSessionRequest = z.infer<typeof recoverSessionRequestSchema>;
export const recoverSessionResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    result: z.discriminatedUnion('action', [
      z.strictObject({ action: z.literal('resume'), session: sessionSnapshotSchema }),
      z.strictObject({ action: z.literal('cleanup') }),
    ]),
  }),
  z.strictObject({ ok: z.literal(false), error: ipcErrorSchema }),
]);
export type RecoverSessionResponse = z.infer<typeof recoverSessionResponseSchema>;

export const sessionProgressEventSchema = z.strictObject({
  windowId: z.number().int().positive(),
  session: sessionSnapshotSchema,
});
export type SessionProgressEvent = z.infer<typeof sessionProgressEventSchema>;

const summaryFiltersSchema = z.strictObject({
  sourceId: z.string().min(1).max(256).optional(),
  sessionId: z.string().min(1).max(256).optional(),
  mediaType: z.enum(['photo', 'video', 'unknown']).optional(),
});

export const listSummaryDaysRequestSchema = summaryFiltersSchema;
export type ListSummaryDaysRequest = z.infer<typeof listSummaryDaysRequestSchema>;

export const summaryDaySchema = z.strictObject({
  captureDay: z.iso.date(),
  photoCount: z.number().int().nonnegative(),
  videoCount: z.number().int().nonnegative(),
  unknownCount: z.number().int().nonnegative(),
  totalSizeBytes: z.number().int().nonnegative(),
});
export type SummaryDay = z.infer<typeof summaryDaySchema>;

export const listSummaryDaysResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), days: z.array(summaryDaySchema) }),
  z.strictObject({ ok: z.literal(false), error: ipcErrorSchema }),
]);
export type ListSummaryDaysResponse = z.infer<typeof listSummaryDaysResponseSchema>;

export const listSummaryMediaRequestSchema = summaryFiltersSchema.extend({
  captureDay: z.iso.date(),
  limit: z.number().int().min(1).max(200).default(60),
  cursor: z.string().min(1).max(2048).optional(),
});
export type ListSummaryMediaRequest = z.infer<typeof listSummaryMediaRequestSchema>;

export const summaryThumbnailSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('missing') }),
  z.strictObject({
    state: z.literal('ready'),
    token: z.string().min(1),
    mimeType: z.enum(['image/webp', 'image/jpeg']),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.strictObject({
    state: z.literal('failed'),
    errorCode: z.string().min(1).max(128),
    safeMessage: z.string().min(1).max(256),
    retryCount: z.number().int().nonnegative(),
    attemptCount: z.number().int().nonnegative(),
    nextRetryAt: z.iso.datetime().nullable(),
    maxAttempts: z.number().int().positive(),
    retryCapability: z.strictObject({
      token: z.string().min(1).max(512),
      expiresAt: z.iso.datetime(),
    }),
  }),
]);

export const summaryMediaSchema = z.strictObject({
  id: z.string().min(1),
  copyId: z.string().min(1),
  checksum: z.string().min(1),
  captureDay: z.iso.date(),
  capturedAt: captureAtSchema.nullable(),
  originalFilename: z.string().min(1).max(1024),
  mediaType: z.enum(['photo', 'video', 'unknown']),
  sizeBytes: z.number().int().nonnegative(),
  cameraMake: z.string().max(256).nullable(),
  cameraModel: z.string().max(256).nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationSeconds: z.number().nonnegative().nullable(),
  thumbnail: summaryThumbnailSchema,
});
export type SummaryMedia = z.infer<typeof summaryMediaSchema>;

export const listSummaryMediaResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    items: z.array(summaryMediaSchema),
    nextCursor: z.string().min(1).nullable(),
  }),
  z.strictObject({ ok: z.literal(false), error: ipcErrorSchema }),
]);
export type ListSummaryMediaResponse = z.infer<typeof listSummaryMediaResponseSchema>;

export const getThumbnailRequestSchema = z.strictObject({ token: z.string().min(1).max(512) });
export type GetThumbnailRequest = z.infer<typeof getThumbnailRequestSchema>;
export const getThumbnailResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    mimeType: z.enum(['image/webp', 'image/jpeg']),
    base64: z.string().max(8_000_000),
  }),
  z.strictObject({ ok: z.literal(false), error: ipcErrorSchema }),
]);
export type GetThumbnailResponse = z.infer<typeof getThumbnailResponseSchema>;

export const retryThumbnailRequestSchema = z.strictObject({
  capability: z.string().min(1).max(512),
});
export type RetryThumbnailRequest = z.infer<typeof retryThumbnailRequestSchema>;
export const retryThumbnailResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), error: ipcErrorSchema }),
]);
export type RetryThumbnailResponse = z.infer<typeof retryThumbnailResponseSchema>;

export const summaryInvalidatedEventSchema = z.strictObject({
  windowId: z.number().int().positive(),
});

export const ipcRequestSchemas = {
  health: healthRequestSchema,
  healthValidated: healthValidatedRequestSchema,
  chooseSourceFolder: chooseFolderRequestSchema,
  chooseDestinationFolder: chooseFolderRequestSchema,
  listDetectedSources: detectedSourceListRequestSchema,
  listKnownSources: listKnownSourcesRequestSchema,
  setSourceNickname: setSourceNicknameRequestSchema,
  registerSource: registerSourceRequestSchema,
  countSourceMedia: countSourceMediaRequestSchema,
  getSettings: getSettingsRequestSchema,
  updateSettings: updateSettingsRequestSchema,
  resetDestinationToDefault: resetDestinationToDefaultRequestSchema,
  validateTemplate: validateTemplateRequestSchema,
  reviewIngest: reviewIngestRequestSchema,
  startIngest: startIngestRequestSchema,
  cancelIngest: cancelIngestRequestSchema,
  listRecoverableSessions: listRecoverableSessionsRequestSchema,
  claimSession: claimSessionRequestSchema,
  recoverSession: recoverSessionRequestSchema,
  getSession: getSessionRequestSchema,
  listSummaryDays: listSummaryDaysRequestSchema,
  listSummaryMediaByDay: listSummaryMediaRequestSchema,
  getThumbnail: getThumbnailRequestSchema,
  retryThumbnail: retryThumbnailRequestSchema,
  copyText: copyTextRequestSchema,
} as const;

export const ipcResponseSchemas = {
  health: healthResponseSchema,
  healthValidated: healthValidatedResponseSchema,
  chooseSourceFolder: chooseFolderResponseSchema,
  chooseDestinationFolder: chooseFolderResponseSchema,
  listDetectedSources: detectedSourceListResponseSchema,
  listKnownSources: listKnownSourcesResponseSchema,
  setSourceNickname: setSourceNicknameResponseSchema,
  registerSource: registerSourceResponseSchema,
  countSourceMedia: countSourceMediaResponseSchema,
  getSettings: getSettingsResponseSchema,
  updateSettings: updateSettingsResponseSchema,
  resetDestinationToDefault: resetDestinationToDefaultResponseSchema,
  validateTemplate: validateTemplateResponseSchema,
  reviewIngest: reviewIngestResponseSchema,
  startIngest: startIngestResponseSchema,
  cancelIngest: cancelIngestResponseSchema,
  listRecoverableSessions: listRecoverableSessionsResponseSchema,
  claimSession: claimSessionResponseSchema,
  recoverSession: recoverSessionResponseSchema,
  getSession: getSessionResponseSchema,
  listSummaryDays: listSummaryDaysResponseSchema,
  listSummaryMediaByDay: listSummaryMediaResponseSchema,
  getThumbnail: getThumbnailResponseSchema,
  retryThumbnail: retryThumbnailResponseSchema,
  copyText: copyTextResponseSchema,
} as const;

export interface IpcRequestMap {
  health: HealthRequest;
  healthValidated: HealthValidatedRequest;
  chooseSourceFolder: ChooseFolderRequest;
  chooseDestinationFolder: ChooseFolderRequest;
  listDetectedSources: z.infer<typeof detectedSourceListRequestSchema>;
  listKnownSources: z.infer<typeof listKnownSourcesRequestSchema>;
  setSourceNickname: SetSourceNicknameRequest;
  registerSource: RegisterSourceRequest;
  countSourceMedia: CountSourceMediaRequest;
  getSettings: z.infer<typeof getSettingsRequestSchema>;
  updateSettings: UpdateSettingsRequest;
  resetDestinationToDefault: ResetDestinationToDefaultRequest;
  validateTemplate: ValidateTemplateRequest;
  reviewIngest: ReviewIngestRequest;
  startIngest: StartIngestRequest;
  cancelIngest: CancelIngestRequest;
  listRecoverableSessions: ListRecoverableSessionsRequest;
  claimSession: ClaimSessionRequest;
  recoverSession: RecoverSessionRequest;
  getSession: GetSessionRequest;
  listSummaryDays: ListSummaryDaysRequest;
  listSummaryMediaByDay: ListSummaryMediaRequest;
  getThumbnail: GetThumbnailRequest;
  retryThumbnail: RetryThumbnailRequest;
  copyText: CopyTextRequest;
}

export interface IpcResponseMap {
  health: HealthResponse;
  healthValidated: HealthValidatedResponse;
  chooseSourceFolder: ChooseFolderResponse;
  chooseDestinationFolder: ChooseFolderResponse;
  listDetectedSources: DetectedSourceListResponse;
  listKnownSources: ListKnownSourcesResponse;
  setSourceNickname: SetSourceNicknameResponse;
  registerSource: RegisterSourceResponse;
  countSourceMedia: CountSourceMediaResponse;
  getSettings: GetSettingsResponse;
  updateSettings: UpdateSettingsResponse;
  resetDestinationToDefault: ResetDestinationToDefaultResponse;
  validateTemplate: ValidateTemplateResponse;
  reviewIngest: ReviewIngestResponse;
  startIngest: StartIngestResponse;
  cancelIngest: CancelIngestResponse;
  listRecoverableSessions: ListRecoverableSessionsResponse;
  claimSession: ClaimSessionResponse;
  recoverSession: RecoverSessionResponse;
  getSession: GetSessionResponse;
  listSummaryDays: ListSummaryDaysResponse;
  listSummaryMediaByDay: ListSummaryMediaResponse;
  getThumbnail: GetThumbnailResponse;
  retryThumbnail: RetryThumbnailResponse;
  copyText: CopyTextResponse;
}

export type IpcInvokeChannel = keyof IpcRequestMap;
export type IpcRequest<C extends IpcInvokeChannel> = IpcRequestMap[C];
export type IpcResponse<C extends IpcInvokeChannel> = IpcResponseMap[C];

import type { DesktopApi } from '../../preload/api';
import type { SessionSnapshot } from '@ingestarr/shared-types';

const EXPIRES = '2026-07-21T12:00:00.000Z';

const settings = {
  destination: {
    configured: true,
    path: '/Users/alex/Archive/Ingestarr',
    label: 'Ingestarr Archive',
  },
  allowedExtensions: ['.jpg', '.jpeg', '.cr2', '.cr3', '.nef', '.arw', '.mov', '.mp4'],
  excludedPathPatterns: ['.Trashes', '.DS_Store'],
  destinationTemplate: '{YYYY}/{YYYY-MM-DD}/{sourceLabelOrCamera}/{originalFilename}',
  copyConcurrency: 2,
  groupByNicknameInDestination: true,
  perCardEventLog: true,
  autoIngest: false,
  thumbnail: {
    width: 480,
    height: 480,
    cachePolicy: 'bounded' as const,
    cacheLimitBytes: 2_000_000_000,
  },
  verifyCopies: true as const,
};

const reviewValue = {
  reviewId: 'review-demo',
  expiresAt: EXPIRES,
  source: {
    displayName: 'EOS_DIGITAL',
    identity: 'canon-r5',
    confidence: 'high' as const,
  },
  counts: { new: 2847, known: 412, ambiguous: 0, recoverable: 0 },
  estimatedBytes: 98_765_432_100,
  destinationPreview: 'Ingestarr Archive/2026/2026-07-19/canon-r5',
  byDay: [
    { day: '2026-07-18', photos: 840, videos: 42, other: 0, bytes: 38_400_000_000 },
    { day: '2026-07-19', photos: 612, videos: 18, other: 0, bytes: 29_100_000_000 },
    { day: '2026-07-20', photos: 295, videos: 8, other: 0, bytes: 14_200_000_000 },
  ],
};

const progressSession: SessionSnapshot = {
  sessionId: 'session-demo-7f3a',
  sourceId: 'known-canon-r5',
  status: 'copying',
  phase: 'Copying',
  totalFiles: 3259,
  newFiles: 2847,
  completedFiles: 1842,
  verifiedFiles: 1840,
  skippedFiles: 412,
  failedFiles: 0,
  totalBytes: 98_765_432_100,
  completedBytes: 56_234_891_776,
  currentFile: 'IMG_4521.CR3',
  throughputBytesPerSecond: 287_500_000,
  errors: [],
  startedAt: '2026-07-21T11:42:00.000Z',
  updatedAt: '2026-07-21T11:48:32.000Z',
};

const mediaByDay = [
  { day: '2026-07-18', photos: 840, videos: 42, other: 0, bytes: 38_400_000_000 },
  { day: '2026-07-19', photos: 612, videos: 18, other: 0, bytes: 29_100_000_000 },
  { day: '2026-07-20', photos: 295, videos: 8, other: 0, bytes: 14_200_000_000 },
];

export function createReadmeScreenshotApi(): DesktopApi {
  let progressListener: ((session: SessionSnapshot) => void) | undefined;

  const noopUnsub = (): void => undefined;

  return {
    health: async () => ({
      status: 'ok',
      version: '0.1.0-demo',
      checkedAt: '2026-07-21T12:00:00.000Z',
    }),
    chooseSourceFolder: async () => ({
      status: 'selected',
      capabilityId: 'demo-source-cap',
      label: 'EOS_DIGITAL',
      displayPath: '/Volumes/EOS_DIGITAL',
      expiresAt: EXPIRES,
    }),
    chooseDestinationFolder: async () => ({
      status: 'selected',
      capabilityId: 'demo-dest-cap',
      label: 'Ingestarr Archive',
      displayPath: '/Users/alex/Archive/Ingestarr',
      expiresAt: EXPIRES,
    }),
    listDetectedSources: async () => ({
      ok: true,
      sources: [
        {
          id: 'detected-canon',
          capabilityId: 'demo-detected-canon',
          label: 'EOS_DIGITAL',
          kind: 'removable-volume',
          online: true,
          identityConfidence: 'exact',
          reasons: ['on-card-identity-marker'],
          requiresConfirmation: false,
          expiresAt: EXPIRES,
          deviceVendor: 'Canon',
          deviceModel: 'EOS R5',
          fsType: 'exFAT',
          capacityBytes: 128_000_000_000,
          knownSourceId: 'known-canon-r5',
          knownNickname: 'canon-r5',
        },
        {
          id: 'detected-new',
          capabilityId: 'demo-detected-new',
          label: 'UNTITLED',
          kind: 'removable-volume',
          online: true,
          identityConfidence: 'high',
          reasons: ['strong-platform-id-observed'],
          requiresConfirmation: true,
          expiresAt: EXPIRES,
          deviceVendor: 'SanDisk',
          deviceModel: 'Extreme Pro',
          fsType: 'exFAT',
          capacityBytes: 64_000_000_000,
        },
      ],
    }),
    listKnownSources: async () => ({
      ok: true,
      sources: [
        {
          id: 'known-canon-r5',
          displayName: 'EOS_DIGITAL',
          nickname: 'canon-r5',
          kind: 'removable-volume',
          online: true,
          firstSeenAt: '2026-03-14T09:00:00.000Z',
          lastSeenAt: '2026-07-21T11:40:00.000Z',
          sessionCount: 47,
          lastSessionStatus: 'completed',
          verifiedMediaCount: 18_420,
          verifiedBytes: 892_000_000_000,
          identityConfidence: 'exact',
          fingerprint: 'a3f8c2e91b0476d5e8f0a1c3b5d7e9f2',
          algorithmVersion: 2,
          throughput: {
            averageBytesPerSecond: 245_000_000,
            lastBytesPerSecond: 287_500_000,
            sampleCount: 47,
            isSlow: false,
          },
        },
        {
          id: 'known-backup-cf',
          displayName: 'BACKUP_CF',
          nickname: 'backup-cf',
          kind: 'removable-volume',
          online: false,
          firstSeenAt: '2025-11-02T14:00:00.000Z',
          lastSeenAt: '2026-07-12T18:30:00.000Z',
          sessionCount: 12,
          lastSessionStatus: 'completed',
          verifiedMediaCount: 4_218,
          verifiedBytes: 198_000_000_000,
          identityConfidence: 'exact',
        },
      ],
    }),
    setSourceNickname: async () => ({ ok: true, nickname: null }),
    registerSource: async () => ({ ok: true, sourceId: 'detected-new', nickname: null }),
    countSourceMedia: async ({ detectedSourceId }) => {
      const total = mediaByDay.reduce(
        (sum, day) => ({
          photos: sum.photos + day.photos,
          videos: sum.videos + day.videos,
          other: sum.other + day.other,
          bytes: sum.bytes + day.bytes,
        }),
        { photos: 0, videos: 0, other: 0, bytes: 0 },
      );
      const scaled =
        detectedSourceId === 'detected-new'
          ? {
              photos: 156,
              videos: 12,
              other: 0,
              bytes: 8_400_000_000,
              byDay: [{ day: '2026-07-20', photos: 156, videos: 12, other: 0, bytes: 8_400_000_000 }],
            }
          : { ...total, byDay: mediaByDay };
      return {
        ok: true,
        total: scaled.photos + scaled.videos + scaled.other,
        photos: scaled.photos,
        videos: scaled.videos,
        other: scaled.other,
        bytes: scaled.bytes,
        byDay: scaled.byDay,
      };
    },
    getSettings: async () => ({ ok: true, settings }),
    updateSettings: async (request) => ({
      ok: true,
      settings: {
        ...settings,
        ...request,
        destination: settings.destination,
        verifyCopies: true as const,
      },
    }),
    resetDestinationToDefault: async () => ({ ok: true, settings }),
    validateTemplate: async () => ({
      ok: true,
      preview: '2026/2026-07-19/canon-r5/IMG_4521.CR3',
    }),
    review: async () => ({ ok: true, value: reviewValue }),
    start: async () => {
      progressListener?.(progressSession);
      return { ok: true, sessionId: progressSession.sessionId };
    },
    cancel: async () => ({ ok: true }),
    listRecoverableSessions: async () => ({ ok: true, sessions: [] }),
    claimSession: async () => ({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'demo', retryable: false },
    }),
    recoverSession: async () => ({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'demo', retryable: false },
    }),
    getSession: async () => ({ ok: true, session: progressSession }),
    listSummaryDays: async () => ({
      ok: true,
      days: [
        {
          captureDay: '2026-07-19',
          photoCount: 1240,
          videoCount: 86,
          unknownCount: 0,
          totalSizeBytes: 54_000_000_000,
        },
        {
          captureDay: '2026-07-18',
          photoCount: 980,
          videoCount: 62,
          unknownCount: 0,
          totalSizeBytes: 42_000_000_000,
        },
      ],
    }),
    listSummaryMediaByDay: async () => ({ ok: true, items: [], nextCursor: null }),
    getThumbnail: async () => ({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'demo', retryable: false },
    }),
    retryThumbnail: async () => ({ ok: true }),
    copyText: async () => ({ ok: true }),
    onProgress: (listener) => {
      progressListener = listener;
      return noopUnsub;
    },
    onSummaryInvalidated: () => noopUnsub,
    onDetectedSourcesChanged: () => noopUnsub,
  };
}

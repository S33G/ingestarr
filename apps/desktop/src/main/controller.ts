import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  AppSettings,
  CancelIngestRequest,
  CancelIngestResponse,
  ClaimSessionRequest,
  ClaimSessionResponse,
  ChooseFolderResponse,
  CountSourceMediaResponse,
  DetectedSourceListResponse,
  GetSessionResponse,
  GetSettingsResponse,
  IngestReview,
  IpcError,
  ListRecoverableSessionsResponse,
  ListKnownSourcesResponse,
  KnownSourceSummary,
  ListSummaryDaysRequest,
  ListSummaryDaysResponse,
  ListSummaryMediaRequest,
  ListSummaryMediaResponse,
  ReviewIngestRequest,
  ReviewIngestResponse,
  RetryThumbnailRequest,
  RetryThumbnailResponse,
  RendererSettings,
  RecoverSessionRequest,
  RecoverSessionResponse,
  RegisterSourceRequest,
  RegisterSourceResponse,
  ResetDestinationToDefaultResponse,
  SetSourceNicknameRequest,
  SetSourceNicknameResponse,
  UpdateSettingsRequest,
  UpdateSettingsResponse,
  ValidateTemplateRequest,
  ValidateTemplateResponse,
  SessionSnapshot,
  StartIngestRequest,
  StartIngestResponse,
  SummaryDay,
  SummaryMedia,
} from '@ingestarr/shared-types';

import { CapabilityError, CapabilityStore, type CapabilityKind } from './security';
import type { DetectedSourceRegistry, RegisteredDetectedSource } from './detected-sources';
import { ThumbnailCapabilityStore, ThumbnailRetryCapabilityStore } from './thumbnail-capabilities';

type ServiceSummaryMedia = Omit<SummaryMedia, 'thumbnail'> & {
  thumbnail:
    | Extract<SummaryMedia['thumbnail'], { state: 'missing' }>
    | Omit<Extract<SummaryMedia['thumbnail'], { state: 'failed' }>, 'retryCapability'>
    | {
        state: 'ready';
        reference: string;
        mimeType: 'image/webp' | 'image/jpeg';
        width: number;
        height: number;
      };
};

export interface DesktopIngestService {
  review(
    sourcePath: string,
    destinationPath: string,
    detected?: {
      platformVolumeId?: string;
      label: string;
      capacityBytes?: number;
      filesystem?: string;
    },
  ): Promise<Omit<IngestReview, 'reviewId' | 'expiresAt'>>;
  start(
    sourcePath: string,
    destinationPath: string,
    signal: AbortSignal,
    emit: (snapshot: SessionSnapshot) => void,
    detected?: {
      platformVolumeId?: string;
      label: string;
      capacityBytes?: number;
      filesystem?: string;
    },
    sourceDecision?: StartIngestRequest['sourceDecision'],
    includedCaptureDays?: readonly string[],
  ): Promise<{ sessionId: string; completion: Promise<SessionSnapshot> }>;
  getSession(sessionId: string): SessionSnapshot | undefined;
  listRecoverableSessions(): SessionSnapshot[];
  listSummaryDays(request: ListSummaryDaysRequest): SummaryDay[];
  listSummaryMedia(request: ListSummaryMediaRequest): {
    items: ServiceSummaryMedia[];
    nextCursor: string | null;
  };
  readThumbnail(reference: string): Promise<{ mimeType: string; bytes: Uint8Array }>;
  retryThumbnail(copyId: string, variant: 'grid'): boolean;
  listKnownSources(onlinePlatformIds?: readonly string[]): KnownSourceSummary[];
  setSourceNickname(
    sourceId: string,
    nickname: string | null,
  ): Promise<{ nickname: string | null }>;
  resolveKnownSourceForVolume(input: {
    mountPath: string;
    platformVolumeId?: string;
  }): Promise<{ sourceId: string; nickname: string | null } | undefined>;
  countSourceMedia(
    mountPath: string,
    signal?: AbortSignal,
  ): Promise<{
    total: number;
    photos: number;
    videos: number;
    other: number;
    bytes: number;
    byDay: Array<{ day: string; photos: number; videos: number; other: number; bytes: number }>;
  }>;
  registerDetectedSource(
    detected: {
      platformVolumeId?: string;
      label: string;
      kind: 'removable-volume' | 'folder';
      mountPath?: string;
    },
    nickname: string | null,
  ): Promise<{ sourceId: string; nickname: string | null }>;
  getSettings(): AppSettings;
  updateSettings(settings: AppSettings): Promise<AppSettings>;
  validateTemplate(request: ValidateTemplateRequest): {
    valid: boolean;
    preview?: string;
    errors: string[];
  };
  recoverSession(
    sessionId: string,
    sourcePath: string | undefined,
    action: 'resume' | 'cleanup',
    signal: AbortSignal,
    emit: (snapshot: SessionSnapshot) => void,
    confirmSourceMismatch?: boolean,
  ): Promise<SessionSnapshot | undefined>;
  subscribeSummary?(listener: () => void): () => void;
  close(): Promise<void>;
}

interface ReviewGrant {
  id: string;
  windowId: number;
  sourcePath: string;
  destinationPath: string;
  detectedSourceId?: string;
  expiresAtMs: number;
  requiresSourceConfirmation: boolean;
  candidateSourceIds: string[];
}

interface ActiveSession {
  id: string;
  abort: AbortController;
  completion?: Promise<SessionSnapshot>;
}

interface SessionClaim {
  id: string;
  windowId: number;
  sessionId: string;
  expiresAtMs: number;
}

export interface DesktopControllerOptions {
  dialog(windowId: number, kind: CapabilityKind): Promise<string | undefined>;
  service: DesktopIngestService;
  now?: () => number;
  id?: () => string;
  capabilityTtlMs?: number;
  reviewTtlMs?: number;
  claimTtlMs?: number;
  retryCapabilityTtlMs?: number;
  detectedSources?: DetectedSourceRegistry;
  defaultDestinationRoot?: string;
}

function failure(
  code: IpcError['code'],
  message: string,
  retryable: boolean,
): { ok: false; error: IpcError } {
  return { ok: false, error: { code, message, retryable } };
}

function mappedError(error: unknown): { ok: false; error: IpcError } {
  if (error instanceof CapabilityError) {
    return failure(error.code, error.message, true);
  }
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : '';
  if (code === 'SOURCE_UNAVAILABLE' || code === 'ENOENT') {
    return failure('SOURCE_UNAVAILABLE', 'The selected source is no longer available.', true);
  }
  if (code === 'DESTINATION_INVALID' || code === 'EACCES') {
    return failure('DESTINATION_INVALID', 'The selected destination is not writable.', true);
  }
  return failure('INTERNAL_ERROR', 'The operation could not be completed.', true);
}

function safeFilename(value: string | undefined): string | undefined {
  return value?.split(/[\\/]/).at(-1);
}

function safeErrorMessage(code: string): string {
  if (code === 'SOURCE_UNAVAILABLE') return 'The source became unavailable.';
  if (code === 'DESTINATION_INVALID') return 'The destination is no longer writable.';
  if (code === 'INGEST_CANCELLED' || code === 'COPY_CANCELLED') {
    return 'Ingest cancelled. You can return home or choose the folders again.';
  }
  if (code === 'READ_FAILED' || code === 'WRITE_FAILED' || code === 'COPY_FAILED') {
    return 'A media file could not be copied.';
  }
  if (code === 'DESTINATION_COLLISION') return 'A destination file appeared during ingest.';
  return 'The ingest could not be completed.';
}

function safeErrorCode(code: string): string {
  return [
    'SOURCE_UNAVAILABLE',
    'DESTINATION_INVALID',
    'INGEST_CANCELLED',
    'COPY_CANCELLED',
    'READ_FAILED',
    'WRITE_FAILED',
    'COPY_FAILED',
    'DESTINATION_COLLISION',
  ].includes(code)
    ? code
    : 'INGEST_FAILED';
}

function safeSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return {
    ...snapshot,
    phase: snapshot.status[0]?.toUpperCase() + snapshot.status.slice(1),
    ...(safeFilename(snapshot.currentFile) === undefined
      ? { currentFile: undefined }
      : { currentFile: safeFilename(snapshot.currentFile) }),
    errors: snapshot.errors.map((error) => {
      const code = safeErrorCode(error.code);
      return {
        code,
        message: safeErrorMessage(code),
        ...(safeFilename(error.filename) === undefined
          ? {}
          : { filename: safeFilename(error.filename) }),
      };
    }),
  };
}

export class DesktopController {
  readonly #capabilities: CapabilityStore;
  readonly #reviews = new Map<string, ReviewGrant>();
  readonly #active = new Map<number, ActiveSession>();
  readonly #operations = new Set<Promise<SessionSnapshot>>();
  readonly #sessionOwners = new Map<string, number>();
  readonly #claims = new Map<string, SessionClaim>();
  readonly #thumbnailCapabilities: ThumbnailCapabilityStore;
  readonly #thumbnailRetryCapabilities: ThumbnailRetryCapabilityStore;
  readonly #listeners = new Map<number, Set<(snapshot: SessionSnapshot) => void>>();
  readonly #summaryListeners = new Map<number, Set<() => void>>();
  readonly #detectedSourceListeners = new Map<number, Set<() => void>>();
  readonly #unsubscribeSummary?: () => void;
  readonly #service: DesktopIngestService;
  readonly #detectedSources?: DetectedSourceRegistry;
  readonly #dialog: DesktopControllerOptions['dialog'];
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #reviewTtlMs: number;
  readonly #claimTtlMs: number;
  readonly #unsubscribeDetectedSources?: () => void;
  readonly #unsubscribeArrival?: () => void;
  readonly #defaultDestinationRoot?: string;
  // Keyed by canonical mount path: auto-ingests currently running for a hotplugged card, so the
  // same card that fires several detection callbacks in quick succession only ingests once.
  readonly #autoActive = new Map<string, AbortController>();
  #closing: Promise<void> | undefined;

  constructor(options: DesktopControllerOptions) {
    this.#now = options.now ?? Date.now;
    this.#defaultDestinationRoot = options.defaultDestinationRoot;
    this.#id = options.id ?? randomUUID;
    this.#reviewTtlMs = options.reviewTtlMs ?? 5 * 60_000;
    this.#claimTtlMs = options.claimTtlMs ?? 2 * 60_000;
    this.#capabilities = new CapabilityStore({
      now: this.#now,
      ttlMs: options.capabilityTtlMs,
      id: this.#id,
    });
    this.#thumbnailCapabilities = new ThumbnailCapabilityStore({
      now: this.#now,
      id: this.#id,
    });
    this.#thumbnailRetryCapabilities = new ThumbnailRetryCapabilityStore({
      now: this.#now,
      id: this.#id,
      ttlMs: options.retryCapabilityTtlMs,
    });
    this.#service = options.service;
    this.#detectedSources = options.detectedSources;
    // Hands-free ingest: when a card is hotplugged and auto-ingest is enabled, start copying to
    // the configured destination with no prompts. Optional-chained so mocks without `onArrival`
    // in tests are unaffected.
    this.#unsubscribeArrival = options.detectedSources?.onArrival?.((source) => {
      void this.#autoIngest(source);
    });
    this.#unsubscribeDetectedSources = options.detectedSources?.subscribe(() => {
      for (const listeners of this.#detectedSourceListeners.values()) {
        for (const listener of listeners) {
          try {
            listener();
          } catch {
            // A closed or failing renderer cannot affect source detection.
          }
        }
      }
    });
    this.#unsubscribeSummary = options.service.subscribeSummary?.(() => {
      for (const listeners of this.#summaryListeners.values()) {
        for (const listener of listeners) {
          try {
            listener();
          } catch {
            // Renderer notification failures are isolated from thumbnail persistence.
          }
        }
      }
    });
    this.#dialog = options.dialog;
  }

  async chooseFolder(windowId: number, kind: CapabilityKind): Promise<ChooseFolderResponse> {
    const selectedPath = await this.#dialog(windowId, kind);
    if (selectedPath === undefined) return { status: 'cancelled' };
    const label = path.basename(selectedPath) || 'Selected folder';
    const issued = this.#capabilities.issue({ windowId, kind, path: selectedPath, label });
    return {
      status: 'selected',
      capabilityId: issued.id,
      label,
      displayPath: `…/${label}`,
      expiresAt: issued.expiresAt,
    };
  }

  getSettings(windowId: number): GetSettingsResponse {
    void windowId;
    try {
      return { ok: true, settings: this.#projectSettings(this.#service.getSettings()) };
    } catch (error) {
      return mappedError(error);
    }
  }

  async updateSettings(
    windowId: number,
    request: UpdateSettingsRequest,
  ): Promise<UpdateSettingsResponse> {
    try {
      const current = this.#service.getSettings();
      const destinationRoot =
        request.destinationCapabilityId === undefined
          ? current.destinationRoot
          : this.#capabilities.resolve(request.destinationCapabilityId, windowId, 'destination')
              .path;
      const settings = await this.#service.updateSettings({
        ...current,
        destinationRoot,
        verifyCopies: true,
        allowedExtensions: request.allowedExtensions,
        excludedPathPatterns: request.excludedPathPatterns,
        destinationTemplate: request.destinationTemplate,
        copyConcurrency: request.copyConcurrency,
        groupByNicknameInDestination: request.groupByNicknameInDestination,
        perCardEventLog: request.perCardEventLog,
        autoIngest: request.autoIngest,
        thumbnail: request.thumbnail,
      });
      if (request.destinationCapabilityId !== undefined) {
        this.#capabilities.consume(request.destinationCapabilityId, windowId, 'destination');
      }
      return { ok: true, settings: this.#projectSettings(settings) };
    } catch (error) {
      return mappedError(error);
    }
  }

  // Lets Settings offer a one-click "reset to system default" without routing through the
  // folder-picker dialog: the default (e.g. Documents/Ingestarr) was already created and
  // validated by the app itself at startup, so no capability grant is needed to trust it.
  async resetDestinationToDefault(windowId: number): Promise<ResetDestinationToDefaultResponse> {
    void windowId;
    if (this.#defaultDestinationRoot === undefined) {
      return failure(
        'INVALID_REQUEST',
        'No system default destination is configured for this platform.',
        false,
      );
    }
    try {
      const current = this.#service.getSettings();
      const settings = await this.#service.updateSettings({
        ...current,
        destinationRoot: this.#defaultDestinationRoot,
      });
      return { ok: true, settings: this.#projectSettings(settings) };
    } catch (error) {
      return mappedError(error);
    }
  }

  validateTemplate(_windowId: number, request: ValidateTemplateRequest): ValidateTemplateResponse {
    const result = this.#service.validateTemplate(request);
    return result.valid && result.preview !== undefined
      ? { ok: true, preview: result.preview }
      : {
          ok: false,
          errors: result.errors.length === 0 ? ['Template is invalid.'] : result.errors,
        };
  }

  listDetectedSources(windowId: number): DetectedSourceListResponse {
    if (this.#detectedSources === undefined) return { ok: true, sources: [] };
    return {
      ok: true,
      sources: this.#detectedSources.list().map((source) => {
        const issued = this.#capabilities.issue({
          windowId,
          kind: 'source',
          path: source.canonicalMountPath,
          label: source.label,
          provenance: { type: 'detected-source', detectedSourceId: source.id },
        });
        return {
          id: source.id,
          ...(source.platformVolumeId === undefined
            ? {}
            : { strongPlatformId: source.platformVolumeId }),
          capabilityId: issued.id,
          label: source.label,
          kind: source.kind,
          online: source.online,
          identityConfidence: source.platformVolumeId === undefined ? 'low' : 'high',
          reasons: [
            source.platformVolumeId === undefined
              ? 'fallback-identity-pending-review'
              : 'strong-platform-id-observed',
          ],
          requiresConfirmation: true,
          expiresAt: issued.expiresAt,
          ...(source.facts.deviceVendor === undefined
            ? {}
            : { deviceVendor: source.facts.deviceVendor }),
          ...(source.facts.deviceModel === undefined
            ? {}
            : { deviceModel: source.facts.deviceModel }),
          ...(source.facts.fsType === undefined ? {} : { fsType: source.facts.fsType }),
          ...(source.facts.capacityBytes === undefined
            ? {}
            : { capacityBytes: source.facts.capacityBytes }),
          ...(source.knownSourceId === undefined ? {} : { knownSourceId: source.knownSourceId }),
          ...(source.knownNickname === undefined ? {} : { knownNickname: source.knownNickname }),
        };
      }),
    };
  }

  async countSourceMedia(
    windowId: number,
    request: { detectedSourceId: string },
  ): Promise<CountSourceMediaResponse> {
    void windowId;
    const detected = this.#detectedSources
      ?.list()
      .find((source) => source.id === request.detectedSourceId);
    if (detected === undefined || !detected.online) {
      return failure(
        'SOURCE_UNAVAILABLE',
        'The card is not currently connected, so its media cannot be counted.',
        true,
      );
    }
    try {
      const counts = await this.#service.countSourceMedia(detected.canonicalMountPath);
      return { ok: true, ...counts };
    } catch (error) {
      return mappedError(error);
    }
  }

  listKnownSources(windowId: number): ListKnownSourcesResponse {
    void windowId;
    try {
      const onlinePlatformIds = this.#detectedSources
        ?.list()
        .filter((source) => source.online && source.platformVolumeId !== undefined)
        .map((source) => source.platformVolumeId as string);
      return { ok: true, sources: this.#service.listKnownSources(onlinePlatformIds) };
    } catch (error) {
      return mappedError(error);
    }
  }

  async setSourceNickname(
    windowId: number,
    request: SetSourceNicknameRequest,
  ): Promise<SetSourceNicknameResponse> {
    void windowId;
    try {
      const result = await this.#service.setSourceNickname(request.sourceId, request.nickname);
      return { ok: true, nickname: result.nickname };
    } catch (error) {
      return mappedError(error);
    }
  }

  async registerDetectedSource(
    windowId: number,
    request: RegisterSourceRequest,
  ): Promise<RegisterSourceResponse> {
    void windowId;
    const detected = this.#detectedSources
      ?.list()
      .find((source) => source.id === request.detectedSourceId);
    if (detected === undefined) {
      return failure('SOURCE_UNAVAILABLE', 'The detected source is no longer available.', true);
    }
    try {
      const result = await this.#service.registerDetectedSource(
        {
          label: detected.label,
          kind: detected.kind,
          mountPath: detected.canonicalMountPath,
          ...(detected.platformVolumeId === undefined
            ? {}
            : { platformVolumeId: detected.platformVolumeId }),
        },
        request.nickname,
      );
      // The card now has a known source (and an on-card identity marker). Re-resolve the detected
      // volume's identity right away so the UI collapses it into that single known source instead
      // of leaving a stale duplicate "new card" until the next poll.
      await this.#detectedSources?.refreshIdentity(request.detectedSourceId);
      return { ok: true, sourceId: result.sourceId, nickname: result.nickname };
    } catch (error) {
      return mappedError(error);
    }
  }

  resolveDetectedCapability(id: string, windowId: number): { path: string; label: string } {
    const capability = this.#capabilities.resolve(id, windowId, 'source');
    const online = this.#detectedSources
      ?.list()
      .some(
        (source) =>
          source.online &&
          capability.provenance?.type === 'detected-source' &&
          source.id === capability.provenance.detectedSourceId,
      );
    if (online !== true) {
      const error = new Error('Detected source is offline') as Error & { code: string };
      error.code = 'SOURCE_UNAVAILABLE';
      throw error;
    }
    return { path: capability.path, label: capability.label };
  }

  async review(windowId: number, request: ReviewIngestRequest): Promise<ReviewIngestResponse> {
    try {
      const source = this.#capabilities.resolve(request.sourceCapabilityId, windowId, 'source');
      // A supplied capability is a manual destination override; otherwise fall back to the
      // destination configured in Settings (the same path #autoIngest trusts), so "Start ingest"
      // works with zero clicks when a destination is already configured.
      let destinationPath: string;
      if (request.destinationCapabilityId === undefined) {
        const configured = this.#service.getSettings().destinationRoot;
        if (configured === null) {
          return failure(
            'DESTINATION_INVALID',
            'No destination is configured. Choose a destination or set one in Settings.',
            false,
          );
        }
        destinationPath = configured;
      } else {
        destinationPath = this.#capabilities.resolve(
          request.destinationCapabilityId,
          windowId,
          'destination',
        ).path;
      }
      if (source.provenance?.type === 'detected-source') {
        this.resolveDetectedCapability(source.id, windowId);
      }
      const detected = this.#detectedContext(source.path);
      const estimate =
        detected === undefined
          ? await this.#service.review(source.path, destinationPath)
          : await this.#service.review(source.path, destinationPath, detected);
      const id = this.#id();
      const expiresAtMs = this.#now() + this.#reviewTtlMs;
      // Review is a repeatable, read-only inspection step (the UI lets a user re-review with a
      // freshly chosen destination while keeping the same source via "Choose destination
      // again"), so the source/destination capabilities are intentionally left resolvable rather
      // than consumed here. They still expire on their own TTL, and starting the ingest itself
      // is guarded separately by the one-shot review grant below.
      this.#reviews.set(id, {
        id,
        windowId,
        sourcePath: source.path,
        destinationPath,
        ...(source.provenance?.type === 'detected-source'
          ? { detectedSourceId: source.provenance.detectedSourceId }
          : {}),
        expiresAtMs,
        requiresSourceConfirmation: estimate.source.requiresConfirmation === true,
        candidateSourceIds:
          estimate.source.candidates?.map((candidate) => candidate.sourceId) ?? [],
      });
      return {
        ok: true,
        value: { ...estimate, reviewId: id, expiresAt: new Date(expiresAtMs).toISOString() },
      };
    } catch (error) {
      return mappedError(error);
    }
  }

  async start(windowId: number, request: StartIngestRequest): Promise<StartIngestResponse> {
    if (this.#active.has(windowId)) {
      return failure('INGEST_ACTIVE', 'An ingest is already active in this window.', false);
    }
    const review = this.#reviews.get(request.reviewId);
    if (review === undefined || review.windowId !== windowId || review.expiresAtMs < this.#now()) {
      this.#reviews.delete(request.reviewId);
      return failure('REVIEW_EXPIRED', 'The review has expired. Review the folders again.', true);
    }
    try {
      if (review.requiresSourceConfirmation && request.sourceDecision === undefined) {
        return failure(
          'INVALID_REQUEST',
          'Confirm whether this is an existing or new source before starting.',
          false,
        );
      }
      const selectedSourceId =
        request.sourceDecision?.action === 'existing' ? request.sourceDecision.sourceId : undefined;
      if (selectedSourceId !== undefined && !review.candidateSourceIds.includes(selectedSourceId)) {
        return failure('INVALID_REQUEST', 'The selected source candidate is invalid.', false);
      }
      if (
        review.detectedSourceId !== undefined &&
        !this.#detectedSources
          ?.list()
          .some((source) => source.id === review.detectedSourceId && source.online)
      ) {
        const error = new Error('Detected source is offline') as Error & { code: string };
        error.code = 'SOURCE_UNAVAILABLE';
        throw error;
      }
      const abort = new AbortController();
      const pendingId = `pending:${review.id}`;
      this.#active.set(windowId, { id: pendingId, abort });
      const detected = this.#detectedContext(review.sourcePath);
      const handle =
        detected === undefined &&
        request.sourceDecision === undefined &&
        request.includedCaptureDays === undefined
          ? await this.#service.start(
              review.sourcePath,
              review.destinationPath,
              abort.signal,
              (snapshot) => this.#emit(windowId, snapshot),
            )
          : await this.#service.start(
              review.sourcePath,
              review.destinationPath,
              abort.signal,
              (snapshot) => this.#emit(windowId, snapshot),
              detected,
              request.sourceDecision,
              request.includedCaptureDays,
            );
      this.#reviews.delete(review.id);
      const completion = handle.completion.finally(() => this.#operations.delete(completion));
      this.#operations.add(completion);
      this.#sessionOwners.set(handle.sessionId, windowId);
      this.#active.set(windowId, { id: handle.sessionId, abort, completion });
      void completion.then(
        (snapshot) => {
          this.#emit(windowId, snapshot);
          if (this.#active.get(windowId)?.id === handle.sessionId) this.#active.delete(windowId);
        },
        () => {
          if (this.#active.get(windowId)?.id === handle.sessionId) this.#active.delete(windowId);
        },
      );
      return { ok: true, sessionId: handle.sessionId };
    } catch (error) {
      this.#active.delete(windowId);
      return mappedError(error);
    }
  }

  async cancel(windowId: number, request: CancelIngestRequest): Promise<CancelIngestResponse> {
    const active = this.#active.get(windowId);
    if (active === undefined || active.id !== request.sessionId) {
      return failure('SESSION_NOT_FOUND', 'No matching active ingest was found.', false);
    }
    active.abort.abort();
    return { ok: true };
  }

  getSession(windowId: number, sessionId: string): GetSessionResponse {
    if (this.#sessionOwners.get(sessionId) !== windowId) {
      return failure('SESSION_NOT_FOUND', 'The ingest session was not found.', false);
    }
    const session = this.#service.getSession(sessionId);
    return session === undefined
      ? failure('SESSION_NOT_FOUND', 'The ingest session was not found.', false)
      : { ok: true, session: safeSnapshot(session) };
  }

  listRecoverableSessions(windowId: number): ListRecoverableSessionsResponse {
    try {
      const sessions = this.#service
        .listRecoverableSessions()
        .filter((session) => !this.#sessionOwners.has(session.sessionId))
        .map((session) => {
          const projected = safeSnapshot(session);
          const claimCapabilityId = this.#id();
          const expiresAtMs = this.#now() + this.#claimTtlMs;
          this.#claims.set(claimCapabilityId, {
            id: claimCapabilityId,
            windowId,
            sessionId: session.sessionId,
            expiresAtMs,
          });
          return {
            claimCapabilityId,
            expiresAt: new Date(expiresAtMs).toISOString(),
            status: projected.status as Exclude<SessionSnapshot['status'], 'completed'>,
            phase: projected.phase,
            totalFiles: projected.totalFiles,
            completedFiles: projected.completedFiles,
            skippedFiles: projected.skippedFiles,
            failedFiles: projected.failedFiles,
            startedAt: projected.startedAt,
            updatedAt: projected.updatedAt,
            ...(projected.errors[0] === undefined
              ? {}
              : {
                  error: {
                    code: projected.errors[0].code,
                    message: projected.errors[0].message,
                  },
                }),
          };
        });
      return { ok: true, sessions };
    } catch (error) {
      return mappedError(error);
    }
  }

  claimSession(windowId: number, request: ClaimSessionRequest): ClaimSessionResponse {
    const claim = this.#claims.get(request.claimCapabilityId);
    if (claim === undefined) {
      return failure('CAPABILITY_INVALID', 'Session claim capability is invalid.', false);
    }
    if (claim.expiresAtMs < this.#now()) {
      this.#claims.delete(request.claimCapabilityId);
      return failure('CAPABILITY_EXPIRED', 'Session claim capability has expired.', true);
    }
    if (claim.windowId !== windowId || this.#sessionOwners.has(claim.sessionId)) {
      return failure('CAPABILITY_INVALID', 'Session claim capability scope is invalid.', false);
    }
    this.#claims.delete(request.claimCapabilityId);
    try {
      const session = this.#service.getSession(claim.sessionId);
      if (session === undefined) {
        return failure('SESSION_NOT_FOUND', 'The ingest session was not found.', false);
      }
      this.#sessionOwners.set(claim.sessionId, windowId);
      return { ok: true, session: safeSnapshot(session) };
    } catch (error) {
      return mappedError(error);
    }
  }

  async recoverSession(
    windowId: number,
    request: RecoverSessionRequest,
  ): Promise<RecoverSessionResponse> {
    const claim = this.#claims.get(request.claimCapabilityId);
    if (claim === undefined) {
      return failure('CAPABILITY_INVALID', 'Session recovery capability is invalid.', false);
    }
    if (claim.expiresAtMs < this.#now()) {
      this.#claims.delete(request.claimCapabilityId);
      return failure('CAPABILITY_EXPIRED', 'Session recovery capability has expired.', true);
    }
    if (claim.windowId !== windowId || this.#sessionOwners.has(claim.sessionId)) {
      return failure('CAPABILITY_INVALID', 'Session recovery capability scope is invalid.', false);
    }
    this.#claims.delete(request.claimCapabilityId);
    try {
      const sourcePath =
        request.sourceCapabilityId === undefined
          ? undefined
          : this.#capabilities.resolve(request.sourceCapabilityId, windowId, 'source').path;
      const abort = new AbortController();
      this.#active.set(windowId, { id: claim.sessionId, abort });
      this.#sessionOwners.set(claim.sessionId, windowId);
      const session = await this.#service.recoverSession(
        claim.sessionId,
        sourcePath,
        request.action,
        abort.signal,
        (snapshot) => this.#emit(windowId, snapshot),
        request.confirmSourceMismatch,
      );
      this.#active.delete(windowId);
      return request.action === 'cleanup'
        ? { ok: true, result: { action: 'cleanup' } }
        : session === undefined
          ? failure('SESSION_NOT_FOUND', 'The ingest session was not found.', false)
          : { ok: true, result: { action: 'resume', session: safeSnapshot(session) } };
    } catch (error) {
      this.#active.delete(windowId);
      return mappedError(error);
    }
  }

  listSummaryDays(_windowId: number, request: ListSummaryDaysRequest): ListSummaryDaysResponse {
    try {
      return { ok: true, days: this.#service.listSummaryDays(request) };
    } catch (error) {
      return mappedError(error);
    }
  }

  listSummaryMedia(windowId: number, request: ListSummaryMediaRequest): ListSummaryMediaResponse {
    try {
      const result = this.#service.listSummaryMedia(request);
      return {
        ok: true,
        nextCursor: result.nextCursor,
        items: result.items.map((item): SummaryMedia => ({
          ...item,
          thumbnail:
            item.thumbnail.state === 'ready'
              ? {
                  state: 'ready',
                  token: this.#thumbnailCapabilities.issue(windowId, item.thumbnail.reference)
                    .token,
                  mimeType: item.thumbnail.mimeType,
                  width: item.thumbnail.width,
                  height: item.thumbnail.height,
                }
              : item.thumbnail.state === 'failed'
                ? {
                    ...item.thumbnail,
                    retryCapability: this.#thumbnailRetryCapabilities.issue(windowId, {
                      copyId: item.copyId,
                      variant: 'grid',
                    }),
                  }
                : item.thumbnail,
        })),
      };
    } catch (error) {
      return mappedError(error);
    }
  }

  async getThumbnail(
    windowId: number,
    token: string,
  ): Promise<
    | { ok: true; mimeType: 'image/webp' | 'image/jpeg'; base64: string }
    | { ok: false; error: IpcError }
  > {
    try {
      const reference = this.#thumbnailCapabilities.consume(token, windowId);
      const result = await this.#service.readThumbnail(reference);
      if (result.mimeType !== 'image/webp' && result.mimeType !== 'image/jpeg') {
        throw new Error('Unsupported thumbnail MIME type');
      }
      return {
        ok: true,
        mimeType: result.mimeType,
        base64: Buffer.from(result.bytes).toString('base64'),
      };
    } catch {
      return failure('CAPABILITY_INVALID', 'Thumbnail capability is invalid.', false);
    }
  }

  retryThumbnail(windowId: number, request: RetryThumbnailRequest): RetryThumbnailResponse {
    try {
      const retry = this.#thumbnailRetryCapabilities.consume(request.capability, windowId);
      return this.#service.retryThumbnail(retry.copyId, retry.variant)
        ? { ok: true }
        : failure('INVALID_REQUEST', 'Thumbnail retry is unavailable.', false);
    } catch (error) {
      return mappedError(error);
    }
  }

  subscribe(windowId: number, listener: (snapshot: SessionSnapshot) => void): () => void {
    const listeners = this.#listeners.get(windowId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(windowId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(windowId);
    };
  }

  listenerCount(windowId: number): number {
    return this.#listeners.get(windowId)?.size ?? 0;
  }

  subscribeSummary(windowId: number, listener: () => void): () => void {
    const listeners = this.#summaryListeners.get(windowId) ?? new Set();
    listeners.add(listener);
    this.#summaryListeners.set(windowId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#summaryListeners.delete(windowId);
    };
  }

  subscribeDetectedSources(windowId: number, listener: () => void): () => void {
    const listeners = this.#detectedSourceListeners.get(windowId) ?? new Set();
    listeners.add(listener);
    this.#detectedSourceListeners.set(windowId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#detectedSourceListeners.delete(windowId);
    };
  }

  destroyWindow(windowId: number): void {
    this.#active.get(windowId)?.abort.abort();
    this.#active.delete(windowId);
    this.#listeners.delete(windowId);
    this.#summaryListeners.delete(windowId);
    this.#detectedSourceListeners.delete(windowId);
    this.#capabilities.revokeWindow(windowId);
    this.#thumbnailCapabilities.revokeWindow(windowId);
    this.#thumbnailRetryCapabilities.revokeWindow(windowId);
    for (const [sessionId, owner] of this.#sessionOwners) {
      if (owner === windowId) this.#sessionOwners.delete(sessionId);
    }
    for (const [claimId, claim] of this.#claims) {
      if (claim.windowId === windowId) this.#claims.delete(claimId);
    }
    for (const [id, review] of this.#reviews) {
      if (review.windowId === windowId) this.#reviews.delete(id);
    }
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      for (const active of this.#active.values()) active.abort.abort();
      for (const abort of this.#autoActive.values()) abort.abort();
      await Promise.allSettled([...this.#operations]);
      this.#active.clear();
      this.#autoActive.clear();
      this.#listeners.clear();
      this.#summaryListeners.clear();
      this.#detectedSourceListeners.clear();
      this.#claims.clear();
      this.#thumbnailCapabilities.clear();
      this.#thumbnailRetryCapabilities.clear();
      this.#unsubscribeSummary?.();
      this.#unsubscribeDetectedSources?.();
      this.#unsubscribeArrival?.();
      await this.#service.close();
    })();
    return this.#closing;
  }

  #emit(windowId: number, snapshot: SessionSnapshot): void {
    const projected = safeSnapshot(snapshot);
    for (const listener of this.#listeners.get(windowId) ?? []) listener(projected);
  }

  // Broadcasts to every window. Auto-ingest isn't owned by a particular window (it's triggered by
  // hardware, not a click), so its progress must reach whichever window(s) are open.
  #emitAll(snapshot: SessionSnapshot): void {
    const projected = safeSnapshot(snapshot);
    for (const listeners of this.#listeners.values()) {
      for (const listener of listeners) listener(projected);
    }
  }

  // Starts an unattended ingest for a freshly hotplugged card when auto-ingest is enabled. Safe
  // to call for any arrival: it no-ops unless auto-ingest is on, a destination is configured, the
  // volume is an online removable card, and it isn't already being auto-ingested. Identity is
  // resolved by the service itself (on-card marker → strong id → new), so no prompts are needed.
  async #autoIngest(source: RegisteredDetectedSource): Promise<void> {
    if (source.kind !== 'removable-volume' || !source.online) return;
    if (this.#autoActive.has(source.canonicalMountPath)) return;
    // Don't fight a manual ingest, and only run one automatic ingest at a time — a burst of
    // inserted cards is handled one after another rather than all at once.
    if (this.#active.size > 0 || this.#autoActive.size > 0) return;
    let settings: AppSettings;
    try {
      settings = this.#service.getSettings();
    } catch {
      return;
    }
    if (!settings.autoIngest || settings.destinationRoot === null) return;
    const abort = new AbortController();
    this.#autoActive.set(source.canonicalMountPath, abort);
    try {
      const detected = this.#detectedContext(source.canonicalMountPath);
      const handle = await this.#service.start(
        source.canonicalMountPath,
        settings.destinationRoot,
        abort.signal,
        (snapshot) => this.#emitAll(snapshot),
        detected,
      );
      const completion = handle.completion.finally(() => {
        this.#autoActive.delete(source.canonicalMountPath);
        this.#operations.delete(completion);
      });
      this.#operations.add(completion);
      this.#sessionOwners.set(handle.sessionId, 0);
      void completion.then(
        (snapshot) => this.#emitAll(snapshot),
        () => undefined,
      );
    } catch {
      this.#autoActive.delete(source.canonicalMountPath);
    }
  }

  #projectSettings(settings: AppSettings): RendererSettings {
    return {
      destination: {
        configured: settings.destinationRoot !== null,
        ...(settings.destinationRoot === null
          ? {}
          : {
              label: path.basename(settings.destinationRoot) || 'Selected folder',
              path: settings.destinationRoot,
            }),
        ...(this.#defaultDestinationRoot === undefined
          ? {}
          : { defaultPath: this.#defaultDestinationRoot }),
      },
      allowedExtensions: settings.allowedExtensions,
      excludedPathPatterns: settings.excludedPathPatterns,
      destinationTemplate: settings.destinationTemplate,
      copyConcurrency: settings.copyConcurrency,
      groupByNicknameInDestination: settings.groupByNicknameInDestination,
      perCardEventLog: settings.perCardEventLog,
      autoIngest: settings.autoIngest,
      thumbnail: settings.thumbnail,
      verifyCopies: true,
    };
  }

  #detectedContext(pathValue: string):
    | {
        platformVolumeId?: string;
        label: string;
        capacityBytes?: number;
        filesystem?: string;
      }
    | undefined {
    const detected = this.#detectedSources
      ?.list()
      .find((source) => source.online && source.canonicalMountPath === pathValue);
    if (detected === undefined) return undefined;
    return {
      label: detected.label,
      ...(detected.platformVolumeId === undefined
        ? {}
        : { platformVolumeId: detected.platformVolumeId }),
      ...(detected.facts.capacityBytes === undefined
        ? {}
        : { capacityBytes: detected.facts.capacityBytes }),
      ...(detected.facts.fsType === undefined ? {} : { filesystem: detected.facts.fsType }),
    };
  }
}

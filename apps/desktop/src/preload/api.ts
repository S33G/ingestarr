import {
  cancelIngestRequestSchema,
  cancelIngestResponseSchema,
  copyTextRequestSchema,
  copyTextResponseSchema,
  countSourceMediaRequestSchema,
  countSourceMediaResponseSchema,
  claimSessionRequestSchema,
  claimSessionResponseSchema,
  chooseFolderResponseSchema,
  detectedSourceListResponseSchema,
  detectedSourcesChangedEventSchema,
  getSettingsResponseSchema,
  getSessionRequestSchema,
  getSessionResponseSchema,
  healthResponseSchema,
  healthValidatedRequestSchema,
  healthValidatedResponseSchema,
  ipcChannels,
  listRecoverableSessionsResponseSchema,
  listKnownSourcesResponseSchema,
  listSummaryDaysRequestSchema,
  listSummaryDaysResponseSchema,
  listSummaryMediaRequestSchema,
  listSummaryMediaResponseSchema,
  getThumbnailRequestSchema,
  getThumbnailResponseSchema,
  reviewIngestRequestSchema,
  reviewIngestResponseSchema,
  retryThumbnailRequestSchema,
  retryThumbnailResponseSchema,
  recoverSessionRequestSchema,
  recoverSessionResponseSchema,
  registerSourceRequestSchema,
  registerSourceResponseSchema,
  setSourceNicknameRequestSchema,
  setSourceNicknameResponseSchema,
  updateSettingsRequestSchema,
  updateSettingsResponseSchema,
  resetDestinationToDefaultRequestSchema,
  resetDestinationToDefaultResponseSchema,
  validateTemplateRequestSchema,
  validateTemplateResponseSchema,
  sessionProgressEventSchema,
  startIngestRequestSchema,
  startIngestResponseSchema,
  summaryInvalidatedEventSchema,
  type CancelIngestRequest,
  type CancelIngestResponse,
  type CopyTextResponse,
  type ChooseFolderResponse,
  type DetectedSourceListResponse,
  type ClaimSessionRequest,
  type ClaimSessionResponse,
  type GetSessionRequest,
  type GetSessionResponse,
  type HealthResponse,
  type GetSettingsResponse,
  type ListRecoverableSessionsResponse,
  type ListKnownSourcesResponse,
  type ListSummaryDaysRequest,
  type ListSummaryDaysResponse,
  type ListSummaryMediaRequest,
  type ListSummaryMediaResponse,
  type GetThumbnailResponse,
  type ReviewIngestRequest,
  type ReviewIngestResponse,
  type RetryThumbnailRequest,
  type RetryThumbnailResponse,
  type RecoverSessionRequest,
  type RecoverSessionResponse,
  type RegisterSourceRequest,
  type RegisterSourceResponse,
  type CountSourceMediaRequest,
  type CountSourceMediaResponse,
  type SetSourceNicknameRequest,
  type SetSourceNicknameResponse,
  type UpdateSettingsRequest,
  type UpdateSettingsResponse,
  type ResetDestinationToDefaultResponse,
  type ValidateTemplateRequest,
  type ValidateTemplateResponse,
  type SessionSnapshot,
  type StartIngestRequest,
  type StartIngestResponse,
} from '@ingestarr/shared-types';

export type Invoke = (channel: string, payload: unknown) => Promise<unknown>;
export type On = (channel: string, listener: (event: unknown, payload: unknown) => void) => void;
export type RemoveListener = (
  channel: string,
  listener: (event: unknown, payload: unknown) => void,
) => void;

export interface DesktopApi {
  health(): Promise<HealthResponse>;
  chooseSourceFolder(): Promise<ChooseFolderResponse>;
  chooseDestinationFolder(): Promise<ChooseFolderResponse>;
  listDetectedSources(): Promise<DetectedSourceListResponse>;
  listKnownSources(): Promise<ListKnownSourcesResponse>;
  setSourceNickname(request: SetSourceNicknameRequest): Promise<SetSourceNicknameResponse>;
  registerSource(request: RegisterSourceRequest): Promise<RegisterSourceResponse>;
  countSourceMedia(request: CountSourceMediaRequest): Promise<CountSourceMediaResponse>;
  getSettings(): Promise<GetSettingsResponse>;
  updateSettings(request: UpdateSettingsRequest): Promise<UpdateSettingsResponse>;
  resetDestinationToDefault(): Promise<ResetDestinationToDefaultResponse>;
  validateTemplate(request: ValidateTemplateRequest): Promise<ValidateTemplateResponse>;
  review(request: ReviewIngestRequest): Promise<ReviewIngestResponse>;
  start(request: StartIngestRequest): Promise<StartIngestResponse>;
  cancel(request: CancelIngestRequest): Promise<CancelIngestResponse>;
  listRecoverableSessions(): Promise<ListRecoverableSessionsResponse>;
  claimSession(request: ClaimSessionRequest): Promise<ClaimSessionResponse>;
  recoverSession(request: RecoverSessionRequest): Promise<RecoverSessionResponse>;
  getSession(request: GetSessionRequest): Promise<GetSessionResponse>;
  listSummaryDays(request?: ListSummaryDaysRequest): Promise<ListSummaryDaysResponse>;
  listSummaryMediaByDay(request: ListSummaryMediaRequest): Promise<ListSummaryMediaResponse>;
  getThumbnail(token: string): Promise<GetThumbnailResponse>;
  retryThumbnail(request: RetryThumbnailRequest): Promise<RetryThumbnailResponse>;
  copyText(text: string): Promise<CopyTextResponse>;
  onProgress(listener: (session: SessionSnapshot) => void): () => void;
  onSummaryInvalidated(listener: () => void): () => void;
  onDetectedSourcesChanged(listener: () => void): () => void;
}

export function createDesktopApi(
  invoke: Invoke,
  on: On,
  removeListener: RemoveListener,
): DesktopApi {
  return Object.freeze({
    async health(): Promise<HealthResponse> {
      const response = healthResponseSchema.parse(await invoke(ipcChannels.health, {}));
      const handshake = healthValidatedRequestSchema.parse({ checkedAt: response.checkedAt });
      healthValidatedResponseSchema.parse(await invoke(ipcChannels.healthValidated, handshake));
      return response;
    },
    async chooseSourceFolder(): Promise<ChooseFolderResponse> {
      return chooseFolderResponseSchema.parse(await invoke(ipcChannels.chooseSourceFolder, {}));
    },
    async chooseDestinationFolder(): Promise<ChooseFolderResponse> {
      return chooseFolderResponseSchema.parse(
        await invoke(ipcChannels.chooseDestinationFolder, {}),
      );
    },
    async listDetectedSources(): Promise<DetectedSourceListResponse> {
      return detectedSourceListResponseSchema.parse(
        await invoke(ipcChannels.listDetectedSources, {}),
      );
    },
    async listKnownSources(): Promise<ListKnownSourcesResponse> {
      return listKnownSourcesResponseSchema.parse(await invoke(ipcChannels.listKnownSources, {}));
    },
    async setSourceNickname(request: SetSourceNicknameRequest): Promise<SetSourceNicknameResponse> {
      const payload = setSourceNicknameRequestSchema.parse(request);
      return setSourceNicknameResponseSchema.parse(
        await invoke(ipcChannels.setSourceNickname, payload),
      );
    },
    async registerSource(request: RegisterSourceRequest): Promise<RegisterSourceResponse> {
      const payload = registerSourceRequestSchema.parse(request);
      return registerSourceResponseSchema.parse(await invoke(ipcChannels.registerSource, payload));
    },
    async countSourceMedia(request: CountSourceMediaRequest): Promise<CountSourceMediaResponse> {
      const payload = countSourceMediaRequestSchema.parse(request);
      return countSourceMediaResponseSchema.parse(
        await invoke(ipcChannels.countSourceMedia, payload),
      );
    },
    async getSettings(): Promise<GetSettingsResponse> {
      return getSettingsResponseSchema.parse(await invoke(ipcChannels.getSettings, {}));
    },
    async updateSettings(request: UpdateSettingsRequest): Promise<UpdateSettingsResponse> {
      const payload = updateSettingsRequestSchema.parse(request);
      return updateSettingsResponseSchema.parse(await invoke(ipcChannels.updateSettings, payload));
    },
    async resetDestinationToDefault(): Promise<ResetDestinationToDefaultResponse> {
      const payload = resetDestinationToDefaultRequestSchema.parse({});
      return resetDestinationToDefaultResponseSchema.parse(
        await invoke(ipcChannels.resetDestinationToDefault, payload),
      );
    },
    async validateTemplate(request: ValidateTemplateRequest): Promise<ValidateTemplateResponse> {
      const payload = validateTemplateRequestSchema.parse(request);
      return validateTemplateResponseSchema.parse(
        await invoke(ipcChannels.validateTemplate, payload),
      );
    },
    async review(request: ReviewIngestRequest): Promise<ReviewIngestResponse> {
      const payload = reviewIngestRequestSchema.parse(request);
      return reviewIngestResponseSchema.parse(await invoke(ipcChannels.reviewIngest, payload));
    },
    async start(request: StartIngestRequest): Promise<StartIngestResponse> {
      const payload = startIngestRequestSchema.parse(request);
      return startIngestResponseSchema.parse(await invoke(ipcChannels.startIngest, payload));
    },
    async cancel(request: CancelIngestRequest): Promise<CancelIngestResponse> {
      const payload = cancelIngestRequestSchema.parse(request);
      return cancelIngestResponseSchema.parse(await invoke(ipcChannels.cancelIngest, payload));
    },
    async listRecoverableSessions(): Promise<ListRecoverableSessionsResponse> {
      return listRecoverableSessionsResponseSchema.parse(
        await invoke(ipcChannels.listRecoverableSessions, {}),
      );
    },
    async claimSession(request: ClaimSessionRequest): Promise<ClaimSessionResponse> {
      const payload = claimSessionRequestSchema.parse(request);
      return claimSessionResponseSchema.parse(await invoke(ipcChannels.claimSession, payload));
    },
    async recoverSession(request: RecoverSessionRequest): Promise<RecoverSessionResponse> {
      const payload = recoverSessionRequestSchema.parse(request);
      return recoverSessionResponseSchema.parse(await invoke(ipcChannels.recoverSession, payload));
    },
    async getSession(request: GetSessionRequest): Promise<GetSessionResponse> {
      const payload = getSessionRequestSchema.parse(request);
      return getSessionResponseSchema.parse(await invoke(ipcChannels.getSession, payload));
    },
    async listSummaryDays(request: ListSummaryDaysRequest = {}): Promise<ListSummaryDaysResponse> {
      const payload = listSummaryDaysRequestSchema.parse(request);
      return listSummaryDaysResponseSchema.parse(
        await invoke(ipcChannels.listSummaryDays, payload),
      );
    },
    async listSummaryMediaByDay(
      request: ListSummaryMediaRequest,
    ): Promise<ListSummaryMediaResponse> {
      const payload = listSummaryMediaRequestSchema.parse(request);
      return listSummaryMediaResponseSchema.parse(
        await invoke(ipcChannels.listSummaryMediaByDay, payload),
      );
    },
    async getThumbnail(token: string): Promise<GetThumbnailResponse> {
      const payload = getThumbnailRequestSchema.parse({ token });
      return getThumbnailResponseSchema.parse(await invoke(ipcChannels.getThumbnail, payload));
    },
    async retryThumbnail(request: RetryThumbnailRequest): Promise<RetryThumbnailResponse> {
      const payload = retryThumbnailRequestSchema.parse(request);
      return retryThumbnailResponseSchema.parse(await invoke(ipcChannels.retryThumbnail, payload));
    },
    async copyText(text: string): Promise<CopyTextResponse> {
      const payload = copyTextRequestSchema.parse({ text });
      return copyTextResponseSchema.parse(await invoke(ipcChannels.copyText, payload));
    },
    onProgress(listener: (session: SessionSnapshot) => void): () => void {
      const wrapped = (_event: unknown, payload: unknown): void => {
        listener(sessionProgressEventSchema.parse(payload).session);
      };
      on(ipcChannels.sessionProgress, wrapped);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        removeListener(ipcChannels.sessionProgress, wrapped);
      };
    },
    onSummaryInvalidated(listener: () => void): () => void {
      const wrapped = (_event: unknown, payload: unknown): void => {
        summaryInvalidatedEventSchema.parse(payload);
        listener();
      };
      on(ipcChannels.summaryInvalidated, wrapped);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        removeListener(ipcChannels.summaryInvalidated, wrapped);
      };
    },
    onDetectedSourcesChanged(listener: () => void): () => void {
      const wrapped = (_event: unknown, payload: unknown): void => {
        detectedSourcesChangedEventSchema.parse(payload);
        listener();
      };
      on(ipcChannels.detectedSourcesChanged, wrapped);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        removeListener(ipcChannels.detectedSourcesChanged, wrapped);
      };
    },
  });
}

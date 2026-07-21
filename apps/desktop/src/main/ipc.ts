import { app, BrowserWindow, clipboard, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

import {
  cancelIngestRequestSchema,
  cancelIngestResponseSchema,
  copyTextRequestSchema,
  copyTextResponseSchema,
  claimSessionRequestSchema,
  claimSessionResponseSchema,
  chooseFolderRequestSchema,
  chooseFolderResponseSchema,
  detectedSourceListRequestSchema,
  detectedSourceListResponseSchema,
  detectedSourcesChangedEventSchema,
  getSessionRequestSchema,
  getSessionResponseSchema,
  getSettingsRequestSchema,
  getSettingsResponseSchema,
  healthRequestSchema,
  healthResponseSchema,
  healthValidatedRequestSchema,
  healthValidatedResponseSchema,
  ipcChannels,
  listRecoverableSessionsRequestSchema,
  listRecoverableSessionsResponseSchema,
  listKnownSourcesRequestSchema,
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
  countSourceMediaRequestSchema,
  countSourceMediaResponseSchema,
  setSourceNicknameRequestSchema,
  setSourceNicknameResponseSchema,
  sessionProgressEventSchema,
  summaryInvalidatedEventSchema,
  startIngestRequestSchema,
  startIngestResponseSchema,
  updateSettingsRequestSchema,
  updateSettingsResponseSchema,
  resetDestinationToDefaultRequestSchema,
  resetDestinationToDefaultResponseSchema,
  validateTemplateRequestSchema,
  validateTemplateResponseSchema,
  type HealthResponse,
} from '@ingestarr/shared-types';

import type { DesktopController } from './controller';
import { authorizeIpcSender } from './security';

const invalidRequest = {
  ok: false,
  error: { code: 'INVALID_REQUEST', message: 'The request was invalid.', retryable: false },
} as const;

function parseOrThrow<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid IPC request');
  return parsed.data as T;
}

function authorizedWindow(event: IpcMainInvokeEvent, rendererUrl: string): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window === null) throw new Error('Unauthorized IPC sender');
  authorizeIpcSender(event, {
    webContentsId: window.webContents.id,
    rendererUrl,
  });
  return window;
}

export function registerIpcHandlers(
  controller: DesktopController,
  rendererUrl: string,
  options: {
    onHealth?: (windowId: number, health: HealthResponse) => void | Promise<void>;
  } = {},
): void {
  // Keyed by window id, then by the health check's `checkedAt` token, counting how many
  // outstanding `health()` round-trips share that token. A single "last response wins" slot would
  // make overlapping `health()` calls for the same window (e.g. React StrictMode's double effect
  // invocation, or a reload racing a still-pending call) fail the handshake purely due to timing.
  const pendingHealth = new Map<number, Map<string, { health: HealthResponse; count: number }>>();
  ipcMain.handle(ipcChannels.copyText, async (event, payload: unknown) => {
    authorizedWindow(event, rendererUrl);
    const request = parseOrThrow(copyTextRequestSchema, payload);
    clipboard.writeText(request.text);
    return copyTextResponseSchema.parse({ ok: true });
  });
  ipcMain.handle(ipcChannels.health, async (event, payload: unknown): Promise<HealthResponse> => {
    const window = authorizedWindow(event, rendererUrl);
    parseOrThrow(healthRequestSchema, payload);

    const health = healthResponseSchema.parse({
      status: 'ok',
      version: app.getVersion(),
      checkedAt: new Date().toISOString(),
    });
    const forWindow = pendingHealth.get(window.id) ?? new Map();
    const existing = forWindow.get(health.checkedAt);
    forWindow.set(health.checkedAt, { health, count: (existing?.count ?? 0) + 1 });
    pendingHealth.set(window.id, forWindow);
    return health;
  });
  ipcMain.handle(ipcChannels.healthValidated, async (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = parseOrThrow(healthValidatedRequestSchema, payload);
    const forWindow = pendingHealth.get(window.id);
    const pending = forWindow?.get(request.checkedAt);
    if (pending === undefined) throw new Error('Invalid health validation handshake');
    if (pending.count <= 1) forWindow?.delete(request.checkedAt);
    else forWindow?.set(request.checkedAt, { health: pending.health, count: pending.count - 1 });
    await options.onHealth?.(window.id, pending.health);
    return healthValidatedResponseSchema.parse({ ok: true });
  });
  ipcMain.handle(ipcChannels.chooseSourceFolder, async (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    parseOrThrow(chooseFolderRequestSchema, payload);
    return chooseFolderResponseSchema.parse(await controller.chooseFolder(window.id, 'source'));
  });
  ipcMain.handle(ipcChannels.chooseDestinationFolder, async (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    parseOrThrow(chooseFolderRequestSchema, payload);
    return chooseFolderResponseSchema.parse(
      await controller.chooseFolder(window.id, 'destination'),
    );
  });
  ipcMain.handle(ipcChannels.listDetectedSources, (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = detectedSourceListRequestSchema.safeParse(payload);
    if (!request.success) return detectedSourceListResponseSchema.parse(invalidRequest);
    return detectedSourceListResponseSchema.parse(controller.listDetectedSources(window.id));
  });
  ipcMain.handle(ipcChannels.listKnownSources, (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = listKnownSourcesRequestSchema.safeParse(payload);
    if (!request.success) return listKnownSourcesResponseSchema.parse(invalidRequest);
    return listKnownSourcesResponseSchema.parse(controller.listKnownSources(window.id));
  });
  ipcMain.handle(ipcChannels.setSourceNickname, async (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = setSourceNicknameRequestSchema.safeParse(payload);
    if (!request.success) return setSourceNicknameResponseSchema.parse(invalidRequest);
    return setSourceNicknameResponseSchema.parse(
      await controller.setSourceNickname(window.id, request.data),
    );
  });
  ipcMain.handle(ipcChannels.registerSource, async (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = registerSourceRequestSchema.safeParse(payload);
    if (!request.success) return registerSourceResponseSchema.parse(invalidRequest);
    return registerSourceResponseSchema.parse(
      await controller.registerDetectedSource(window.id, request.data),
    );
  });

  ipcMain.handle(ipcChannels.countSourceMedia, async (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = countSourceMediaRequestSchema.safeParse(payload);
    if (!request.success) return countSourceMediaResponseSchema.parse(invalidRequest);
    return countSourceMediaResponseSchema.parse(
      await controller.countSourceMedia(window.id, request.data),
    );
  });

  ipcMain.handle(ipcChannels.getSettings, (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = getSettingsRequestSchema.safeParse(payload);
    if (!request.success) return getSettingsResponseSchema.parse(invalidRequest);
    return getSettingsResponseSchema.parse(controller.getSettings(window.id));
  });
  ipcMain.handle(ipcChannels.updateSettings, async (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = updateSettingsRequestSchema.safeParse(payload);
    if (!request.success) return updateSettingsResponseSchema.parse(invalidRequest);
    return updateSettingsResponseSchema.parse(
      await controller.updateSettings(window.id, request.data),
    );
  });
  ipcMain.handle(ipcChannels.resetDestinationToDefault, async (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = resetDestinationToDefaultRequestSchema.safeParse(payload);
    if (!request.success) return resetDestinationToDefaultResponseSchema.parse(invalidRequest);
    return resetDestinationToDefaultResponseSchema.parse(
      await controller.resetDestinationToDefault(window.id),
    );
  });
  ipcMain.handle(ipcChannels.validateTemplate, (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = validateTemplateRequestSchema.safeParse(payload);
    if (!request.success) {
      return validateTemplateResponseSchema.parse({
        ok: false,
        errors: ['The template request was invalid.'],
      });
    }
    return validateTemplateResponseSchema.parse(
      controller.validateTemplate(window.id, request.data),
    );
  });
  ipcMain.handle(ipcChannels.reviewIngest, async (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = reviewIngestRequestSchema.safeParse(payload);
    if (!request.success) return reviewIngestResponseSchema.parse(invalidRequest);
    return reviewIngestResponseSchema.parse(await controller.review(window.id, request.data));
  });
  ipcMain.handle(ipcChannels.startIngest, async (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = startIngestRequestSchema.safeParse(payload);
    if (!request.success) return startIngestResponseSchema.parse(invalidRequest);
    return startIngestResponseSchema.parse(await controller.start(window.id, request.data));
  });
  ipcMain.handle(ipcChannels.cancelIngest, async (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = cancelIngestRequestSchema.safeParse(payload);
    if (!request.success) return cancelIngestResponseSchema.parse(invalidRequest);
    return cancelIngestResponseSchema.parse(await controller.cancel(window.id, request.data));
  });
  ipcMain.handle(ipcChannels.listRecoverableSessions, (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = listRecoverableSessionsRequestSchema.safeParse(payload);
    if (!request.success) return listRecoverableSessionsResponseSchema.parse(invalidRequest);
    return listRecoverableSessionsResponseSchema.parse(
      controller.listRecoverableSessions(window.id),
    );
  });
  ipcMain.handle(ipcChannels.claimSession, (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = claimSessionRequestSchema.safeParse(payload);
    if (!request.success) return claimSessionResponseSchema.parse(invalidRequest);
    return claimSessionResponseSchema.parse(controller.claimSession(window.id, request.data));
  });
  ipcMain.handle(ipcChannels.recoverSession, async (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = recoverSessionRequestSchema.safeParse(payload);
    if (!request.success) return recoverSessionResponseSchema.parse(invalidRequest);
    return recoverSessionResponseSchema.parse(
      await controller.recoverSession(window.id, request.data),
    );
  });
  ipcMain.handle(ipcChannels.getSession, (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = getSessionRequestSchema.safeParse(payload);
    if (!request.success) return getSessionResponseSchema.parse(invalidRequest);
    return getSessionResponseSchema.parse(controller.getSession(window.id, request.data.sessionId));
  });
  ipcMain.handle(ipcChannels.listSummaryDays, (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = listSummaryDaysRequestSchema.safeParse(payload);
    if (!request.success) return listSummaryDaysResponseSchema.parse(invalidRequest);
    return listSummaryDaysResponseSchema.parse(controller.listSummaryDays(window.id, request.data));
  });
  ipcMain.handle(ipcChannels.listSummaryMediaByDay, (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = listSummaryMediaRequestSchema.safeParse(payload);
    if (!request.success) return listSummaryMediaResponseSchema.parse(invalidRequest);
    return listSummaryMediaResponseSchema.parse(
      controller.listSummaryMedia(window.id, request.data),
    );
  });
  ipcMain.handle(ipcChannels.getThumbnail, async (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = getThumbnailRequestSchema.safeParse(payload);
    if (!request.success) return getThumbnailResponseSchema.parse(invalidRequest);
    return getThumbnailResponseSchema.parse(
      await controller.getThumbnail(window.id, request.data.token),
    );
  });
  ipcMain.handle(ipcChannels.retryThumbnail, (event, payload: unknown) => {
    const window = authorizedWindow(event, rendererUrl);
    const request = retryThumbnailRequestSchema.safeParse(payload);
    if (!request.success) return retryThumbnailResponseSchema.parse(invalidRequest);
    return retryThumbnailResponseSchema.parse(controller.retryThumbnail(window.id, request.data));
  });
}

export function createFolderDialog(
  dialog: {
    showOpenDialog(
      window: BrowserWindow,
      options: { title: string; properties: Array<'openDirectory' | 'createDirectory'> },
    ): Promise<{ canceled: boolean; filePaths: string[] }>;
  },
  windowFromId: (windowId: number) => BrowserWindow | null,
): (windowId: number, kind: 'source' | 'destination') => Promise<string | undefined> {
  return async (windowId, kind) => {
    const window = windowFromId(windowId);
    if (window === null) return undefined;
    const result = await dialog.showOpenDialog(window, {
      title: kind === 'source' ? 'Choose source folder' : 'Choose destination folder',
      properties: kind === 'source' ? ['openDirectory'] : ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? undefined : result.filePaths[0];
  };
}

export function bindWindowProgress(
  window: BrowserWindow,
  controller: DesktopController,
): () => void {
  const unsubscribe = controller.subscribe(window.id, (session) => {
    if (!window.isDestroyed()) {
      window.webContents.send(
        ipcChannels.sessionProgress,
        sessionProgressEventSchema.parse({ windowId: window.id, session }),
      );
    }
  });
  const unsubscribeSummary =
    controller.subscribeSummary?.(window.id, () => {
      if (!window.isDestroyed()) {
        window.webContents.send(
          ipcChannels.summaryInvalidated,
          summaryInvalidatedEventSchema.parse({ windowId: window.id }),
        );
      }
    }) ?? (() => undefined);
  const unsubscribeDetectedSources =
    controller.subscribeDetectedSources?.(window.id, () => {
      if (!window.isDestroyed()) {
        window.webContents.send(
          ipcChannels.detectedSourcesChanged,
          detectedSourcesChangedEventSchema.parse({ windowId: window.id }),
        );
      }
    }) ?? (() => undefined);
  const cleanup = (): void => {
    unsubscribe();
    unsubscribeSummary();
    unsubscribeDetectedSources();
    controller.destroyWindow(window.id);
  };
  window.once('closed', cleanup);
  return cleanup;
}

export function removeIpcHandlers(): void {
  for (const channel of [
    ipcChannels.health,
    ipcChannels.healthValidated,
    ipcChannels.chooseSourceFolder,
    ipcChannels.chooseDestinationFolder,
    ipcChannels.listDetectedSources,
    ipcChannels.listKnownSources,
    ipcChannels.setSourceNickname,
    ipcChannels.registerSource,
    ipcChannels.countSourceMedia,
    ipcChannels.getSettings,
    ipcChannels.updateSettings,
    ipcChannels.resetDestinationToDefault,
    ipcChannels.validateTemplate,
    ipcChannels.reviewIngest,
    ipcChannels.startIngest,
    ipcChannels.cancelIngest,
    ipcChannels.listRecoverableSessions,
    ipcChannels.claimSession,
    ipcChannels.recoverSession,
    ipcChannels.getSession,
    ipcChannels.listSummaryDays,
    ipcChannels.listSummaryMediaByDay,
    ipcChannels.getThumbnail,
    ipcChannels.retryThumbnail,
    ipcChannels.copyText,
  ]) {
    ipcMain.removeHandler(channel);
  }
}

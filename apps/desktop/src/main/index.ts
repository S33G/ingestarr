import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { app, BrowserWindow, dialog } from 'electron';

import { createDesktopApplication, type DesktopApplication } from './bootstrap';
import { DesktopController } from './controller';
import { createComposedIngestService } from './ingest-service';
import {
  bindWindowProgress,
  createFolderDialog,
  registerIpcHandlers,
  removeIpcHandlers,
} from './ipc';
import { createBeforeQuitHandler } from './shutdown';
import { createSmokeReadiness } from './smoke-readiness';
import { createWindowOptions } from './window-options';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let controller: DesktopController | undefined;
let desktopApplication: DesktopApplication | undefined;
const smokeUserData = process.env.INGESTARR_SMOKE_USER_DATA;
if (smokeUserData !== undefined) app.setPath('userData', smokeUserData);
const smokeReadiness = createSmokeReadiness({
  readyFile: process.env.INGESTARR_SMOKE_READY_FILE,
  write: writeFile,
  exit: (code) => app.exit(code),
});

function rendererUrl(): string {
  return (
    MAIN_WINDOW_VITE_DEV_SERVER_URL ??
    pathToFileURL(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    ).toString()
  );
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow(createWindowOptions(path.join(__dirname, 'preload.js')));
  if (controller === undefined) throw new Error('Desktop controller is not initialized');
  bindWindowProgress(window, controller);
  const allowedRendererUrl = rendererUrl();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== allowedRendererUrl) event.preventDefault();
  });

  window.once('ready-to-show', () => window.show());
  window.webContents.once('did-finish-load', () => smokeReadiness.markLoaded(window.id));

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(allowedRendererUrl);
  } else {
    void window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  return window;
}

void app.whenReady().then(async () => {
  // Electron's `documents` path is already the correct per-OS location (e.g. ~/Documents on
  // macOS/Linux, %USERPROFILE%\Documents on Windows), so a single join covers every platform.
  const defaultDestinationRoot = path.join(app.getPath('documents'), 'Ingestarr');
  desktopApplication = await createDesktopApplication({
    userDataPath: app.getPath('userData'),
    defaultDestinationRoot,
    createService: createComposedIngestService,
  });
  await desktopApplication.detectedSources.start();
  controller = new DesktopController({
    service: desktopApplication.service,
    dialog: createFolderDialog(dialog, (windowId) => BrowserWindow.fromId(windowId)),
    detectedSources: desktopApplication.detectedSources,
    defaultDestinationRoot,
  });
  registerIpcHandlers(controller, rendererUrl(), {
    onHealth: (windowId, health) => smokeReadiness.complete(windowId, health),
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on(
  'before-quit',
  createBeforeQuitHandler({
    async shutdown() {
      removeIpcHandlers();
      try {
        await controller?.close();
      } finally {
        await desktopApplication?.close();
      }
      controller = undefined;
      desktopApplication = undefined;
    },
    quit: () => app.quit(),
  }),
);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

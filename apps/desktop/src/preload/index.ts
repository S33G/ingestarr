import { contextBridge, ipcRenderer } from 'electron';

import { createDesktopApi } from './api';

contextBridge.exposeInMainWorld(
  'ingestarr',
  createDesktopApi(
    (channel, payload) => ipcRenderer.invoke(channel, payload),
    (channel, listener) => ipcRenderer.on(channel, listener),
    (channel, listener) => ipcRenderer.removeListener(channel, listener),
  ),
);

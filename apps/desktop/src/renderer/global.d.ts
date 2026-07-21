import type { DesktopApi } from '../preload/api';

declare global {
  interface Window {
    ingestarr: DesktopApi;
  }
}

export {};

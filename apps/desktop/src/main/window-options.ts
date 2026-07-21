import type { BrowserWindowConstructorOptions } from 'electron';

export function createWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1180,
    height: 760,
    minWidth: 840,
    minHeight: 580,
    show: false,
    // Native macOS feel: the traffic lights float over the app's own translucent sidebar
    // instead of a separate OS title bar. `trafficLightPosition` nudges them down so they sit
    // centered in the sidebar header. On Windows/Linux this option is simply ignored.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#1e1f22',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
    },
  };
}

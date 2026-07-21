import { describe, expect, it } from 'vitest';

import { createWindowOptions } from './window-options';

describe('desktop BrowserWindow options', () => {
  it('enables Electron renderer security boundaries', () => {
    const options = createWindowOptions('/absolute/preload.js');

    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: '/absolute/preload.js',
    });
  });
});

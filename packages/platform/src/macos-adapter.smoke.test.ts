import { describe, expect, it } from 'vitest';

import { createMacosAdapter } from './macos-adapter.js';
import { nodeCommandRunner } from './command-runner.js';
import { nodeManualSourceAdapter } from './manual-source.js';

describe('macOS local mounted-source smoke', () => {
  it.runIf(process.platform === 'darwin' && process.env.INGESTARR_MACOS_SMOKE === '1')(
    'performs opt-in read-only discovery',
    async () => {
      const sources = await createMacosAdapter({
        commandRunner: nodeCommandRunner,
        fs: nodeManualSourceAdapter,
      }).listMountedSources();
      expect(Array.isArray(sources)).toBe(true);
      expect(sources.every((source) => source.removable)).toBe(true);
    },
  );
});

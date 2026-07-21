import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

interface DesktopPackage {
  scripts: Record<string, string>;
}

const desktopPackage = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as DesktopPackage;

describe('desktop command dependency preparation', () => {
  it('dev prepares workspace dependencies and rebuilds native modules for Electron', () => {
    expect(desktopPackage.scripts.predev).toBe('pnpm prepare:dependencies && pnpm rebuild:native');
  });

  it.each(['build', 'package', 'make'])(
    '%s prepares workspace, packaged runtime, and native module dependencies',
    (command) => {
      expect(desktopPackage.scripts[`pre${command}`]).toBe(
        'pnpm prepare:dependencies && pnpm prepare:runtime && pnpm rebuild:native',
      );
      expect(desktopPackage.scripts[`post${command}`]).toBe(
        'node scripts/clean-runtime-dependencies.mjs',
      );
    },
  );

  it('rebuilds native modules for Electron and for plain Node', () => {
    expect(desktopPackage.scripts['rebuild:native']).toBe(
      'node scripts/rebuild-native-modules.mjs --target=electron',
    );
    expect(desktopPackage.scripts['rebuild:native:node']).toBe(
      'node scripts/rebuild-native-modules.mjs --target=node',
    );
  });

  it('deploys runtime dependencies through an isolated staging script', () => {
    expect(desktopPackage.scripts['prepare:runtime']).toBe(
      'node scripts/prepare-runtime-dependencies.mjs',
    );
  });

  it('builds every workspace package imported by Electron main', () => {
    expect(desktopPackage.scripts['prepare:dependencies']).toBe(
      'pnpm --filter @ingestarr/shared-types build && pnpm --filter @ingestarr/ingest-core build && pnpm --filter @ingestarr/metadata build && pnpm --filter @ingestarr/platform build && pnpm --filter @ingestarr/storage build',
    );
  });

  it('exposes repeatable packaged native and readiness smoke commands', () => {
    expect(desktopPackage.scripts['smoke:native']).toBe('node scripts/smoke-packaged-native.mjs');
    expect(desktopPackage.scripts['smoke:launch']).toBe('node scripts/smoke-packaged-launch.mjs');
  });
});

import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Ingestarr',
    prune: false,
    extraResource: [path.join(tmpdir(), 'Ingestarr Third-Party Notices')],
    asar: {
      unpack:
        '**/node_modules/{ffmpeg-static,@img/sharp-*,@img/sharp-libvips-*,exiftool-vendored,exiftool-vendored.pl}/**/*',
    },
    ignore: (file) => {
      if (!file) return false;
      return !file.startsWith('/.vite') && !file.startsWith('/node_modules');
    },
  },
  hooks: {
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      await rm(path.join(buildPath, 'node_modules'), { recursive: true, force: true });
      await cp(
        path.join(tmpdir(), 'ingestarr-desktop-runtime', 'node_modules'),
        path.join(buildPath, 'node_modules'),
        { recursive: true },
      );
    },
  },
  rebuildConfig: {},
  makers: [new MakerZIP({}, ['darwin']), new MakerSquirrel({}), new MakerDeb({})],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/index.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
};

export default config;

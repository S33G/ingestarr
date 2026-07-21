import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      external: ['better-sqlite3', 'electron', 'exiftool-vendored', 'ffmpeg-static', 'sharp'],
      output: {
        entryFileNames: 'main.js',
      },
    },
  },
});

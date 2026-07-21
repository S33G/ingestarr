import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  test: {
    coverage: {
      reporter: ['text', 'html'],
    },
    include: ['apps/**/*.test.{ts,tsx}', 'packages/**/*.test.ts'],
    // Some tests stream multi-megabyte fixtures through the real filesystem (e.g. copy-and-verify),
    // which can exceed the 5s default on slower CI disks. Give them generous headroom.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

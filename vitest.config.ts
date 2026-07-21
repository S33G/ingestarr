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
  },
});

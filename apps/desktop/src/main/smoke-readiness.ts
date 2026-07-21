import type { HealthResponse } from '@ingestarr/shared-types';

interface SmokeReadinessOptions {
  readyFile: string | undefined;
  write(file: string, data: string, options: { encoding: 'utf8'; mode: number }): Promise<unknown>;
  exit(code: number): void;
}

export function createSmokeReadiness(options: SmokeReadinessOptions): {
  markLoaded(windowId: number): void;
  complete(windowId: number, health: HealthResponse): Promise<void>;
} {
  const loadedWindows = new Set<number>();
  let completed = false;

  return {
    markLoaded(windowId) {
      loadedWindows.add(windowId);
    },
    async complete(windowId, health) {
      if (options.readyFile === undefined || completed) return;
      if (!loadedWindows.has(windowId)) {
        throw new Error('Smoke health handshake did not come from a loaded renderer');
      }
      completed = true;
      try {
        await options.write(
          options.readyFile,
          JSON.stringify({ status: 'ready', version: health.version }),
          { encoding: 'utf8', mode: 0o600 },
        );
      } catch (error) {
        completed = false;
        throw error;
      }
      options.exit(0);
    },
  };
}

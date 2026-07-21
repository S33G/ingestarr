export type SourceType = 'removable-volume' | 'folder';
export type RawFact = string | number | boolean | null;

export interface MountedSourceInfo {
  sourceType: SourceType;
  canonicalMountPath: string;
  displayName: string;
  volumeLabel?: string;
  platformVolumeId?: string;
  fsType?: string;
  capacityBytes?: number;
  removable: boolean;
  /** Genuinely observed from the OS where available; never fabricated. */
  deviceVendor?: string;
  deviceModel?: string;
  rawFacts: Readonly<Record<string, RawFact>>;
}

export type SourceCallback = (source: MountedSourceInfo) => void | Promise<void>;
export type AsyncDisposer = () => Promise<void>;

export interface PlatformAdapter {
  listMountedSources(signal?: AbortSignal): Promise<MountedSourceInfo[]>;
  getSourceInfo(selectedPath: string, signal?: AbortSignal): Promise<MountedSourceInfo>;
  watchSourceArrival(callback: SourceCallback): Promise<AsyncDisposer>;
  watchSourceRemoval(callback: SourceCallback): Promise<AsyncDisposer>;
}

export interface PlatformAdapterBase {
  listMountedSources(signal?: AbortSignal): Promise<MountedSourceInfo[]>;
  getSourceInfo(selectedPath: string, signal?: AbortSignal): Promise<MountedSourceInfo>;
}

export class PlatformAvailabilityError extends Error {
  readonly code = 'PLATFORM_SOURCE_UNAVAILABLE';
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PlatformAvailabilityError';
  }
}

export class InvalidSourcePathError extends Error {
  readonly code = 'INVALID_SOURCE_PATH';
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidSourcePathError';
  }
}

export interface PollingTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PollingOptions {
  intervalMs?: number;
  timers?: PollingTimers;
}

const defaultTimers: PollingTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

// Mount path participates in the key deliberately: a remount at a different path is
// observable as removal + arrival, even when the strong volume identity is unchanged.
function diffKey(source: MountedSourceInfo): string {
  return `${source.platformVolumeId ?? 'path-only'}\0${source.canonicalMountPath}`;
}

export function createPollingPlatformAdapter(
  base: PlatformAdapterBase,
  options: PollingOptions = {},
): PlatformAdapter {
  const timers = options.timers ?? defaultTimers;
  const intervalMs = options.intervalMs ?? 2_000;
  const arrivals = new Set<SourceCallback>();
  const removals = new Set<SourceCallback>();
  let snapshot = new Map<string, MountedSourceInfo>();
  let initialized = false;
  let timer: unknown;
  let inFlight: Promise<void> | undefined;
  let controller: AbortController | undefined;

  const notify = async (callbacks: Set<SourceCallback>, source: MountedSourceInfo) => {
    await Promise.all(
      [...callbacks].map(async (callback) => {
        try {
          await callback(source);
        } catch {
          // A consumer callback must not stop polling or other consumers.
        }
      }),
    );
  };

  const schedule = () => {
    if (arrivals.size + removals.size === 0 || timer !== undefined) return;
    timer = timers.setTimeout(() => {
      timer = undefined;
      void poll();
    }, intervalMs);
  };

  const poll = async () => {
    if (inFlight !== undefined || arrivals.size + removals.size === 0) return;
    controller = new AbortController();
    const operation = (async () => {
      try {
        const values = await base.listMountedSources(controller?.signal);
        const next = new Map(values.map((value) => [diffKey(value), value]));
        if (initialized) {
          for (const [key, value] of snapshot) {
            if (!next.has(key)) await notify(removals, value);
          }
          for (const [key, value] of next) {
            if (!snapshot.has(key)) await notify(arrivals, value);
          }
        }
        snapshot = next;
        initialized = true;
      } catch {
        // Preserve the last good snapshot. Transient failures must not imply removals.
      } finally {
        controller = undefined;
      }
    })();
    inFlight = operation;
    try {
      await operation;
    } finally {
      inFlight = undefined;
      schedule();
    }
  };

  const register = async (
    callbacks: Set<SourceCallback>,
    callback: SourceCallback,
  ): Promise<AsyncDisposer> => {
    callbacks.add(callback);
    if (!initialized && inFlight === undefined) await poll();
    else schedule();
    let disposal: Promise<void> | undefined;
    return () => {
      disposal ??= (async () => {
        callbacks.delete(callback);
        if (arrivals.size + removals.size !== 0) return;
        if (timer !== undefined) {
          timers.clearTimeout(timer);
          timer = undefined;
        }
        controller?.abort();
        await inFlight;
      })();
      return disposal;
    };
  };

  return {
    ...base,
    watchSourceArrival: (callback) => register(arrivals, callback),
    watchSourceRemoval: (callback) => register(removals, callback),
  };
}

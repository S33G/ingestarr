import path from 'node:path';

import { getManualSourceFacts, type ManualSourceAdapter } from './manual-source.js';
import {
  InvalidSourcePathError,
  PlatformAvailabilityError,
  createPollingPlatformAdapter,
  type MountedSourceInfo,
  type PlatformAdapter,
  type PlatformAdapterBase,
  type PollingOptions,
} from './platform-adapter.js';
import type { CommandRunner } from './command-runner.js';

export type PlatformFileSystem = ManualSourceAdapter;

export interface AdapterDependencies extends PollingOptions {
  commandRunner: CommandRunner;
  fs: PlatformFileSystem;
  systemMountPoints?: readonly string[];
}

export const commandOptions = (signal?: AbortSignal) => ({
  shell: false as const,
  timeoutMs: 10_000,
  maxStdoutBytes: 8 * 1024 * 1024,
  maxStderrBytes: 1024 * 1024,
  ...(signal === undefined ? {} : { signal }),
  env: { LC_ALL: 'C', LANG: 'C' },
});

export function safeCapacity(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function booleanFact(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return undefined;
}

export function isCancellationError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown; cause?: unknown };
  if (
    candidate.name === 'AbortError' ||
    candidate.code === 'ABORT_ERR' ||
    candidate.code === 'COMMAND_ABORTED'
  ) {
    return true;
  }
  return candidate.cause === undefined ? false : isCancellationError(candidate.cause);
}

function isAbsolute(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function comparePath(value: string): string {
  const withoutTrailing = value.replace(/[\\/]+$/, '');
  const normalized = withoutTrailing.length === 0 ? value : withoutTrailing;
  return /^[A-Za-z]:/.test(normalized) || normalized.startsWith('\\\\')
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

export function buildAdapter(
  dependencies: AdapterDependencies,
  listMountedSources: PlatformAdapterBase['listMountedSources'],
): PlatformAdapter {
  const base: PlatformAdapterBase = {
    listMountedSources,
    async getSourceInfo(selectedPath, signal) {
      signal?.throwIfAborted();
      if (!isAbsolute(selectedPath)) {
        throw new InvalidSourcePathError(
          'Source path must be absolute; relative traversal is unsafe',
        );
      }
      let canonical: string;
      try {
        canonical = await dependencies.fs.realpath(selectedPath);
      } catch (error) {
        throw new InvalidSourcePathError('Source path does not exist', { cause: error });
      }
      try {
        const mounted = await listMountedSources(signal);
        const match = mounted.find(
          (source) => comparePath(source.canonicalMountPath) === comparePath(canonical),
        );
        if (match !== undefined) return match;
      } catch (error) {
        if (isCancellationError(error, signal)) throw error;
        if (!(error instanceof PlatformAvailabilityError)) throw error;
      }
      signal?.throwIfAborted();

      try {
        const facts = await getManualSourceFacts(canonical, dependencies.fs);
        return {
          sourceType: 'folder',
          canonicalMountPath: facts.canonicalRoot,
          displayName: facts.displayName,
          volumeLabel: facts.label,
          ...(facts.filesystem === undefined ? {} : { fsType: facts.filesystem }),
          ...(facts.capacityBytes === undefined ? {} : { capacityBytes: facts.capacityBytes }),
          removable: false,
          rawFacts: { selection: 'manual' },
        };
      } catch (error) {
        throw new InvalidSourcePathError('Source must be an existing readable directory', {
          cause: error,
        });
      }
    },
  };
  return createPollingPlatformAdapter(base, dependencies);
}

export function availabilityError(platform: string, error: unknown): PlatformAvailabilityError {
  return new PlatformAvailabilityError(`${platform} mounted-source discovery is unavailable`, {
    cause: error,
  });
}

export function sortSources(values: MountedSourceInfo[]): MountedSourceInfo[] {
  return values.sort((left, right) =>
    left.canonicalMountPath.localeCompare(right.canonicalMountPath, 'en'),
  );
}

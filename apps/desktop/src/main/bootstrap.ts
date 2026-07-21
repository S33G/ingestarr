import { mkdir as nodeMkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  migrateDatabase as migrateStorageDatabase,
  openDatabase as openStorageDatabase,
} from '@ingestarr/storage';
import {
  createPlatformAdapter as createHostPlatformAdapter,
  type PlatformAdapter,
} from '@ingestarr/platform';

import type { DesktopIngestService } from './controller';
import { DetectedSourceRegistry } from './detected-sources';

interface ConnectionLike {
  database: unknown;
  close(): void;
}

interface DesktopApplicationOptions {
  userDataPath: string;
  defaultDestinationRoot?: string;
  mkdir?: (path: string, options: { recursive: true }) => Promise<unknown>;
  openDatabase?: (path: string) => ConnectionLike;
  migrateDatabase?: (database: never) => unknown;
  createPlatformAdapter?: () => PlatformAdapter;
  createService(input: {
    database: never;
    manifestsPath: string;
    temporaryPath: string;
    logsPath: string;
    thumbnailsPath: string;
    defaultDestinationRoot?: string;
  }): DesktopIngestService;
}

export interface DesktopApplication {
  service: DesktopIngestService;
  platformAdapter: PlatformAdapter;
  detectedSources: DetectedSourceRegistry;
  paths: {
    databasePath: string;
    manifestsPath: string;
    temporaryPath: string;
    logsPath: string;
    thumbnailsPath: string;
  };
  close(): Promise<void>;
}

export async function createDesktopApplication(
  options: DesktopApplicationOptions,
): Promise<DesktopApplication> {
  const mkdir = options.mkdir ?? nodeMkdir;
  const paths = {
    databasePath: path.join(options.userDataPath, 'ingestarr.sqlite'),
    manifestsPath: path.join(options.userDataPath, 'manifests'),
    temporaryPath: path.join(options.userDataPath, 'temp'),
    logsPath: path.join(options.userDataPath, 'logs'),
    thumbnailsPath: path.join(options.userDataPath, 'thumbnails'),
  };
  await Promise.all([
    mkdir(options.userDataPath, { recursive: true }),
    mkdir(paths.manifestsPath, { recursive: true }),
    mkdir(paths.temporaryPath, { recursive: true }),
    mkdir(paths.logsPath, { recursive: true }),
    mkdir(paths.thumbnailsPath, { recursive: true }),
  ]);
  const connection = (options.openDatabase ?? openStorageDatabase)(paths.databasePath);
  const platformAdapter = (options.createPlatformAdapter ?? createHostPlatformAdapter)();
  let service: DesktopIngestService;
  // The registry resolves each detected volume to a known source (on-card marker → strong id) so
  // the UI shows one card per physical card instead of a "known" + "detected" duplicate pair.
  // `service` is assigned just below and is always set before the registry's watchers start
  // (started later in `index.ts`), so this closure never observes it undefined in practice.
  const detectedSources = new DetectedSourceRegistry(platformAdapter, {
    resolveIdentity: (source) =>
      service.resolveKnownSourceForVolume({
        mountPath: source.canonicalMountPath,
        ...(source.platformVolumeId === undefined
          ? {}
          : { platformVolumeId: source.platformVolumeId }),
      }),
  });
  try {
    (options.migrateDatabase ?? migrateStorageDatabase)(connection.database as never);
    service = options.createService({
      database: connection.database as never,
      manifestsPath: paths.manifestsPath,
      temporaryPath: paths.temporaryPath,
      logsPath: paths.logsPath,
      thumbnailsPath: paths.thumbnailsPath,
      ...(options.defaultDestinationRoot === undefined
        ? {}
        : { defaultDestinationRoot: options.defaultDestinationRoot }),
    });
  } catch (error) {
    connection.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    service,
    platformAdapter,
    detectedSources,
    paths,
    close(): Promise<void> {
      closing ??= (async () => {
        try {
          await detectedSources.close();
        } finally {
          try {
            await service.close();
          } finally {
            connection.close();
          }
        }
      })();
      return closing;
    },
  };
}

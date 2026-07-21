import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createDesktopApplication } from './bootstrap';

describe('desktop main composition', () => {
  it('creates application data paths, migrates storage, and closes resources', async () => {
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    const database = { database: { marker: true }, close };
    const openDatabase = vi.fn().mockReturnValue(database);
    const migrateDatabase = vi.fn();
    const serviceClose = vi.fn().mockResolvedValue(undefined);
    const createService = vi.fn().mockReturnValue({ getSession: vi.fn(), close: serviceClose });
    const platformAdapter = {
      listMountedSources: vi.fn(),
      getSourceInfo: vi.fn(),
      watchSourceArrival: vi.fn(),
      watchSourceRemoval: vi.fn(),
    };
    const createPlatformAdapter = vi.fn().mockReturnValue(platformAdapter);

    const application = await createDesktopApplication({
      userDataPath: '/tmp/ingestarr-user-data',
      mkdir,
      openDatabase,
      migrateDatabase,
      createService,
      createPlatformAdapter,
    });

    expect(mkdir).toHaveBeenCalledWith('/tmp/ingestarr-user-data', { recursive: true });
    expect(mkdir).toHaveBeenCalledWith('/tmp/ingestarr-user-data/manifests', { recursive: true });
    expect(mkdir).toHaveBeenCalledWith('/tmp/ingestarr-user-data/temp', { recursive: true });
    expect(mkdir).toHaveBeenCalledWith('/tmp/ingestarr-user-data/logs', { recursive: true });
    expect(openDatabase).toHaveBeenCalledWith(
      path.join('/tmp/ingestarr-user-data', 'ingestarr.sqlite'),
    );
    expect(migrateDatabase).toHaveBeenCalledWith(database.database);
    expect(createService).toHaveBeenCalledWith(
      expect.objectContaining({
        database: database.database,
        manifestsPath: '/tmp/ingestarr-user-data/manifests',
        temporaryPath: '/tmp/ingestarr-user-data/temp',
        logsPath: '/tmp/ingestarr-user-data/logs',
      }),
    );
    expect(createPlatformAdapter).toHaveBeenCalledOnce();
    expect(application.platformAdapter).toBe(platformAdapter);

    await application.close();
    expect(serviceClose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the database when migration or composition fails', async () => {
    for (const stage of ['migration', 'composition'] as const) {
      const close = vi.fn();
      const migrateDatabase = vi.fn();
      const createService = vi.fn();
      if (stage === 'migration')
        migrateDatabase.mockImplementation(() => {
          throw new Error('migration failed');
        });
      else
        createService.mockImplementation(() => {
          throw new Error('composition failed');
        });

      await expect(
        createDesktopApplication({
          userDataPath: `/tmp/ingestarr-${stage}`,
          mkdir: vi.fn().mockResolvedValue(undefined),
          openDatabase: vi.fn().mockReturnValue({ database: {}, close }),
          migrateDatabase,
          createService,
        }),
      ).rejects.toThrow(`${stage} failed`);
      expect(close).toHaveBeenCalledOnce();
    }
  });
});

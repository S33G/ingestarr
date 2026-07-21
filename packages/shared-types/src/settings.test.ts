import { describe, expect, it } from 'vitest';

import { appSettingsSchema, defaultAppSettings, parseStoredAppSettings } from './settings.js';

describe('AppSettings', () => {
  it('provides strict explicit defaults with mandatory verification', () => {
    expect(appSettingsSchema.parse(defaultAppSettings)).toEqual(defaultAppSettings);
    expect(defaultAppSettings).toMatchObject({
      schemaVersion: 2,
      destinationRoot: null,
      verifyCopies: true,
      copyConcurrency: 1,
      thumbnail: {
        width: 480,
        height: 480,
        cachePolicy: 'bounded',
      },
    });
    expect(
      appSettingsSchema.safeParse({ ...defaultAppSettings, verifyCopies: false }).success,
    ).toBe(false);
    expect(appSettingsSchema.safeParse({ ...defaultAppSettings, unexpected: true }).success).toBe(
      false,
    );
  });

  it('defaults new opt-in grouping and logging settings when absent from stored data', () => {
    const { groupByNicknameInDestination, perCardEventLog, ...withoutNewFields } =
      defaultAppSettings;
    void groupByNicknameInDestination;
    void perCardEventLog;
    expect(appSettingsSchema.parse(withoutNewFields)).toMatchObject({
      groupByNicknameInDestination: false,
      perCardEventLog: false,
    });
  });

  it('normalizes extension entries and rejects unsafe exclusions', () => {
    expect(
      appSettingsSchema.parse({
        ...defaultAppSettings,
        allowedExtensions: ['JPG', '.Mov'],
      }).allowedExtensions,
    ).toEqual(['.jpg', '.mov']);
    expect(
      appSettingsSchema.safeParse({
        ...defaultAppSettings,
        excludedPathPatterns: ['../outside'],
      }).success,
    ).toBe(false);
  });

  it('migrates prior persisted settings and ignores future additive fields', () => {
    expect(
      parseStoredAppSettings({
        destinationRoot: '/Archive',
        verifyCopies: true,
        collisionStrategy: 'prompt',
        preserveTimestamps: true,
        allowedExtensions: ['.jpg'],
        excludedPathPatterns: ['.Trashes'],
        destinationTemplate: '{captureDate}/{sourceName}',
        copyConcurrency: 1,
        thumbnailCacheLimitBytes: 100,
      }),
    ).toMatchObject({
      schemaVersion: 2,
      destinationRoot: '/Archive',
      destinationTemplate: '{YYYY}/{YYYY-MM-DD}/{sourceLabelOrCamera}/{originalFilename}',
      thumbnail: { cacheLimitBytes: 100 },
    });
    expect(
      parseStoredAppSettings({
        ...defaultAppSettings,
        schemaVersion: 99,
        futureSetting: 'ignored',
      }),
    ).toEqual(defaultAppSettings);
  });
});

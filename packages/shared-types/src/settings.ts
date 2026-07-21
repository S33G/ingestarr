import { z } from 'zod';

export const collisionStrategySchema = z.enum(['prompt', 'skip', 'replace', 'rename']);
export type CollisionStrategy = z.infer<typeof collisionStrategySchema>;

const extensionSchema = z.preprocess(
  (value) =>
    typeof value === 'string'
      ? `.${value.trim().replace(/^\./, '').toLocaleLowerCase('en-US')}`
      : value,
  z.string().regex(/^\.[a-z0-9]+$/),
);
const exclusionSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !/^(?:[\\/]|[A-Za-z]:[\\/])/.test(value) &&
      !value.split(/[\\/]/).some((segment) => segment === '..' || segment === '.'),
    'Exclusions must be relative and cannot traverse directories',
  );

export const appSettingsSchema = z.strictObject({
  schemaVersion: z.literal(2),
  destinationRoot: z.string().min(1).nullable(),
  verifyCopies: z.literal(true),
  collisionStrategy: collisionStrategySchema,
  preserveTimestamps: z.boolean(),
  allowedExtensions: z.array(extensionSchema).min(1).max(128),
  excludedPathPatterns: z.array(exclusionSchema).max(128),
  destinationTemplate: z.string().trim().min(1).max(1_024),
  copyConcurrency: z.number().int().min(1).max(4),
  groupByNicknameInDestination: z.boolean().default(false),
  perCardEventLog: z.boolean().default(false),
  // When true, inserting an online removable card automatically starts an ingest to the
  // configured destination with no prompts (identity resolved via the on-card marker). Off by
  // default because it copies data as a side effect of simply plugging in a card.
  autoIngest: z.boolean().default(false),
  thumbnail: z.strictObject({
    width: z.number().int().min(64).max(2_048),
    height: z.number().int().min(64).max(2_048),
    cachePolicy: z.enum(['bounded', 'session']),
    cacheLimitBytes: z.number().int().min(1).max(100_000_000_000),
  }),
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const defaultAppSettings: AppSettings = {
  schemaVersion: 2,
  destinationRoot: null,
  verifyCopies: true,
  collisionStrategy: 'prompt',
  preserveTimestamps: true,
  allowedExtensions: ['.jpg', '.jpeg', '.png', '.heic', '.mov', '.mp4'],
  excludedPathPatterns: ['.Spotlight-V100', '.Trashes'],
  destinationTemplate: '{YYYY}/{YYYY-MM-DD}/{sourceLabelOrCamera}/{originalFilename}',
  copyConcurrency: 1,
  groupByNicknameInDestination: false,
  perCardEventLog: false,
  autoIngest: false,
  thumbnail: {
    width: 480,
    height: 480,
    cachePolicy: 'bounded',
    cacheLimitBytes: 2_000_000_000,
  },
};

export function parseStoredAppSettings(value: unknown): AppSettings {
  const current = appSettingsSchema.safeParse(value);
  if (current.success) return current.data;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return defaultAppSettings;
  }
  const stored = value as Record<string, unknown>;
  if (typeof stored.schemaVersion === 'number' && stored.schemaVersion > 2) {
    const known = Object.fromEntries(
      Object.keys(defaultAppSettings)
        .filter((key) => key in stored)
        .map((key) => [key, stored[key]]),
    );
    const tolerant = appSettingsSchema.safeParse({
      ...defaultAppSettings,
      ...known,
      schemaVersion: 2,
    });
    return tolerant.success ? tolerant.data : defaultAppSettings;
  }
  const migrated = appSettingsSchema.safeParse({
    ...defaultAppSettings,
    destinationRoot:
      typeof stored.destinationRoot === 'string' || stored.destinationRoot === null
        ? stored.destinationRoot
        : null,
    collisionStrategy: stored.collisionStrategy,
    preserveTimestamps: stored.preserveTimestamps,
    allowedExtensions: stored.allowedExtensions,
    excludedPathPatterns: stored.excludedPathPatterns,
    copyConcurrency: stored.copyConcurrency,
    thumbnail: {
      ...defaultAppSettings.thumbnail,
      cacheLimitBytes: stored.thumbnailCacheLimitBytes,
    },
  });
  return migrated.success ? migrated.data : defaultAppSettings;
}

import { z } from 'zod';

export const sourceKindSchema = z.enum(['removable-volume', 'folder']);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const sourceMatchConfidenceSchema = z.enum(['exact', 'high', 'medium', 'low', 'none']);
export type SourceMatchConfidence = z.infer<typeof sourceMatchConfidenceSchema>;

export const sourceMatchSchema = z.strictObject({
  sourceId: z.string().min(1),
  confidence: sourceMatchConfidenceSchema,
  reasons: z.array(z.string().min(1)),
});
export type SourceMatch = z.infer<typeof sourceMatchSchema>;

export const sourceSchema = z.strictObject({
  id: z.string().min(1),
  kind: sourceKindSchema,
  displayName: z.string().min(1),
  rootPath: z.string().min(1),
  detectedAt: z.iso.datetime(),
  volumeUuid: z.string().min(1).optional(),
  deviceModel: z.string().min(1).optional(),
});
export type Source = z.infer<typeof sourceSchema>;

export const sourceFileKindSchema = z.enum(['video', 'audio', 'image', 'sidecar', 'other']);
export type SourceFileKind = z.infer<typeof sourceFileKindSchema>;

export const ingestStatusSchema = z.enum([
  'discovered',
  'analyzing',
  'ready',
  'blocked',
  'queued',
  'copying',
  'verifying',
  'completed',
  'skipped',
  'cancelled',
  'failed',
]);
export type IngestStatus = z.infer<typeof ingestStatusSchema>;

export const sourceFileSchema = z.strictObject({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  absolutePath: z.string().min(1),
  relativePath: z.string().min(1),
  name: z.string().min(1),
  extension: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAt: z.iso.datetime(),
  kind: sourceFileKindSchema,
  status: ingestStatusSchema,
  checksum: z.string().min(1).optional(),
});
export type SourceFile = z.infer<typeof sourceFileSchema>;

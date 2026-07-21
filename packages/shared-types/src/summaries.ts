import { z } from 'zod';

import { ingestStatusSchema, sourceFileKindSchema } from './source.js';

export const mediaKindSummarySchema = z.strictObject({
  kind: sourceFileKindSchema,
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
});
export type MediaKindSummary = z.infer<typeof mediaKindSummarySchema>;

export const statusSummarySchema = z.strictObject({
  status: ingestStatusSchema,
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
});
export type StatusSummary = z.infer<typeof statusSummarySchema>;

export const sourceSummarySchema = z.strictObject({
  sourceId: z.string().min(1),
  displayName: z.string().min(1),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  byMediaKind: z.array(mediaKindSummarySchema),
  byStatus: z.array(statusSummarySchema),
});
export type SourceSummary = z.infer<typeof sourceSummarySchema>;

export const sessionSummarySchema = z.strictObject({
  sessionId: z.string().min(1),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
  discoveredFiles: z.number().int().nonnegative(),
  copiedFiles: z.number().int().nonnegative(),
  skippedFiles: z.number().int().nonnegative(),
  failedFiles: z.number().int().nonnegative(),
  copiedBytes: z.number().int().nonnegative(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

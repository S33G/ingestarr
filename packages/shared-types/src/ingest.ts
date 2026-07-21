import { z } from 'zod';

import { sourceFileSchema } from './source.js';

export const ingestSummarySchema = z.strictObject({
  totalFiles: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  readyFiles: z.number().int().nonnegative(),
  blockedFiles: z.number().int().nonnegative(),
});
export type IngestSummary = z.infer<typeof ingestSummarySchema>;

export const reviewPlanFileSchema = z.strictObject({
  sourceFile: sourceFileSchema,
  destinationPath: z.string().min(1),
  action: z.enum(['copy', 'skip', 'replace']),
  warnings: z.array(z.string().min(1)),
});
export type ReviewPlanFile = z.infer<typeof reviewPlanFileSchema>;

export const reviewPlanSchema = z
  .strictObject({
    id: z.string().min(1),
    sourceId: z.string().min(1),
    createdAt: z.iso.datetime(),
    destinationRoot: z.string().min(1),
    files: z.array(reviewPlanFileSchema),
    summary: ingestSummarySchema,
  })
  .superRefine((plan, context) => {
    if (plan.files.length !== plan.summary.totalFiles) {
      context.addIssue({
        code: 'custom',
        message: 'summary.totalFiles must equal files.length',
        path: ['summary', 'totalFiles'],
      });
    }
  });
export type ReviewPlan = z.infer<typeof reviewPlanSchema>;

export const copyJobSchema = z.strictObject({
  id: z.string().min(1),
  planId: z.string().min(1),
  sourceFileId: z.string().min(1),
  sourcePath: z.string().min(1),
  destinationPath: z.string().min(1),
  expectedBytes: z.number().int().nonnegative(),
  expectedChecksum: z.string().min(1).optional(),
});
export type CopyJob = z.infer<typeof copyJobSchema>;

export const copyResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('completed'),
    jobId: z.string().min(1),
    bytesCopied: z.number().int().nonnegative(),
    checksum: z.string().min(1).optional(),
    completedAt: z.iso.datetime(),
  }),
  z.strictObject({
    status: z.literal('skipped'),
    jobId: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.strictObject({
    status: z.literal('cancelled'),
    jobId: z.string().min(1),
  }),
  z.strictObject({
    status: z.literal('failed'),
    jobId: z.string().min(1),
    errorCode: z.string().min(1),
    message: z.string().min(1),
  }),
]);
export type CopyResult = z.infer<typeof copyResultSchema>;

export const ingestProgressEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('status-changed'),
    sourceFileId: z.string().min(1),
    status: z.enum([
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
    ]),
    occurredAt: z.iso.datetime(),
  }),
  z.strictObject({
    type: z.literal('copy-progress'),
    jobId: z.string().min(1),
    completedBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    occurredAt: z.iso.datetime(),
  }),
  z.strictObject({
    type: z.literal('job-completed'),
    result: copyResultSchema,
    occurredAt: z.iso.datetime(),
  }),
]);
export type IngestProgressEvent = z.infer<typeof ingestProgressEventSchema>;

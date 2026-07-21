import { z } from 'zod';

const errorBase = {
  message: z.string().min(1),
  retryable: z.boolean(),
};

export const appErrorSchema = z.discriminatedUnion('code', [
  z.strictObject({
    ...errorBase,
    code: z.literal('VALIDATION_FAILED'),
    details: z.strictObject({ issues: z.array(z.string().min(1)) }),
  }),
  z.strictObject({
    ...errorBase,
    code: z.literal('SOURCE_UNAVAILABLE'),
    details: z.strictObject({ sourcePath: z.string().min(1) }),
  }),
  z.strictObject({
    ...errorBase,
    code: z.literal('DESTINATION_UNAVAILABLE'),
    details: z.strictObject({ destinationPath: z.string().min(1) }),
  }),
  z.strictObject({
    ...errorBase,
    code: z.literal('COPY_FAILED'),
    details: z.strictObject({
      sourcePath: z.string().min(1),
      destinationPath: z.string().min(1),
    }),
  }),
  z.strictObject({
    ...errorBase,
    code: z.literal('VERIFICATION_FAILED'),
    details: z.strictObject({
      destinationPath: z.string().min(1),
      expectedChecksum: z.string().min(1),
      actualChecksum: z.string().min(1),
    }),
  }),
  z.strictObject({
    ...errorBase,
    code: z.literal('CANCELLED'),
    details: z.strictObject({ operationId: z.string().min(1) }),
  }),
  z.strictObject({
    ...errorBase,
    code: z.literal('INTERNAL_ERROR'),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
]);
export type AppError = z.infer<typeof appErrorSchema>;
export type AppErrorCode = AppError['code'];

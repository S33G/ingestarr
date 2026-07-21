import { z } from 'zod';

/**
 * A user-assigned kebab-case identifier for a known source (e.g. "canon-r5",
 * "sony-a7iv"). Lowercase alphanumeric segments separated by single hyphens;
 * no leading/trailing/doubled hyphens.
 */
export const sourceNicknameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Nickname must be kebab-case: lowercase letters, numbers, and single hyphens only.',
  );
export type SourceNickname = z.infer<typeof sourceNicknameSchema>;

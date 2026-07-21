import { sanitizeDestinationSegment, type DestinationPlatform } from './destination-segment.js';

const TOKENS = [
  'YYYY',
  'YYYY-MM-DD',
  'sourceLabelOrCamera',
  'nickname',
  'originalFilename',
] as const;
const TOKEN_PATTERN = /\{([^{}]+)\}/g;
const MAX_OUTPUT_LENGTH = 1_024;
const MAX_SEGMENT_BYTES = 255;

export interface NamingTemplateValues {
  captureDay: string;
  sourceLabelOrCamera: string;
  originalFilename: string;
  /**
   * Optional user-assigned kebab-case source nickname, available as an
   * opt-in grouping token. Falls back to `sourceLabelOrCamera` when unset
   * so templates using `{nickname}` still compile for sources without one.
   */
  nickname?: string;
}

export interface NamingTemplateValidation {
  valid: boolean;
  errors: string[];
}

function templateSegments(template: string): string[] {
  return template.split('/');
}

export function validateNamingTemplate(template: string): NamingTemplateValidation {
  const errors: string[] = [];
  const tokens = [...template.matchAll(TOKEN_PATTERN)].map((match) => match[1] ?? '');
  const originalFilenameCount = tokens.filter((token) => token === 'originalFilename').length;

  if (template.trim() === '') errors.push('Template cannot be empty.');
  if (/^(?:[\\/]|[A-Za-z]:[\\/])/.test(template)) {
    errors.push('Template must be relative.');
  }
  if (template.includes('\\')) errors.push('Template must use portable forward-slash separators.');
  if (originalFilenameCount !== 1) {
    errors.push('Template must contain originalFilename exactly once.');
  }
  for (const token of tokens) {
    if (!(TOKENS as readonly string[]).includes(token)) {
      errors.push(`Unsupported token: ${token}.`);
    }
  }
  if (
    template.replace(TOKEN_PATTERN, '').includes('{') ||
    template.replace(TOKEN_PATTERN, '').includes('}')
  ) {
    errors.push('Template contains an invalid token expression.');
  }
  for (const segment of templateSegments(template)) {
    if (segment.trim() === '') errors.push('Template cannot contain empty path segments.');
    if (segment === '.' || segment === '..') {
      errors.push('Template cannot contain traversal segments.');
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function compileNamingTemplate(
  template: string,
  values: NamingTemplateValues,
  options: { platform?: DestinationPlatform } = {},
): string {
  const validation = validateNamingTemplate(template);
  if (!validation.valid) throw new Error(validation.errors.join(' '));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.captureDay)) {
    throw new Error('captureDay must use YYYY-MM-DD.');
  }
  const date = new Date(`${values.captureDay}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== values.captureDay) {
    throw new Error('captureDay must be a valid calendar day.');
  }
  const replacements: Record<(typeof TOKENS)[number], string> = {
    YYYY: values.captureDay.slice(0, 4),
    'YYYY-MM-DD': values.captureDay,
    sourceLabelOrCamera: values.sourceLabelOrCamera,
    nickname: values.nickname ?? values.sourceLabelOrCamera,
    originalFilename: values.originalFilename,
  };
  const segments = templateSegments(template).map((segment) =>
    sanitizeDestinationSegment(
      segment.replace(TOKEN_PATTERN, (_whole, token: string) => {
        if (!(TOKENS as readonly string[]).includes(token)) {
          throw new Error(`Unsupported token: ${token}.`);
        }
        return replacements[token as (typeof TOKENS)[number]];
      }),
      options.platform,
    ),
  );
  for (const segment of segments) {
    if (new TextEncoder().encode(segment).byteLength > MAX_SEGMENT_BYTES) {
      throw new Error(
        `Compiled naming template segment is too long (maximum ${MAX_SEGMENT_BYTES} bytes).`,
      );
    }
  }
  const output = segments.join('/');
  if (output.length > MAX_OUTPUT_LENGTH) {
    throw new Error(
      `Compiled naming template is too long (maximum ${MAX_OUTPUT_LENGTH} characters).`,
    );
  }
  return output;
}

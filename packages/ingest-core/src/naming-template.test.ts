import { describe, expect, it } from 'vitest';

import { compileNamingTemplate, validateNamingTemplate } from './naming-template.js';

const sample = {
  captureDay: '2026-07-19',
  sourceLabelOrCamera: 'CANON / EOS',
  originalFilename: 'IMG_0001.JPG',
};

describe('naming templates', () => {
  it('compiles allowlisted tokens into sanitized relative segments', () => {
    expect(
      compileNamingTemplate('{YYYY}/{YYYY-MM-DD}/{sourceLabelOrCamera}/{originalFilename}', sample),
    ).toBe('2026/2026-07-19/CANON _ EOS/IMG_0001.JPG');
  });

  it('supports an opt-in nickname token, falling back to the source label when unset', () => {
    expect(
      compileNamingTemplate('{nickname}/{originalFilename}', {
        ...sample,
        nickname: 'canon-r5',
      }),
    ).toBe('canon-r5/IMG_0001.JPG');
    expect(compileNamingTemplate('{nickname}/{originalFilename}', sample)).toBe(
      'CANON _ EOS/IMG_0001.JPG',
    );
  });

  it('requires originalFilename exactly once and rejects unknown tokens', () => {
    expect(validateNamingTemplate('{YYYY}/{sourceLabelOrCamera}')).toEqual(
      expect.objectContaining({ valid: false }),
    );
    expect(
      validateNamingTemplate('{originalFilename}/{originalFilename}').errors.join(' '),
    ).toMatch(/exactly once/i);
    expect(validateNamingTemplate('{cameraSerial}/{originalFilename}').errors.join(' ')).toMatch(
      /unsupported token/i,
    );
  });

  it.each([
    '/{originalFilename}',
    '../{originalFilename}',
    '{YYYY}//{originalFilename}',
    'C:\\{originalFilename}',
    '{YYYY}/./{originalFilename}',
  ])('rejects absolute, traversal, and empty segments in %s', (template) => {
    expect(validateNamingTemplate(template).valid).toBe(false);
  });

  it('sanitizes reserved names and bounds generated output', () => {
    expect(
      compileNamingTemplate(
        'CON/{sourceLabelOrCamera}/{originalFilename}',
        {
          ...sample,
          sourceLabelOrCamera: 'AUX.',
        },
        { platform: 'win32' },
      ),
    ).toBe('_CON/_AUX/IMG_0001.JPG');
    expect(() =>
      compileNamingTemplate('{sourceLabelOrCamera}/{originalFilename}', {
        ...sample,
        sourceLabelOrCamera: 'x'.repeat(1_100),
      }),
    ).toThrow(/too long/i);
  });

  it('applies platform-specific segment sanitation', () => {
    const values = { ...sample, sourceLabelOrCamera: 'CON' };
    expect(
      compileNamingTemplate('{sourceLabelOrCamera}/{originalFilename}', values, {
        platform: 'posix',
      }),
    ).toBe('CON/IMG_0001.JPG');
    expect(
      compileNamingTemplate('{sourceLabelOrCamera}/{originalFilename}', values, {
        platform: 'win32',
      }),
    ).toBe('_CON/IMG_0001.JPG');
  });

  it('rejects a compiled segment that exceeds the filesystem byte limit', () => {
    expect(() =>
      compileNamingTemplate(
        '{sourceLabelOrCamera}/{originalFilename}',
        { ...sample, sourceLabelOrCamera: 'é'.repeat(128) },
        { platform: 'posix' },
      ),
    ).toThrow(/segment.*255 bytes/i);
  });
});

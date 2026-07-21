import { describe, expect, it } from 'vitest';

import { sourceNicknameSchema } from './source-nickname.js';

describe('sourceNicknameSchema', () => {
  it('accepts kebab-case identifiers', () => {
    expect(sourceNicknameSchema.parse('canon-r5')).toBe('canon-r5');
    expect(sourceNicknameSchema.parse('sony-a7iv')).toBe('sony-a7iv');
    expect(sourceNicknameSchema.parse('a')).toBe('a');
    expect(sourceNicknameSchema.parse('a1-b2-c3')).toBe('a1-b2-c3');
  });

  it('rejects non-kebab-case identifiers', () => {
    for (const invalid of [
      '',
      'Canon-R5',
      'canon_r5',
      'canon r5',
      '-canon',
      'canon-',
      'canon--r5',
      'canón',
      'a'.repeat(64),
    ]) {
      expect(sourceNicknameSchema.safeParse(invalid).success, invalid).toBe(false);
    }
  });
});

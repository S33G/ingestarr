import { describe, expect, it } from 'vitest';

import { classifyMediaType } from './classify-media-type.js';

describe('classifyMediaType', () => {
  it.each([
    ['.jpg', undefined, 'photo'],
    ['CR3', 'image/x-canon-cr3', 'photo'],
    ['.nef', 'image/x-nikon-nef', 'photo'],
    ['.arw', 'image/x-sony-arw', 'photo'],
    ['.heic', 'image/heic', 'photo'],
    ['.mov', 'video/quicktime', 'video'],
    ['.mp4', 'video/mp4', 'video'],
    ['.m2ts', 'video/mp2t', 'video'],
    ['.lrv', 'video/mp4', 'video'],
    ['.bin', 'application/octet-stream', 'unknown'],
  ] as const)('classifies %s / %s as %s', (extension, mimeType, expected) => {
    expect(classifyMediaType({ extension, mimeType })).toBe(expected);
  });

  it('uses a recognized MIME type when extension and MIME disagree', () => {
    expect(classifyMediaType({ extension: '.jpg', mimeType: 'video/mp4' })).toBe('video');
    expect(classifyMediaType({ extension: '.mp4', mimeType: 'image/jpeg' })).toBe('photo');
  });

  it('falls back to a recognized extension for absent or generic MIME', () => {
    expect(classifyMediaType({ extension: '.dng' })).toBe('photo');
    expect(classifyMediaType({ extension: '.mov', mimeType: 'application/octet-stream' })).toBe(
      'video',
    );
  });
});

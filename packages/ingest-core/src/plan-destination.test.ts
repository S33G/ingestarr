import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  planDestination,
  sanitizeDestinationSegment,
  type DestinationFileSystem,
  type DestinationLookup,
} from './plan-destination.js';

function lookup(entries: Record<string, { verifiedChecksum?: string }> = {}): DestinationLookup {
  return {
    inspect: async (destinationPath) =>
      Object.hasOwn(entries, destinationPath)
        ? { exists: true, ...entries[destinationPath] }
        : { exists: false },
  };
}

const root = path.resolve('/library');
const input = {
  root,
  captureDate: '2026-07-04T23:30:00.000Z',
  sourceLabelOrCamera: 'NIKON Z8',
  originalFilename: 'DSC_0001.JPG',
  checksum: 'abcdef1234567890',
};

function boundary(
  existing = new Set([root]),
  realpaths: Record<string, string> = { [root]: root },
  kinds: Record<string, 'file' | 'directory' | 'symlink' | 'other'> = { [root]: 'directory' },
): DestinationFileSystem {
  return {
    lstat: async (value) =>
      existing.has(value) ? { exists: true, kind: kinds[value] ?? 'file' } : { exists: false },
    realpath: async (value) => realpaths[value] ?? value,
  };
}

describe('planDestination', () => {
  it('uses normalized captureDay without timezone conversion', async () => {
    const planned = await planDestination(
      {
        root,
        captureDate: '2025-01-01T06:30:01.000Z',
        captureDay: '2024-12-31',
        sourceLabelOrCamera: 'CARD',
        originalFilename: 'photo.jpg',
        checksum: 'abcdef0123456789',
      },
      { inspect: async () => ({ exists: false }) },
      boundary(),
    );

    expect(planned.destinationPath).toContain(path.join('2024', '2024-12-31'));
  });

  it('makes the source nickname available to a custom template as {nickname}', async () => {
    const planned = await planDestination(
      {
        ...input,
        template: '{YYYY}/{nickname}/{originalFilename}',
        nickname: 'canon-r5',
      },
      lookup(),
      boundary(),
    );

    expect(planned.destinationPath).toBe(
      path.join(root, '2026', 'canon-r5', input.originalFilename),
    );
  });

  it('falls back to sourceLabelOrCamera for {nickname} when no nickname is set', async () => {
    const planned = await planDestination(
      { ...input, template: '{YYYY}/{nickname}/{originalFilename}' },
      lookup(),
      boundary(),
    );

    expect(planned.destinationPath).toBe(
      path.join(
        root,
        '2026',
        sanitizeDestinationSegment(input.sourceLabelOrCamera),
        input.originalFilename,
      ),
    );
  });

  it('uses the deterministic UTC date hierarchy and original filename', async () => {
    await expect(planDestination(input, lookup(), boundary())).resolves.toEqual({
      kind: 'new',
      destinationPath: path.join(root, '2026', '2026-07-04', 'NIKON Z8', 'DSC_0001.JPG'),
    });
  });

  it('sanitizes unsafe characters, traversal, reserved names, and trailing dots/spaces', async () => {
    expect(sanitizeDestinationSegment('CON')).toBe('_CON');
    expect(sanitizeDestinationSegment('camera... ')).toBe('camera');
    expect(sanitizeDestinationSegment('../bad:name')).toBe('.._bad_name');

    const result = await planDestination(
      { ...input, sourceLabelOrCamera: '../CON', originalFilename: '../bad:name .JPG' },
      lookup(),
      boundary(),
    );
    expect(result.destinationPath).toContain(`${path.sep}.._CON${path.sep}`);
    expect(path.basename(result.destinationPath)).toBe('.._bad_name .JPG');
    expect(path.relative(root, result.destinationPath)).not.toMatch(/^\.\.(?:[/\\]|$)/);
  });

  it('never overwrites and uses a deterministic checksum suffix then counter', async () => {
    const base = path.join(root, '2026', '2026-07-04', 'NIKON Z8', 'DSC_0001.JPG');
    const suffixed = path.join(root, '2026', '2026-07-04', 'NIKON Z8', 'DSC_0001-abcdef12.JPG');
    const result = await planDestination(input, lookup({ [base]: {}, [suffixed]: {} }), boundary());
    expect(result).toEqual({
      kind: 'new',
      destinationPath: path.join(root, '2026', '2026-07-04', 'NIKON Z8', 'DSC_0001-abcdef12-2.JPG'),
    });
  });

  it('returns explicit reuse when an existing verified destination has the same checksum', async () => {
    const base = path.join(root, '2026', '2026-07-04', 'NIKON Z8', 'DSC_0001.JPG');
    await expect(
      planDestination(
        input,
        lookup({ [base]: { verifiedChecksum: input.checksum } }),
        boundary(
          new Set([root, base]),
          { [root]: root, [base]: base },
          {
            [root]: 'directory',
            [base]: 'file',
          },
        ),
      ),
    ).resolves.toEqual({ kind: 'reuse', destinationPath: base, checksum: input.checksum });
  });

  it('rejects invalid capture dates', async () => {
    await expect(
      planDestination({ ...input, captureDate: 'not-a-date' }, lookup(), boundary()),
    ).rejects.toThrow(/capture date/i);
  });

  it('rejects a lexical child whose existing ancestor resolves outside the canonical root', async () => {
    const sourceDirectory = path.join(root, '2026', '2026-07-04', 'NIKON Z8');
    const outsideDirectory = '/outside/library-link';
    const fileSystem = boundary(
      new Set([root, sourceDirectory, outsideDirectory]),
      {
        [root]: root,
        [sourceDirectory]: outsideDirectory,
        [outsideDirectory]: outsideDirectory,
      },
      {
        [root]: 'directory',
        [sourceDirectory]: 'symlink',
        [outsideDirectory]: 'directory',
      },
    );

    await expect(planDestination(input, lookup(), fileSystem)).rejects.toThrow(
      /canonical destination root/i,
    );
  });

  it('returns canonical destination paths when the selected root is a symlink', async () => {
    const linkedRoot = path.resolve('/library-link');
    const canonicalRoot = path.resolve('/real/library');
    const result = await planDestination(
      { ...input, root: linkedRoot },
      lookup(),
      boundary(
        new Set([canonicalRoot]),
        { [linkedRoot]: canonicalRoot, [canonicalRoot]: canonicalRoot },
        { [canonicalRoot]: 'directory' },
      ),
    );
    expect(result.destinationPath).toBe(
      path.join(canonicalRoot, '2026', '2026-07-04', 'NIKON Z8', 'DSC_0001.JPG'),
    );
  });

  it('rejects a canonical destination root that is a regular file', async () => {
    await expect(
      planDestination(
        input,
        lookup(),
        boundary(new Set([root]), { [root]: root }, { [root]: 'file' }),
      ),
    ).rejects.toThrow(/root.*directory/i);
  });

  it('rejects an existing regular-file intermediate ancestor', async () => {
    const year = path.join(root, '2026');
    await expect(
      planDestination(
        input,
        lookup(),
        boundary(
          new Set([root, year]),
          { [root]: root, [year]: year },
          { [root]: 'directory', [year]: 'file' },
        ),
      ),
    ).rejects.toThrow(/ancestor.*directory/i);
  });
});

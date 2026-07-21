import { describe, expect, it } from 'vitest';

import { classifyFile, type ClassificationRepository, type PriorFile } from './classify-files.js';

const current = {
  sourceId: 'source-a',
  relativePath: 'DCIM/image.jpg',
  canonicalPathKey: 'DCIM/image.jpg',
  sizeBytes: 100,
  modifiedAt: '2026-07-01T00:00:00.000Z',
  quickFingerprint: 'quick-v1:current',
};

function prior(overrides: Partial<PriorFile> = {}): PriorFile {
  return {
    id: 'prior-1',
    sourceId: 'source-a',
    relativePath: current.relativePath,
    canonicalPathKey: current.canonicalPathKey,
    sizeBytes: current.sizeBytes,
    modifiedAt: current.modifiedAt,
    quickFingerprint: current.quickFingerprint,
    fullChecksum: 'full-a',
    copyStatus: 'verified',
    ...overrides,
  };
}

function repository(files: PriorFile[]): ClassificationRepository {
  return {
    findBySourceAndPath: async (sourceId, relativePath) =>
      files.filter((file) => file.sourceId === sourceId && file.relativePath === relativePath),
    findBySourceAndSize: async (sourceId, sizeBytes) =>
      files.filter((file) => file.sourceId === sourceId && file.sizeBytes === sizeBytes),
    findByFullChecksum: async (checksum) => files.filter((file) => file.fullChecksum === checksum),
  };
}

describe('classifyFile', () => {
  it('classifies exact quick/path/size/mtime only as known when a prior copy is verified', async () => {
    await expect(classifyFile(current, repository([prior()]))).resolves.toMatchObject({
      decision: 'Known',
      reason: 'verified-exact-match',
    });
    await expect(
      classifyFile(current, repository([prior({ copyStatus: 'failed' })])),
    ).resolves.toMatchObject({ decision: 'Recoverable', reason: 'incomplete-prior-copy' });
  });

  it('classifies changed facts at the same path as ambiguous and requests a full hash', async () => {
    await expect(
      classifyFile(current, repository([prior({ sizeBytes: 101, quickFingerprint: 'different' })])),
    ).resolves.toMatchObject({
      decision: 'Ambiguous',
      reason: 'same-path-changed-facts',
      needsFullChecksum: true,
    });
  });

  it('classifies a same-source same-size changed path as ambiguous', async () => {
    await expect(
      classifyFile(
        current,
        repository([prior({ relativePath: 'elsewhere/image.jpg', quickFingerprint: 'different' })]),
      ),
    ).resolves.toMatchObject({
      decision: 'Ambiguous',
      reason: 'same-size-different-path',
      needsFullChecksum: true,
    });
  });

  it('does not collapse NFC-equivalent distinct source paths', async () => {
    const decomposed = `DCIM/cafe\u0301.jpg`;
    await expect(
      classifyFile(
        {
          ...current,
          relativePath: 'DCIM/café.jpg',
          canonicalPathKey: 'DCIM/café.jpg',
        },
        repository([
          prior({
            relativePath: decomposed,
            canonicalPathKey: 'DCIM/café.jpg',
            quickFingerprint: 'different',
          }),
        ]),
      ),
    ).resolves.toMatchObject({
      decision: 'Ambiguous',
      reason: 'same-size-different-path',
    });
  });

  it('resolves ambiguity to known only when a matching full checksum has a verified copy', async () => {
    const ambiguous = prior({
      relativePath: 'elsewhere/image.jpg',
      quickFingerprint: 'different',
      fullChecksum: 'same-full',
    });
    await expect(
      classifyFile({ ...current, fullChecksum: 'same-full' }, repository([ambiguous])),
    ).resolves.toMatchObject({ decision: 'Known', reason: 'verified-full-checksum-match' });
    await expect(
      classifyFile(
        { ...current, fullChecksum: 'same-full' },
        repository([prior({ ...ambiguous, copyStatus: 'started' })]),
      ),
    ).resolves.toMatchObject({ decision: 'Recoverable' });
  });

  it('prefers verified matches over incomplete matches regardless of repository order', async () => {
    const incomplete = prior({ id: 'a-incomplete', copyStatus: 'started' });
    const verified = prior({ id: 'z-verified', copyStatus: 'verified' });

    for (const files of [
      [incomplete, verified],
      [verified, incomplete],
    ]) {
      await expect(classifyFile(current, repository(files))).resolves.toMatchObject({
        decision: 'Known',
        matchedFileId: 'z-verified',
      });
    }
  });

  it('uses stable ids to break ties between equivalent verified matches', async () => {
    const first = prior({ id: 'a-verified' });
    const second = prior({ id: 'z-verified' });
    await expect(classifyFile(current, repository([second, first]))).resolves.toMatchObject({
      decision: 'Known',
      matchedFileId: 'a-verified',
    });
  });

  it('resolves checksum-disproved same-path and same-size candidates to new', async () => {
    const changedPath = prior({ sizeBytes: 101, fullChecksum: 'old-full' });
    const changedLocation = prior({
      relativePath: 'elsewhere/image.jpg',
      quickFingerprint: 'different',
      fullChecksum: 'old-full',
    });

    for (const candidate of [changedPath, changedLocation]) {
      await expect(
        classifyFile({ ...current, fullChecksum: 'new-full' }, repository([candidate])),
      ).resolves.toMatchObject({
        decision: 'New',
        needsFullChecksum: false,
      });
    }
  });

  it('treats matching records with no prior copy as new rather than recoverable', async () => {
    const neverCopied = prior({ copyStatus: 'none' });
    await expect(classifyFile(current, repository([neverCopied]))).resolves.toMatchObject({
      decision: 'New',
      needsFullChecksum: false,
    });
    await expect(
      classifyFile({ ...current, fullChecksum: 'full-a' }, repository([neverCopied])),
    ).resolves.toMatchObject({
      decision: 'New',
      needsFullChecksum: false,
    });
  });

  it('reports cross-source duplicates without blocking a new v1 file', async () => {
    const duplicate = prior({ sourceId: 'source-b', relativePath: 'other.jpg' });
    const result = await classifyFile(
      { ...current, fullChecksum: 'full-a' },
      repository([duplicate]),
    );
    expect(result).toMatchObject({
      decision: 'New',
      reason: 'no-same-source-match',
      crossSourceDuplicate: { sourceId: 'source-b', fileId: 'prior-1' },
    });
  });

  it('classifies unmatched files as new', async () => {
    await expect(classifyFile(current, repository([]))).resolves.toMatchObject({
      decision: 'New',
      reason: 'no-prior-match',
    });
  });
});

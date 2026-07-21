export type PriorCopyStatus = 'none' | 'planned' | 'started' | 'failed' | 'verified';

export interface FileClassificationInput {
  sourceId: string;
  relativePath: string;
  canonicalPathKey: string;
  sizeBytes: number;
  modifiedAt: string;
  quickFingerprint: string;
  fullChecksum?: string;
}

export interface PriorFile {
  id: string;
  sourceId: string;
  relativePath: string;
  canonicalPathKey: string;
  sizeBytes: number;
  modifiedAt: string;
  quickFingerprint: string;
  fullChecksum: string | null;
  copyStatus: PriorCopyStatus;
}

export interface ClassificationRepository {
  findBySourceAndPath(sourceId: string, relativePath: string): Promise<readonly PriorFile[]>;
  findBySourceAndSize(sourceId: string, sizeBytes: number): Promise<readonly PriorFile[]>;
  findByFullChecksum(checksum: string): Promise<readonly PriorFile[]>;
}

export type ClassificationDecision = 'New' | 'Known' | 'Ambiguous' | 'Recoverable';

export interface FileClassification {
  decision: ClassificationDecision;
  reason:
    | 'verified-exact-match'
    | 'verified-full-checksum-match'
    | 'incomplete-prior-copy'
    | 'same-path-changed-facts'
    | 'same-size-different-path'
    | 'checksum-disproved-candidates'
    | 'unverified-prior-record'
    | 'no-same-source-match'
    | 'no-prior-match';
  needsFullChecksum: boolean;
  matchedFileId?: string;
  crossSourceDuplicate?: { sourceId: string; fileId: string };
}

function known(reason: FileClassification['reason'], file: PriorFile): FileClassification {
  return {
    decision: 'Known',
    reason,
    needsFullChecksum: false,
    matchedFileId: file.id,
  };
}

function recoverable(file: PriorFile): FileClassification {
  return {
    decision: 'Recoverable',
    reason: 'incomplete-prior-copy',
    needsFullChecksum: false,
    matchedFileId: file.id,
  };
}

function newForUncopied(file: PriorFile): FileClassification {
  return {
    decision: 'New',
    reason: 'unverified-prior-record',
    needsFullChecksum: false,
    matchedFileId: file.id,
  };
}

function candidatePriority(file: PriorFile): number {
  if (file.copyStatus === 'verified') return 0;
  if (file.copyStatus !== 'none') return 1;
  return 2;
}

function ordered(files: readonly PriorFile[]): PriorFile[] {
  return [...files].sort(
    (left, right) =>
      candidatePriority(left) - candidatePriority(right) ||
      left.id.localeCompare(right.id, 'en-US'),
  );
}

export async function classifyFile(
  file: FileClassificationInput,
  repository: ClassificationRepository,
): Promise<FileClassification> {
  const pathVersions = ordered(
    await repository.findBySourceAndPath(file.sourceId, file.relativePath),
  );

  if (file.fullChecksum !== undefined) {
    const checksumMatches = ordered(await repository.findByFullChecksum(file.fullChecksum));
    const sameSource = checksumMatches.find((candidate) => candidate.sourceId === file.sourceId);
    if (sameSource !== undefined) {
      if (sameSource.copyStatus === 'verified') {
        return known('verified-full-checksum-match', sameSource);
      }
      return sameSource.copyStatus === 'none'
        ? newForUncopied(sameSource)
        : recoverable(sameSource);
    }

    const sameSize = ordered(
      await repository.findBySourceAndSize(file.sourceId, file.sizeBytes),
    ).filter((candidate) => candidate.relativePath !== file.relativePath);
    const crossSource = checksumMatches.find((candidate) => candidate.sourceId !== file.sourceId);
    return {
      decision: 'New',
      reason:
        pathVersions.length > 0 || sameSize.length > 0
          ? 'checksum-disproved-candidates'
          : crossSource === undefined
            ? 'no-prior-match'
            : 'no-same-source-match',
      needsFullChecksum: false,
      ...(crossSource === undefined
        ? {}
        : { crossSourceDuplicate: { sourceId: crossSource.sourceId, fileId: crossSource.id } }),
    };
  }

  const exact = pathVersions.find(
    (candidate) =>
      candidate.relativePath === file.relativePath &&
      candidate.canonicalPathKey === file.canonicalPathKey &&
      candidate.sizeBytes === file.sizeBytes &&
      candidate.modifiedAt === file.modifiedAt &&
      candidate.quickFingerprint === file.quickFingerprint,
  );
  if (exact !== undefined) {
    if (exact.copyStatus === 'verified') return known('verified-exact-match', exact);
    return exact.copyStatus === 'none' ? newForUncopied(exact) : recoverable(exact);
  }

  if (pathVersions.length > 0) {
    return {
      decision: 'Ambiguous',
      reason: 'same-path-changed-facts',
      needsFullChecksum: true,
      matchedFileId: pathVersions[0]?.id,
    };
  }

  const sameSize = ordered(
    await repository.findBySourceAndSize(file.sourceId, file.sizeBytes),
  ).find((candidate) => candidate.relativePath !== file.relativePath);
  if (sameSize !== undefined) {
    return {
      decision: 'Ambiguous',
      reason: 'same-size-different-path',
      needsFullChecksum: true,
      matchedFileId: sameSize.id,
    };
  }

  return {
    decision: 'New',
    reason: 'no-prior-match',
    needsFullChecksum: false,
  };
}

import { createHash } from 'node:crypto';
import path from 'node:path';

import { sanitizeDestinationSegment } from './destination-segment.js';
import { compileNamingTemplate } from './naming-template.js';
export { sanitizeDestinationSegment } from './destination-segment.js';

export interface DestinationPlanInput {
  root: string;
  captureDate: string | Date;
  captureDay?: string;
  sourceLabelOrCamera: string;
  originalFilename: string;
  checksum: string;
  template?: string;
  /** Available as the opt-in `{nickname}` template token; falls back to `sourceLabelOrCamera`. */
  nickname?: string;
}

export interface DestinationFacts {
  exists: boolean;
  verifiedChecksum?: string;
}

export interface DestinationLookup {
  inspect(destinationPath: string): Promise<DestinationFacts>;
}

export interface DestinationFileSystem {
  lstat(
    destinationPath: string,
  ): Promise<
    { exists: false } | { exists: true; kind: 'file' | 'directory' | 'symlink' | 'other' }
  >;
  realpath(destinationPath: string): Promise<string>;
}

export type DestinationPlan =
  | { kind: 'new'; destinationPath: string }
  | { kind: 'reuse'; destinationPath: string; checksum: string };

function ensureUnderRoot(root: string, destinationPath: string): void {
  const relative = path.relative(root, destinationPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Planned destination escaped the destination root');
  }
}

async function canonicalizeDestination(
  canonicalRoot: string,
  destinationPath: string,
  fileSystem: DestinationFileSystem,
): Promise<string> {
  let ancestor = destinationPath;
  const missingSegments: string[] = [];
  while (ancestor !== canonicalRoot) {
    const facts = await fileSystem.lstat(ancestor);
    if (facts.exists) {
      const canonicalAncestor = await fileSystem.realpath(ancestor);
      if (ancestor !== destinationPath) {
        const canonicalFacts = await fileSystem.lstat(canonicalAncestor);
        if (!canonicalFacts.exists || canonicalFacts.kind !== 'directory') {
          throw new Error('Existing destination ancestor must resolve to a directory');
        }
      }
      const canonicalDestination = path.resolve(canonicalAncestor, ...missingSegments.reverse());
      try {
        ensureUnderRoot(canonicalRoot, canonicalDestination);
      } catch {
        throw new Error('Canonical destination escapes the canonical destination root');
      }
      return canonicalDestination;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      throw new Error('Could not find the canonical destination root');
    }
    missingSegments.push(path.basename(ancestor));
    ancestor = parent;
  }
  const canonicalDestination = path.resolve(canonicalRoot, ...missingSegments.reverse());
  ensureUnderRoot(canonicalRoot, canonicalDestination);
  return canonicalDestination;
}

function suffixFilename(filename: string, suffix: string): string {
  const extension = path.extname(filename);
  const stem = filename.slice(0, filename.length - extension.length);
  return `${stem}-${suffix}${extension}`;
}

function shortChecksum(checksum: string): string {
  const hexadecimal = checksum.toLocaleLowerCase('en-US').match(/[a-f0-9]{8,}/)?.[0];
  return (
    hexadecimal?.slice(0, 8) ?? createHash('sha256').update(checksum).digest('hex').slice(0, 8)
  );
}

export async function planDestination(
  input: DestinationPlanInput,
  lookup: DestinationLookup,
  fileSystem: DestinationFileSystem,
): Promise<DestinationPlan> {
  if (input.checksum.length === 0) throw new Error('A checksum is required to plan a destination');
  const captureDate = new Date(input.captureDate);
  if (Number.isNaN(captureDate.getTime())) throw new Error('A valid capture date is required');

  const root = await fileSystem.realpath(path.resolve(input.root));
  const rootFacts = await fileSystem.lstat(root);
  if (!rootFacts.exists || rootFacts.kind !== 'directory') {
    throw new Error('Canonical destination root must be a directory');
  }
  const utcDay = captureDate.toISOString().slice(0, 10);
  const date = input.captureDay ?? utcDay;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('captureDay must use YYYY-MM-DD');
  }
  const dayInstant = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(dayInstant.getTime()) || dayInstant.toISOString().slice(0, 10) !== date) {
    throw new Error('captureDay must be a valid calendar day');
  }
  const year = date.slice(0, 4);
  const source = sanitizeDestinationSegment(input.sourceLabelOrCamera);
  const filename = sanitizeDestinationSegment(input.originalFilename);
  const relative =
    input.template === undefined
      ? path.join(year, date, source, filename)
      : compileNamingTemplate(input.template, {
          captureDay: date,
          sourceLabelOrCamera: input.sourceLabelOrCamera,
          originalFilename: input.originalFilename,
          ...(input.nickname === undefined ? {} : { nickname: input.nickname }),
        });
  const basePath = path.resolve(root, ...relative.split('/'));
  const directory = path.dirname(basePath);
  ensureUnderRoot(root, directory);
  ensureUnderRoot(root, basePath);
  const plannedFilename = path.basename(basePath);
  const checksumSuffix = shortChecksum(input.checksum);
  for (let attempt = 0; ; attempt += 1) {
    const lexicalCandidate =
      attempt === 0
        ? basePath
        : path.resolve(
            directory,
            suffixFilename(
              plannedFilename,
              attempt === 1 ? checksumSuffix : `${checksumSuffix}-${attempt}`,
            ),
          );
    ensureUnderRoot(root, lexicalCandidate);
    const candidate = await canonicalizeDestination(root, lexicalCandidate, fileSystem);
    const facts = await lookup.inspect(candidate);
    if (!facts.exists) return { kind: 'new', destinationPath: candidate };
    if (facts.verifiedChecksum === input.checksum) {
      return { kind: 'reuse', destinationPath: candidate, checksum: input.checksum };
    }
  }
}

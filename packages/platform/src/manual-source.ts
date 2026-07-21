import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

export interface DirectoryStat {
  isDirectory(): boolean;
}

export interface FileSystemFacts {
  bsize: number;
  blocks: number;
  bavail?: number;
  type?: number;
}

export interface ManualSourceAdapter {
  realpath(selectedPath: string): Promise<string>;
  stat(canonicalPath: string): Promise<DirectoryStat>;
  access(canonicalPath: string, mode: number): Promise<void>;
  statfs?(canonicalPath: string): Promise<FileSystemFacts>;
  /** Best-effort text file read, e.g. for Linux sysfs attributes. Absent files should reject. */
  readFile?(canonicalPath: string): Promise<string>;
}

export interface ManualSourceFacts {
  sourceType: 'folder';
  canonicalRoot: string;
  label: string;
  displayName: string;
  capacityBytes?: number;
  availableBytes?: number;
  filesystem?: string;
}

export const nodeManualSourceAdapter: ManualSourceAdapter = {
  realpath: fs.realpath,
  stat: fs.stat,
  access: fs.access,
  statfs: fs.statfs,
  readFile: (canonicalPath) => fs.readFile(canonicalPath, 'utf8'),
};

function safeByteProduct(left: number, right: number | undefined): number | undefined {
  if (right === undefined) return undefined;
  const result = left * right;
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

export async function getManualSourceFacts(
  selectedPath: string,
  adapter: ManualSourceAdapter = nodeManualSourceAdapter,
): Promise<ManualSourceFacts> {
  const canonicalRoot = await adapter.realpath(selectedPath);
  const stats = await adapter.stat(canonicalRoot);
  if (!stats.isDirectory()) throw new Error(`Selected source is not a directory: ${selectedPath}`);
  try {
    await adapter.access(canonicalRoot, constants.R_OK);
  } catch (error) {
    throw new Error(`Selected source directory is not readable: ${selectedPath}`, { cause: error });
  }

  const label = path.basename(canonicalRoot) || canonicalRoot;
  const result: ManualSourceFacts = {
    sourceType: 'folder',
    canonicalRoot,
    label,
    displayName: label,
  };
  if (adapter.statfs !== undefined) {
    try {
      const filesystem = await adapter.statfs(canonicalRoot);
      const capacityBytes = safeByteProduct(filesystem.bsize, filesystem.blocks);
      const availableBytes = safeByteProduct(filesystem.bsize, filesystem.bavail);
      if (capacityBytes !== undefined) result.capacityBytes = capacityBytes;
      if (availableBytes !== undefined) result.availableBytes = availableBytes;
      if (filesystem.type !== undefined) {
        result.filesystem = `0x${filesystem.type.toString(16)}`;
      }
    } catch {
      // statfs is optional metadata; directory validation above remains authoritative.
    }
  }
  return result;
}

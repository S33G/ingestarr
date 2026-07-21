import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { nodeTransferFileSystem } from '../../platform/src/node-filesystem.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createManifestWriter, type ManifestState } from './manifest-writer.js';

const roots: string[] = [];
const timestamp = '2026-07-19T12:00:00.000Z';

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ingestarr-manifest-'));
  roots.push(root);
  return root;
}

function state(status = 'copying'): ManifestState {
  return {
    session: {
      id: 'session-1',
      sourceId: 'source-1',
      status,
      startedAt: timestamp,
      completedAt: status === 'completed' ? timestamp : null,
      errorCode: null,
      errorMessage: null,
    },
    source: { id: 'source-1', kind: 'folder', displayName: 'CARD' },
    files: [
      {
        id: 'file-1',
        relativePath: 'DCIM/clip.mov',
        sizeBytes: 7,
        modifiedAt: timestamp,
        status: status === 'completed' ? 'completed' : 'copying',
        checksum: status === 'completed' ? 'abc' : null,
        destinationPath: '/library/clip.mov',
        copiedBytes: status === 'completed' ? 7 : 3,
        errorCode: null,
        errorMessage: null,
      },
    ],
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('manifest writer', () => {
  it('uses atomic rename for initial creation and never copy promotion', async () => {
    const root = await makeRoot();
    const manifestPath = path.join(root, 'manifest.json');
    let replacements = 0;
    const fileSystem = {
      ...nodeTransferFileSystem,
      async promoteNoReplace() {
        throw new Error('non-atomic promotion must not be used');
      },
      async replaceAtomic(tempPath: string, destinationPath: string) {
        replacements += 1;
        return nodeTransferFileSystem.replaceAtomic(tempPath, destinationPath);
      },
    };
    const writer = createManifestWriter({
      manifestPath,
      sessionId: 'session-1',
      repository: { loadManifest: async () => state() },
      fileSystem,
      now: () => timestamp,
    });

    await writer.snapshot();

    expect(replacements).toBe(1);
    expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      session: { id: 'session-1' },
    });
  });

  it('exposes no partial initial JSON when atomic rename fails', async () => {
    const root = await makeRoot();
    const manifestPath = path.join(root, 'manifest.json');
    let replacements = 0;
    const writer = createManifestWriter({
      manifestPath,
      sessionId: 'session-1',
      repository: { loadManifest: async () => state() },
      fileSystem: {
        ...nodeTransferFileSystem,
        async replaceAtomic() {
          replacements += 1;
          throw new Error('initial rename fault');
        },
      },
      now: () => timestamp,
    });

    await expect(writer.snapshot()).rejects.toThrow('initial rename fault');
    expect(replacements).toBe(1);
    await expect(readFile(manifestPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await nodeTransferFileSystem.listDirectory(root)).toEqual([]);
  });

  it('writes complete valid snapshots from repository authority and serializes concurrent requests', async () => {
    const root = await makeRoot();
    const manifestPath = path.join(root, 'session-1.manifest.json');
    let current = state();
    const writer = createManifestWriter({
      manifestPath,
      sessionId: 'session-1',
      repository: { loadManifest: async () => current },
      fileSystem: nodeTransferFileSystem,
      now: () => timestamp,
    });

    await Promise.all([writer.snapshot(), writer.snapshot(), writer.snapshot()]);
    current = state('completed');
    await writer.snapshot();

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      generatedAt: timestamp,
      session: { id: 'session-1', status: 'completed', completedAt: timestamp },
      source: { id: 'source-1' },
    });
    expect(manifest.files as unknown[]).toHaveLength(1);
    expect(await nodeTransferFileSystem.listDirectory(root)).toEqual(['session-1.manifest.json']);
  });

  it('preserves the prior valid snapshot when replacement fails', async () => {
    const root = await makeRoot();
    const manifestPath = path.join(root, 'manifest.json');
    let current = state();
    const base = {
      manifestPath,
      sessionId: 'session-1',
      repository: { loadManifest: async () => current },
      now: () => timestamp,
    };
    const first = createManifestWriter({ ...base, fileSystem: nodeTransferFileSystem });
    await first.snapshot();
    const previous = await readFile(manifestPath, 'utf8');
    current = state('completed');
    const broken = createManifestWriter({
      ...base,
      fileSystem: {
        ...nodeTransferFileSystem,
        async replaceAtomic() {
          throw new Error('replacement fault');
        },
      },
    });

    await expect(broken.snapshot()).rejects.toThrow('replacement fault');
    expect(await readFile(manifestPath, 'utf8')).toBe(previous);
    expect(JSON.parse(previous)).toBeDefined();
    expect(await nodeTransferFileSystem.listDirectory(root)).toEqual(['manifest.json']);
  });
});

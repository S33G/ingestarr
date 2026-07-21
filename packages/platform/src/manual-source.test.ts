import { constants } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getManualSourceFacts, nodeManualSourceAdapter } from './manual-source.js';

describe('getManualSourceFacts', () => {
  it('canonicalizes and validates a selected readable directory without shelling out', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'ingestarr-source-'));
    const selected = path.join(parent, 'My Card');
    await mkdir(selected);

    const facts = await getManualSourceFacts(selected);

    expect(facts).toMatchObject({
      sourceType: 'folder',
      canonicalRoot: await nodeManualSourceAdapter.realpath(selected),
      label: 'My Card',
      displayName: 'My Card',
    });
    expect(facts.capacityBytes === undefined || facts.capacityBytes > 0).toBe(true);
  });

  it('rejects files and unreadable directories', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'ingestarr-source-'));
    const file = path.join(parent, 'file');
    await writeFile(file, 'x');
    await expect(getManualSourceFacts(file)).rejects.toThrow(/directory/i);

    await expect(
      getManualSourceFacts(parent, {
        ...nodeManualSourceAdapter,
        access: async (_path, mode) => {
          expect(mode).toBe(constants.R_OK);
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        },
      }),
    ).rejects.toThrow(/readable/i);
  });

  it('supports the platform adapter interface when statfs facts are unavailable', async () => {
    const facts = await getManualSourceFacts('/selected/card', {
      realpath: async () => '/canonical/card',
      stat: async () => ({ isDirectory: () => true }),
      access: async () => undefined,
    });
    expect(facts).toEqual({
      sourceType: 'folder',
      canonicalRoot: '/canonical/card',
      label: 'card',
      displayName: 'card',
    });
  });
});

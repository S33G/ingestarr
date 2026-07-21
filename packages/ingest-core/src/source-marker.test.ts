import { describe, expect, it } from 'vitest';

import {
  appendSourceEventLog,
  parseSourceMarker,
  readSourceMarker,
  sourceEventLogPath,
  sourceMarkerDirectory,
  sourceMarkerPath,
  writeSourceMarker,
  type SourceMarkerFileSystem,
} from './source-marker.js';

function fakeFileSystem(initialFiles: Record<string, string> = {}): SourceMarkerFileSystem & {
  files: Record<string, string>;
  mkdirCalls: string[];
} {
  const files = { ...initialFiles };
  const mkdirCalls: string[] = [];
  return {
    files,
    mkdirCalls,
    async mkdir(path) {
      mkdirCalls.push(path);
    },
    async writeFile(path, text) {
      files[path] = text;
    },
    async appendFile(path, text) {
      files[path] = (files[path] ?? '') + text;
    },
    async readFile(path) {
      const contents = files[path];
      if (contents === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return contents;
    },
  };
}

describe('sourceMarkerPath / sourceMarkerDirectory / sourceEventLogPath', () => {
  it('places the marker and event log under a .ingestarr directory on the mount itself', () => {
    expect(sourceMarkerDirectory('/Volumes/EOS_DIGITAL')).toBe('/Volumes/EOS_DIGITAL/.ingestarr');
    expect(sourceMarkerPath('/Volumes/EOS_DIGITAL')).toBe(
      '/Volumes/EOS_DIGITAL/.ingestarr/card.json',
    );
    expect(sourceEventLogPath('/Volumes/EOS_DIGITAL')).toBe(
      '/Volumes/EOS_DIGITAL/.ingestarr/events.log',
    );
  });

  it('supports a custom join for platform-specific path conventions (e.g. Windows)', () => {
    const win32Join = (...segments: string[]) => segments.join('\\');
    expect(sourceMarkerPath('E:', { join: win32Join })).toBe('E:\\.ingestarr\\card.json');
  });
});

describe('writeSourceMarker', () => {
  it('creates the .ingestarr directory and writes a JSON marker with the given identity', async () => {
    const fs = fakeFileSystem();
    await writeSourceMarker(fs, '/Volumes/EOS_DIGITAL', {
      sourceId: 'source-abc123',
      nickname: 'Big Card',
      createdAt: '2026-07-20T10:00:00.000Z',
      updatedAt: '2026-07-20T10:00:00.000Z',
    });
    expect(fs.mkdirCalls).toEqual(['/Volumes/EOS_DIGITAL/.ingestarr']);
    const written = fs.files['/Volumes/EOS_DIGITAL/.ingestarr/card.json'];
    expect(written).toBeDefined();
    expect(JSON.parse(written ?? '')).toEqual({
      schemaVersion: 1,
      sourceId: 'source-abc123',
      nickname: 'Big Card',
      createdAt: '2026-07-20T10:00:00.000Z',
      updatedAt: '2026-07-20T10:00:00.000Z',
    });
  });

  it('propagates write failures so best-effort handling is the caller\'s choice', async () => {
    const fs = fakeFileSystem();
    fs.writeFile = async () => Promise.reject(new Error('read-only filesystem'));
    await expect(
      writeSourceMarker(fs, '/Volumes/RO_CARD', {
        sourceId: 'source-1',
        nickname: null,
        createdAt: 'x',
        updatedAt: 'x',
      }),
    ).rejects.toThrow('read-only filesystem');
  });
});

describe('appendSourceEventLog', () => {
  it('lazily creates the directory and appends lines', async () => {
    const fs = fakeFileSystem();
    await appendSourceEventLog(fs, '/Volumes/EOS_DIGITAL', 'line one\n');
    await appendSourceEventLog(fs, '/Volumes/EOS_DIGITAL', 'line two\n');
    expect(fs.files['/Volumes/EOS_DIGITAL/.ingestarr/events.log']).toBe('line one\nline two\n');
  });
});

describe('parseSourceMarker', () => {
  it('accepts a well-formed marker', () => {
    expect(
      parseSourceMarker({
        schemaVersion: 1,
        sourceId: 'source-1',
        nickname: 'Big',
        createdAt: 'a',
        updatedAt: 'b',
      }),
    ).toEqual({
      schemaVersion: 1,
      sourceId: 'source-1',
      nickname: 'Big',
      createdAt: 'a',
      updatedAt: 'b',
    });
  });

  it('accepts a null nickname', () => {
    expect(
      parseSourceMarker({
        schemaVersion: 1,
        sourceId: 'source-1',
        nickname: null,
        createdAt: 'a',
        updatedAt: 'b',
      })?.nickname,
    ).toBeNull();
  });

  it.each([
    ['not an object', 'plain string'],
    [null, 'null'],
    [{ schemaVersion: 2, sourceId: 's', nickname: null, createdAt: 'a', updatedAt: 'b' }, 'wrong schema version'],
    [{ schemaVersion: 1, sourceId: '', nickname: null, createdAt: 'a', updatedAt: 'b' }, 'empty sourceId'],
    [{ schemaVersion: 1, nickname: null, createdAt: 'a', updatedAt: 'b' }, 'missing sourceId'],
    [{ schemaVersion: 1, sourceId: 's', nickname: 42, createdAt: 'a', updatedAt: 'b' }, 'non-string nickname'],
    [{ schemaVersion: 1, sourceId: 's', nickname: null, updatedAt: 'b' }, 'missing createdAt'],
  ])('rejects malformed input: %s', (input) => {
    expect(parseSourceMarker(input)).toBeUndefined();
  });
});

describe('readSourceMarker', () => {
  it('reads back a marker written earlier', async () => {
    const fs = fakeFileSystem();
    await writeSourceMarker(fs, '/Volumes/EOS_DIGITAL', {
      sourceId: 'source-abc123',
      nickname: 'Big Card',
      createdAt: 'a',
      updatedAt: 'b',
    });
    const marker = await readSourceMarker(fs, '/Volumes/EOS_DIGITAL');
    expect(marker?.sourceId).toBe('source-abc123');
    expect(marker?.nickname).toBe('Big Card');
  });

  it('returns undefined when the marker file does not exist', async () => {
    const fs = fakeFileSystem();
    expect(await readSourceMarker(fs, '/Volumes/UNMARKED')).toBeUndefined();
  });

  it('returns undefined (rather than throwing) for corrupt JSON', async () => {
    const fs = fakeFileSystem({
      '/Volumes/CORRUPT/.ingestarr/card.json': '{not valid json',
    });
    expect(await readSourceMarker(fs, '/Volumes/CORRUPT')).toBeUndefined();
  });

  it('returns undefined for well-formed JSON that does not match the marker shape', async () => {
    const fs = fakeFileSystem({
      '/Volumes/WRONGSHAPE/.ingestarr/card.json': JSON.stringify({ foo: 'bar' }),
    });
    expect(await readSourceMarker(fs, '/Volumes/WRONGSHAPE')).toBeUndefined();
  });

  it('returns undefined when the underlying read rejects for a reason other than ENOENT', async () => {
    const fs = fakeFileSystem();
    fs.readFile = async () => Promise.reject(new Error('device disconnected'));
    expect(await readSourceMarker(fs, '/Volumes/GONE')).toBeUndefined();
  });
});

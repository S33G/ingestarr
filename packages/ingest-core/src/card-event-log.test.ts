import { describe, expect, it } from 'vitest';

import { cardEventLogPath, createCardEventLogSink } from './card-event-log.js';

describe('cardEventLogPath', () => {
  it('places the log under a .ingestarr directory named after the card', () => {
    expect(cardEventLogPath('/Archive', 'canon-r5')).toBe('/Archive/.ingestarr/canon-r5.log');
  });

  it('sanitizes unsafe characters out of the card identifier', () => {
    expect(cardEventLogPath('/Archive', 'CON')).toBe('/Archive/.ingestarr/_CON.log');
    expect(cardEventLogPath('/Archive', 'a/b', { platform: 'posix' })).toBe(
      '/Archive/.ingestarr/a_b.log',
    );
  });
});

describe('createCardEventLogSink', () => {
  it('lazily creates the .ingestarr directory once and appends every write', async () => {
    const mkdirCalls: Array<{ path: string; options: { recursive: true } }> = [];
    const appended: string[] = [];
    const sink = createCardEventLogSink(
      {
        mkdir: async (path, options) => {
          mkdirCalls.push({ path, options });
        },
        appendFile: async (_path, text) => {
          appended.push(text);
        },
      },
      '/Archive',
      'canon-r5',
    );

    await sink.write('line one\n');
    await sink.write('line two\n');

    expect(mkdirCalls).toEqual([{ path: '/Archive/.ingestarr', options: { recursive: true } }]);
    expect(appended).toEqual(['line one\n', 'line two\n']);
  });

  it('propagates append failures without masking them', async () => {
    const sink = createCardEventLogSink(
      {
        mkdir: async () => undefined,
        appendFile: async () => Promise.reject(new Error('disk full')),
      },
      '/Archive',
      'canon-r5',
    );
    await expect(sink.write('line\n')).rejects.toThrow('disk full');
  });
});

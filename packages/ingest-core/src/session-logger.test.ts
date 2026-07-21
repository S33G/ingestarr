import { describe, expect, it } from 'vitest';

import { combineLogSinks, createSessionLogger } from './session-logger.js';

describe('session logger', () => {
  it('writes structured JSON-lines and human text with optional path redaction', async () => {
    const structured: string[] = [];
    const human: string[] = [];
    const logger = createSessionLogger({
      sessionId: 'session-1',
      now: () => '2026-07-19T12:00:00.000Z',
      redactPaths: true,
      structuredSink: { write: async (line) => structured.push(line) },
      textSink: { write: async (line) => human.push(line) },
    });

    await logger.log({
      level: 'info',
      sourceId: 'source-1',
      phase: 'copy',
      sourcePath: '/Volumes/CARD/DCIM/clip.mov',
      destinationPath: '/Archive/clip.mov',
      bytes: 42,
      message: 'copied',
    });

    expect(JSON.parse(structured[0] ?? '')).toMatchObject({
      timestamp: '2026-07-19T12:00:00.000Z',
      sessionId: 'session-1',
      sourceId: 'source-1',
      sourcePath: '[redacted]',
      destinationPath: '[redacted]',
      bytes: 42,
    });
    expect(structured[0]).toMatch(/\n$/);
    expect(human[0]).toContain('copy copied');
    expect(human[0]).not.toContain('/Volumes');
  });

  it('contains sink failures and reports them without throwing', async () => {
    const failures: unknown[] = [];
    const logger = createSessionLogger({
      sessionId: 'session-1',
      structuredSink: { write: async () => Promise.reject(new Error('log disk full')) },
      textSink: { write: async () => Promise.reject(new Error('text disk full')) },
      onSinkError: (error) => failures.push(error),
    });

    await expect(logger.log({ level: 'error', phase: 'verify', message: 'failed' })).resolves.toBe(
      undefined,
    );
    expect(failures).toHaveLength(2);
  });

  it('contains failures thrown by the sink-error observer', async () => {
    let observerCalls = 0;
    const logger = createSessionLogger({
      sessionId: 'session-1',
      structuredSink: { write: async () => Promise.reject(new Error('structured failed')) },
      textSink: { write: async () => Promise.reject(new Error('text failed')) },
      onSinkError: () => {
        observerCalls += 1;
        throw new Error('observer failed');
      },
    });

    await expect(
      logger.log({ level: 'error', phase: 'copy', message: 'transfer failed' }),
    ).resolves.toBeUndefined();
    expect(observerCalls).toBe(2);
  });
});

describe('combineLogSinks', () => {
  it('fans a single write out to every sink', async () => {
    const a: string[] = [];
    const b: string[] = [];
    const sink = combineLogSinks(
      { write: async (line) => a.push(line) },
      {
        write: async (line) => b.push(line),
      },
    );
    await sink.write('one line\n');
    expect(a).toEqual(['one line\n']);
    expect(b).toEqual(['one line\n']);
  });

  it('tolerates one sink failing as long as another succeeds', async () => {
    const ok: string[] = [];
    const sink = combineLogSinks(
      { write: async () => Promise.reject(new Error('disk full')) },
      { write: async (line) => ok.push(line) },
    );
    await expect(sink.write('line\n')).resolves.toBeUndefined();
    expect(ok).toEqual(['line\n']);
  });

  it('rejects only when every sink fails', async () => {
    const sink = combineLogSinks(
      { write: async () => Promise.reject(new Error('a failed')) },
      { write: async () => Promise.reject(new Error('b failed')) },
    );
    await expect(sink.write('line\n')).rejects.toThrow(/failed/);
  });
});

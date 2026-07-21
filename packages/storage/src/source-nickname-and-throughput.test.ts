import { describe, expect, it } from 'vitest';

import { createRepositories, migrateDatabase, openDatabase } from './index.js';

const now = '2026-07-19T12:00:00.000Z';
const later = '2026-07-19T12:05:00.000Z';

function setup() {
  const connection = openDatabase(':memory:');
  migrateDatabase(connection.database);
  const repositories = createRepositories(connection.database);
  repositories.sources.create({
    id: 'source-1',
    kind: 'removable-volume',
    displayName: 'CARD',
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return { connection, repositories };
}

describe('source nickname', () => {
  it('defaults to null and can be set and cleared', () => {
    const { connection, repositories } = setup();
    expect(repositories.sources.findById('source-1')?.nickname).toBeNull();

    const updated = repositories.sources.setNickname('source-1', 'canon-r5', later);
    expect(updated.nickname).toBe('canon-r5');
    expect(repositories.sources.findById('source-1')?.nickname).toBe('canon-r5');

    const cleared = repositories.sources.setNickname('source-1', null, later);
    expect(cleared.nickname).toBeNull();
    connection.close();
  });

  it('throws when the source does not exist', () => {
    const { connection, repositories } = setup();
    expect(() => repositories.sources.setNickname('missing', 'canon-r5', later)).toThrow();
    connection.close();
  });

  it('rejects non-kebab-case nicknames at the database layer as a backstop', () => {
    const { connection } = setup();
    expect(() =>
      connection.database
        .prepare('UPDATE sources SET nickname = ?, updated_at = ? WHERE id = ?')
        .run('Canon R5', later, 'source-1'),
    ).toThrow();
    expect(() =>
      connection.database
        .prepare('UPDATE sources SET nickname = ?, updated_at = ? WHERE id = ?')
        .run('-canon', later, 'source-1'),
    ).toThrow();
    expect(() =>
      connection.database
        .prepare('UPDATE sources SET nickname = ?, updated_at = ? WHERE id = ?')
        .run('canon--r5', later, 'source-1'),
    ).toThrow();
    connection.close();
  });
});

describe('source throughput stats', () => {
  it('tracks a running average and the most recent sample', () => {
    const { connection, repositories } = setup();
    expect(repositories.throughputStats.findForSource('source-1')).toBeUndefined();

    const first = repositories.throughputStats.recordSample('source-1', 10_000_000, now);
    expect(first).toEqual({
      sourceId: 'source-1',
      sampleCount: 1,
      averageBytesPerSecond: 10_000_000,
      lastBytesPerSecond: 10_000_000,
      updatedAt: now,
    });

    const second = repositories.throughputStats.recordSample('source-1', 2_000_000, later);
    expect(second.sampleCount).toBe(2);
    expect(second.averageBytesPerSecond).toBe(6_000_000);
    expect(second.lastBytesPerSecond).toBe(2_000_000);

    expect(repositories.throughputStats.findForSource('source-1')).toEqual(second);
    connection.close();
  });
});

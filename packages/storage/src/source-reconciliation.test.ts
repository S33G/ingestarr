import { describe, expect, it } from 'vitest';

import { createRepositories, migrateDatabase, openDatabase } from './index.js';

const now = '2026-07-19T12:00:00.000Z';

describe('source reconciliation persistence', () => {
  it('atomically persists confirmed observations, aliases, and an audit decision', () => {
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

    repositories.identityObservations.confirm({
      observation: {
        id: 'observation-1',
        sourceId: 'source-1',
        observedAt: now,
        algorithmVersion: 1,
        fingerprint: 'source-fallback-v1:new',
        rawFacts: { label: 'card' },
        confidence: 'medium',
        strongPlatformId: 'volume-1',
        createdAt: now,
        updatedAt: now,
      },
      decision: {
        id: 'decision-1',
        detectedKey: 'opaque-device-key',
        kind: 'confirmed-existing',
        reasons: ['fallback-match', 'user-confirmed'],
        decidedAt: now,
      },
    });

    expect(repositories.identityObservations.listAliases('source-1')).toEqual([
      {
        algorithmVersion: 1,
        fingerprint: 'source-fallback-v1:new',
        firstObservedAt: now,
        lastObservedAt: now,
      },
    ]);
    expect(repositories.identityObservations.listAudit('source-1')).toEqual([
      expect.objectContaining({
        id: 'decision-1',
        detectedKey: 'opaque-device-key',
        kind: 'confirmed-existing',
        reasons: ['fallback-match', 'user-confirmed'],
      }),
    ]);
    connection.close();
  });

  it('rolls back the entire confirmation when the source does not exist', () => {
    const connection = openDatabase(':memory:');
    migrateDatabase(connection.database);
    const repositories = createRepositories(connection.database);
    expect(() =>
      repositories.identityObservations.confirm({
        observation: {
          id: 'observation-1',
          sourceId: 'missing',
          observedAt: now,
          algorithmVersion: 1,
          fingerprint: 'source-fallback-v1:new',
          rawFacts: {},
          confidence: 'medium',
          strongPlatformId: null,
          createdAt: now,
          updatedAt: now,
        },
        decision: {
          id: 'decision-1',
          detectedKey: 'opaque-device-key',
          kind: 'created-new',
          reasons: ['user-confirmed'],
          decidedAt: now,
        },
      }),
    ).toThrow();
    expect(
      connection.database.prepare('SELECT COUNT(*) FROM source_reconciliation_audit').pluck().get(),
    ).toBe(0n);
    connection.close();
  });
});

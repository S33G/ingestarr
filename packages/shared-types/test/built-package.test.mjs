import assert from 'node:assert/strict';

const sharedTypes = await import('@ingestarr/shared-types');

assert.equal(
  sharedTypes.healthResponseSchema.parse({
    status: 'ok',
    version: '0.0.0',
    checkedAt: '2026-07-19T12:00:00.000Z',
  }).status,
  'ok',
);

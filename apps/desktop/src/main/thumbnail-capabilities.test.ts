import { describe, expect, it } from 'vitest';

import { ThumbnailCapabilityStore } from './thumbnail-capabilities';

describe('thumbnail capabilities', () => {
  it('is opaque, expiring, window-scoped, and reusable until it expires', () => {
    // Reading a thumbnail is idempotent, and React's StrictMode double-invokes effects on
    // mount in development, which can consume the same freshly-issued token twice in quick
    // succession before either request completes. A single-use token would make the second
    // (or the first, if its response arrives after cleanup toggles `active` off) request fail,
    // leaving the thumbnail stuck showing "Loading thumbnail…" forever. So, unlike a one-time
    // action capability, this token must stay valid for repeat reads within its TTL.
    let now = 1_000;
    const store = new ThumbnailCapabilityStore({
      now: () => now,
      id: () => 'opaque-token',
      ttlMs: 100,
    });
    const issued = store.issue(4, 'thumbnail-row-id');

    expect(issued).toEqual({ token: 'opaque-token', expiresAt: new Date(1_100).toISOString() });
    expect(() => store.consume('opaque-token', 5)).toThrow(/scope/i);
    expect(store.consume('opaque-token', 4)).toBe('thumbnail-row-id');
    expect(store.consume('opaque-token', 4)).toBe('thumbnail-row-id');

    now = 1_101;
    expect(() => store.consume('opaque-token', 4)).toThrow(/expired/i);
  });

  it('revokes every token owned by a destroyed window', () => {
    let id = 0;
    const store = new ThumbnailCapabilityStore({ id: () => `token-${String(++id)}` });
    const first = store.issue(2, 'a');
    const second = store.issue(3, 'b');
    store.revokeWindow(2);

    expect(() => store.consume(first.token, 2)).toThrow(/invalid/i);
    expect(store.consume(second.token, 3)).toBe('b');
  });
});

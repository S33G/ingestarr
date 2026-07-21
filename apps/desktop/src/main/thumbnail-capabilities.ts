import { randomUUID } from 'node:crypto';

import { CapabilityError } from './security';

interface Grant {
  windowId: number;
  reference: string;
  expiresAtMs: number;
}

export class ThumbnailCapabilityStore {
  readonly #grants = new Map<string, Grant>();
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #ttlMs: number;

  constructor(options: { now?: () => number; id?: () => string; ttlMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
    this.#ttlMs = options.ttlMs ?? 60_000;
  }

  issue(windowId: number, reference: string): { token: string; expiresAt: string } {
    const token = this.#id();
    const expiresAtMs = this.#now() + this.#ttlMs;
    this.#grants.set(token, { windowId, reference, expiresAtMs });
    return { token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  // Reading a thumbnail is idempotent, so this token intentionally stays valid for repeat
  // reads until it expires or its window closes, rather than being consumed on first use. A
  // single-use token would fail the moment anything issues two reads for the same token before
  // either completes — most notably React StrictMode's double-invoked mount effects in
  // development, which would otherwise leave a thumbnail stuck loading forever.
  consume(token: string, windowId: number): string {
    const grant = this.#grants.get(token);
    if (grant === undefined) throw new Error('Thumbnail capability is invalid');
    if (grant.expiresAtMs < this.#now()) {
      this.#grants.delete(token);
      throw new Error('Thumbnail capability has expired');
    }
    if (grant.windowId !== windowId) throw new Error('Thumbnail capability scope is invalid');
    return grant.reference;
  }

  revokeWindow(windowId: number): void {
    for (const [token, grant] of this.#grants) {
      if (grant.windowId === windowId) this.#grants.delete(token);
    }
  }

  clear(): void {
    this.#grants.clear();
  }
}

interface RetryGrant {
  windowId: number;
  copyId: string;
  variant: 'grid';
  expiresAtMs: number;
}

export class ThumbnailRetryCapabilityStore {
  readonly #grants = new Map<string, RetryGrant>();
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #ttlMs: number;

  constructor(options: { now?: () => number; id?: () => string; ttlMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
    this.#ttlMs = options.ttlMs ?? 60_000;
  }

  issue(
    windowId: number,
    retry: Pick<RetryGrant, 'copyId' | 'variant'>,
  ): { token: string; expiresAt: string } {
    const token = this.#id();
    const expiresAtMs = this.#now() + this.#ttlMs;
    this.#grants.set(token, { windowId, ...retry, expiresAtMs });
    return { token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  consume(token: string, windowId: number): Pick<RetryGrant, 'copyId' | 'variant'> {
    const grant = this.#grants.get(token);
    if (grant === undefined) {
      throw new CapabilityError('CAPABILITY_INVALID', 'Thumbnail retry capability is invalid');
    }
    if (grant.expiresAtMs < this.#now()) {
      this.#grants.delete(token);
      throw new CapabilityError('CAPABILITY_EXPIRED', 'Thumbnail retry capability has expired');
    }
    if (grant.windowId !== windowId) {
      throw new CapabilityError(
        'CAPABILITY_INVALID',
        'Thumbnail retry capability scope is invalid',
      );
    }
    this.#grants.delete(token);
    return { copyId: grant.copyId, variant: grant.variant };
  }

  revokeWindow(windowId: number): void {
    for (const [token, grant] of this.#grants) {
      if (grant.windowId === windowId) this.#grants.delete(token);
    }
  }

  clear(): void {
    this.#grants.clear();
  }
}

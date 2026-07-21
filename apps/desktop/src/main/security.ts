import { randomUUID } from 'node:crypto';

export type CapabilityKind = 'source' | 'destination';

interface Capability {
  id: string;
  windowId: number;
  kind: CapabilityKind;
  path: string;
  label: string;
  expiresAtMs: number;
  provenance?: { type: 'detected-source'; detectedSourceId: string };
}

export class CapabilityError extends Error {
  constructor(
    public readonly code: 'CAPABILITY_INVALID' | 'CAPABILITY_EXPIRED',
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityError';
  }
}

export class CapabilityStore {
  readonly #capabilities = new Map<string, Capability>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #id: () => string;

  constructor(options: { now?: () => number; ttlMs?: number; id?: () => string } = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 10 * 60_000;
    this.#id = options.id ?? randomUUID;
  }

  issue(input: {
    windowId: number;
    kind: CapabilityKind;
    path: string;
    label: string;
    provenance?: Capability['provenance'];
  }): {
    id: string;
    expiresAt: string;
  } {
    const capability: Capability = {
      id: this.#id(),
      ...input,
      expiresAtMs: this.#now() + this.#ttlMs,
    };
    this.#capabilities.set(capability.id, capability);
    return { id: capability.id, expiresAt: new Date(capability.expiresAtMs).toISOString() };
  }

  resolve(id: string, windowId: number, kind: CapabilityKind): Capability {
    const label = kind === 'source' ? 'Source' : 'Destination';
    const capability = this.#capabilities.get(id);
    if (capability === undefined) {
      throw new CapabilityError(
        'CAPABILITY_INVALID',
        `${label} folder capability is invalid. Choose the ${kind} folder again.`,
      );
    }
    if (capability.expiresAtMs < this.#now()) {
      this.#capabilities.delete(id);
      throw new CapabilityError(
        'CAPABILITY_EXPIRED',
        `${label} folder capability has expired. Choose the ${kind} folder again.`,
      );
    }
    if (capability.windowId !== windowId || capability.kind !== kind) {
      throw new CapabilityError(
        'CAPABILITY_INVALID',
        `${label} folder capability scope is invalid. Choose the ${kind} folder again.`,
      );
    }
    return capability;
  }

  consume(id: string, windowId: number, kind: CapabilityKind): Capability {
    const capability = this.resolve(id, windowId, kind);
    this.#capabilities.delete(id);
    return capability;
  }

  revokeWindow(windowId: number): void {
    for (const [id, capability] of this.#capabilities) {
      if (capability.windowId === windowId) this.#capabilities.delete(id);
    }
  }
}

interface IpcEventLike {
  sender: { id: number };
  senderFrame: { url: string; top?: unknown } | null;
}

function normalizedUrl(value: string): string | null {
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

export function authorizeIpcSender(
  event: IpcEventLike,
  expected: { webContentsId: number; rendererUrl: string },
): void {
  const frame = event.senderFrame;
  // Compare normalized URLs rather than raw strings: Electron/Chromium
  // normalizes a loaded root URL like `http://localhost:5173` to
  // `http://localhost:5173/` (trailing slash), but the dev server URL
  // supplied by the Vite tooling has no trailing slash. Normalizing both
  // sides with the same `URL` parser makes the comparison canonical while
  // still requiring an exact match on protocol, host, port, and path.
  const frameUrl = frame === null ? null : normalizedUrl(frame.url);
  const expectedUrl = normalizedUrl(expected.rendererUrl);
  if (
    event.sender.id !== expected.webContentsId ||
    frame === null ||
    frame.top !== frame ||
    frameUrl === null ||
    expectedUrl === null ||
    frameUrl !== expectedUrl
  ) {
    throw new Error('Unauthorized IPC sender');
  }
}

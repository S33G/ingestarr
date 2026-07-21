import { randomUUID } from 'node:crypto';

import {
  PlatformAvailabilityError,
  type AsyncDisposer,
  type MountedSourceInfo,
  type PlatformAdapter,
} from '@ingestarr/platform';

export interface RegisteredDetectedSource {
  id: string;
  label: string;
  kind: MountedSourceInfo['sourceType'];
  online: boolean;
  canonicalMountPath: string;
  platformVolumeId?: string;
  /** Set once this volume has been definitively resolved to an existing known source — either
   * authoritatively via its on-card identity marker, or via a strong platform-id match. Lets
   * the UI collapse the detected volume and its known source into a single card. */
  knownSourceId?: string;
  knownNickname?: string | null;
  facts: MountedSourceInfo;
}

/** Resolves a mounted volume to an existing known source, if any. Returns `undefined` for a
 * card the app has never recorded before. Kept async because the authoritative signal — the
 * on-card `.ingestarr/card.json` marker — has to be read from the filesystem. */
export type DetectedSourceIdentityResolver = (
  source: MountedSourceInfo,
) => Promise<{ sourceId: string; nickname: string | null } | undefined>;

/** Invoked when a removable volume comes online, so higher layers can react to a hotplug
 * insertion (e.g. auto-ingest). Fired only for genuinely new arrivals, not on the initial
 * scan of already-mounted volumes. */
export type DetectedSourceArrivalListener = (source: RegisteredDetectedSource) => void;

export class DetectedSourceRegistry {
  readonly #adapter: PlatformAdapter;
  readonly #id: () => string;
  readonly #resolveIdentity?: DetectedSourceIdentityResolver;
  readonly #entries = new Map<string, RegisteredDetectedSource>();
  readonly #listeners = new Set<() => void>();
  readonly #arrivalListeners = new Set<DetectedSourceArrivalListener>();
  #starting: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #disposers: AsyncDisposer[] = [];

  constructor(
    adapter: PlatformAdapter,
    options: { id?: () => string; resolveIdentity?: DetectedSourceIdentityResolver } = {},
  ) {
    this.#adapter = adapter;
    this.#id = options.id ?? randomUUID;
    this.#resolveIdentity = options.resolveIdentity;
  }

  start(): Promise<void> {
    this.#starting ??= (async () => {
      try {
        const mounted = await this.#adapter.listMountedSources();
        for (const source of mounted) this.#upsert(source, true, false, false);
        const arrival = await this.#adapter.watchSourceArrival((source) => {
          this.#upsert(source, true, true, true);
        });
        try {
          const removal = await this.#adapter.watchSourceRemoval((source) => {
            this.#remove(source);
          });
          this.#disposers.push(arrival, removal);
        } catch (error) {
          await arrival();
          throw error;
        }
      } catch (error) {
        if (!(error instanceof PlatformAvailabilityError)) throw error;
      }
      this.#notify();
    })();
    return this.#starting;
  }

  list(): RegisteredDetectedSource[] {
    return [...this.#entries.values()].sort((left, right) =>
      left.id.localeCompare(right.id, 'en-US'),
    );
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Notified when a removable volume is newly inserted (hotplug), after its identity has been
   * resolved. Used to drive auto-ingest. */
  onArrival(listener: DetectedSourceArrivalListener): () => void {
    this.#arrivalListeners.add(listener);
    return () => this.#arrivalListeners.delete(listener);
  }

  /** Re-resolves a still-mounted volume's known-source identity on demand — used right after a
   * card is named/registered, so the freshly created known source is linked to the detected
   * volume immediately (collapsing the "new card" into a single deduplicated entry) instead of
   * waiting for the next poll cycle. Resolves once the identity has been applied and observers
   * notified. */
  async refreshIdentity(detectedSourceId: string): Promise<void> {
    if (this.#resolveIdentity === undefined) return;
    const entry = [...this.#entries.values()].find((source) => source.id === detectedSourceId);
    if (entry === undefined || !entry.online) return;
    const key = this.#identityKey(entry.facts);
    try {
      const resolved = await this.#resolveIdentity(entry.facts);
      const current = this.#entries.get(key);
      if (current === undefined || current.id !== entry.id || resolved === undefined) return;
      current.knownSourceId = resolved.sourceId;
      current.knownNickname = resolved.nickname;
      this.#notify();
    } catch {
      // A failed re-resolution simply leaves the volume as-is; the next poll cycle retries.
    }
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      try {
        await this.#starting;
      } finally {
        await Promise.allSettled(this.#disposers.splice(0).map((dispose) => dispose()));
        this.#listeners.clear();
        this.#arrivalListeners.clear();
      }
    })();
    return this.#closing;
  }

  #identityKey(source: MountedSourceInfo): string {
    return source.platformVolumeId === undefined
      ? `path:${source.canonicalMountPath}`
      : `strong:${source.platformVolumeId}`;
  }

  #upsert(source: MountedSourceInfo, online: boolean, notify: boolean, arrival: boolean): void {
    const key = this.#identityKey(source);
    const existing = this.#entries.get(key);
    const next: RegisteredDetectedSource = {
      id: existing?.id ?? this.#id(),
      label: source.volumeLabel?.trim() || source.displayName,
      kind: source.sourceType,
      online,
      canonicalMountPath: source.canonicalMountPath,
      ...(source.platformVolumeId === undefined
        ? {}
        : { platformVolumeId: source.platformVolumeId }),
      // Carry any previously resolved identity forward so a removal event (which only flips
      // `online`) doesn't discard it.
      ...(existing?.knownSourceId === undefined ? {} : { knownSourceId: existing.knownSourceId }),
      ...(existing?.knownNickname === undefined ? {} : { knownNickname: existing.knownNickname }),
      facts: source,
    };
    this.#entries.set(key, next);
    if (notify) this.#notify();
    // Resolve identity (and, on a genuine hotplug arrival, announce it) once the volume is
    // online. Done asynchronously so filesystem reads for the on-card marker never block the
    // detection callback; a follow-up notify surfaces the resolved identity to the UI.
    if (online && this.#resolveIdentity !== undefined) {
      void this.#resolveIdentity(source)
        .then((resolved) => {
          const current = this.#entries.get(key);
          if (current === undefined || current.id !== next.id) return;
          if (resolved !== undefined) {
            current.knownSourceId = resolved.sourceId;
            current.knownNickname = resolved.nickname;
            this.#notify();
          }
          if (arrival) this.#announceArrival(current);
        })
        .catch(() => {
          if (arrival) this.#announceArrival(next);
        });
    }
  }

  // A removed (unplugged) volume is dropped entirely rather than kept as an offline entry, so the
  // UI mirrors physical reality: unplug a card and it disappears at once. Known sources still live
  // in the database and simply render as offline once their live volume is gone.
  #remove(source: MountedSourceInfo): void {
    const key = this.#identityKey(source);
    if (this.#entries.delete(key)) this.#notify();
  }

  #announceArrival(source: RegisteredDetectedSource): void {
    for (const listener of this.#arrivalListeners) {
      try {
        listener(source);
      } catch {
        // An auto-ingest listener failure cannot block other observers or detection.
      }
    }
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // One window cannot prevent other source observers from receiving updates.
      }
    }
  }
}
